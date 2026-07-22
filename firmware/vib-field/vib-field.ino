/**
 * SAFEBOAT VIB — firmware de CAMPO v1.0 ("dorme com o motor")
 * ESP32-C3 SuperMini + LIS3DSH · SDA=8 SCL=9 (pull-ups 2,2 kΩ soldados)
 *
 * Ciclo de vida:
 *   DEEP SLEEP ──(timer a cada SNIFF_PERIOD_S, ou INT1 se ligado no GPIO3)──►
 *   FAREJA (~0,4 s: 512 amostras, banda 20–45 Hz) ──motor OFF──► dorme de novo
 *        └─motor ON──► MISSÃO: Wi-Fi + captura SEM BURACOS (tarefa dedicada
 *          drena a FIFO em ping-pong de 4 buffers enquanto o rádio transmite)
 *          ──60 s sem motor──► aviso "hibernando" ──► DEEP SLEEP
 *
 * Detector de motor CALIBRADO NO TESTE DE MAR (AMARRADONA, 22/07/2026):
 *   · desligado: piso ~62 mg espalhado, quase nada em 20–45 Hz
 *   · lenta 600 rpm: raia de queima 3× em ~30 Hz — 105 mg no motor BOM
 *   → ON: pico 20–45 Hz ≥ 25 mg (fator 3 sobre o piso, metade do pior caso)
 *   → OFF: 60 s consecutivos abaixo (não hiberna em queda momentânea de rpm)
 *
 * Transmissão: POST /ingest no hub (mesmo JSON {"raw":...} da bancada — o
 * live-server/dashboard atuais já entendem). Wi-Fi caiu? Os buffers seguram
 * ~5 s e a captura NÃO para; estouro é contado e reportado (perda declarada,
 * nunca silenciosa). Timestamps são do hub (casam com o RPM do NMEA lá).
 *
 * Energia (nota honesta): com timer de 20 s o farejo custa ~0,5 mA médio —
 * ok para o VIB-S alimentado em 12 V (recomendado na reversora). Para a
 * versão a moeda, ligar o INT1 do LIS3DSH no GPIO3 (wake por hardware,
 * USE_INT1=1) e alongar SNIFF_PERIOD_S.
 */
#include <Wire.h>
#include <WiFi.h>
#include "driver/gpio.h"

// ============================= CONFIGURAÇÃO =============================
#define WIFI_SSID       "SAFEBOAT"          // rede da embarcação
#define WIFI_PASS       "MUDE-AQUI"
#define HUB_HOST        "192.168.0.100"     // hub SAFEBOAT (live-server)
#define HUB_PORT        8102
#define DEVICE_ID       "vib-bb-01"

#define SNIFF_PERIOD_S  20      // intervalo do farejo em deep sleep
#define USE_INT1        0       // 1 = INT1 do LIS3DSH ligado no GPIO3 (wake hw)
#define ENGINE_ON_MG    25.0f   // pico 20–45 Hz p/ declarar motor ligado
#define ENGINE_OFF_S    60      // segundos abaixo do limiar p/ hibernar
#define WIFI_TIMEOUT_MS 15000

// ============================== HARDWARE ================================
#define PIN_SDA 8
#define PIN_SCL 9
#define PIN_INT1 3
#define REG_WHO 0x0F
#define REG_OUT 0x28
#define FS_HZ   1600.0f

uint8_t lisAddr = 0x1D;

uint8_t rd8 (uint8_t r) {
  Wire.beginTransmission(lisAddr); Wire.write(r); Wire.endTransmission(false);
  Wire.requestFrom(lisAddr, (uint8_t)1);
  return Wire.read();
}
void wr8 (uint8_t r, uint8_t v) {
  Wire.beginTransmission(lisAddr); Wire.write(r); Wire.write(v); Wire.endTransmission();
}
void rdSample (int16_t &x, int16_t &y, int16_t &z) {
  Wire.beginTransmission(lisAddr); Wire.write(REG_OUT); Wire.endTransmission(false);
  Wire.requestFrom(lisAddr, (uint8_t)6);
  uint8_t b[6]; for (int i = 0; i < 6; i++) b[i] = Wire.read();
  x = (int16_t)(b[0] | (b[1] << 8)); y = (int16_t)(b[2] | (b[3] << 8)); z = (int16_t)(b[4] | (b[5] << 8));
}
float sens = 0.06f;              // mg/díg em ±2 g (16 bits)

bool lisInit (bool full) {
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
  for (uint8_t a : { 0x1D, 0x1E }) {
    lisAddr = a;
    if (rd8(REG_WHO) == 0x3F) {
      wr8(0x20, 0x97);           // CTRL4: ODR 1600 Hz, XYZ
      wr8(0x23, 0x00);           // CTRL3
      wr8(0x24, 0x00);           // CTRL5: ±2 g (lenta é sinal pequeno; auto-range fica p/ v1.1)
      wr8(0x25, 0x10);           // CTRL6: ADD_INC
      wr8(0x2E, 0x00); wr8(0x2E, 0x40);  // FIFO stream
      delay(full ? 60 : 20);     // estabiliza o filtro
      return true;
    }
  }
  return false;
}

// ======================= DETECTOR DE MOTOR (Goertzel) ====================
// pico da banda 20–45 Hz num bloco de N amostras (eixo mais energético)
float bandPeakMg (int16_t *bx, int16_t *by, int16_t *bz, int n) {
  int16_t *ax[3] = { bx, by, bz };
  int dom = 0; float best = -1;
  for (int a = 0; a < 3; a++) {
    float m = 0; for (int i = 0; i < n; i++) m += ax[a][i];
    m /= n;
    float e = 0; for (int i = 0; i < n; i++) { float d = ax[a][i] - m; e += d * d; }
    if (e > best) { best = e; dom = a; }
  }
  float m = 0; for (int i = 0; i < n; i++) m += ax[dom][i];
  m /= n;
  float peak = 0;
  for (float f = 20; f <= 45; f += 2.5f) {   // pente de Goertzel na banda da queima
    float w = 2 * PI * f / FS_HZ, cw = 2 * cosf(w);
    float s0, s1 = 0, s2 = 0;
    for (int i = 0; i < n; i++) {
      s0 = (ax[dom][i] - m) + cw * s1 - s2;
      s2 = s1; s1 = s0;
    }
    float amp = 2 * sqrtf(fmaxf(0, s1 * s1 + s2 * s2 - cw * s1 * s2)) / n;
    if (amp > peak) peak = amp;
  }
  return peak * sens;              // mg
}

// farejo rápido: 512 amostras (~0,32 s) direto do FIFO
int16_t sx[512], sy[512], sz[512];
bool sniffEngineOn () {
  int n = 0;
  uint32_t t0 = millis();
  while (n < 512 && millis() - t0 < 800) {
    int avail = rd8(0x2F) & 0x1F;
    while (avail-- && n < 512) { rdSample(sx[n], sy[n], sz[n]); n++; }
  }
  if (n < 400) return false;       // leitura ruim = não acorda à toa
  return bandPeakMg(sx, sy, sz, n) >= ENGINE_ON_MG;
}

// ============================ DEEP SLEEP ================================
RTC_DATA_ATTR uint32_t nWakes = 0;
void goToSleep () {
  wr8(0x20, 0x00);                 // LIS em power-down (~2 µA)
#if USE_INT1
  esp_deep_sleep_enable_gpio_wakeup(BIT(PIN_INT1), ESP_GPIO_WAKEUP_GPIO_HIGH);
#endif
  esp_sleep_enable_timer_wakeup((uint64_t)SNIFF_PERIOD_S * 1000000ULL);
  esp_deep_sleep_start();
}

// ==================== MISSÃO: captura sem buracos ========================
#define NB      2048
#define NBUF    4                  // 4 buffers ≈ 5 s de fôlego sem rádio
typedef struct { int16_t x[NB], y[NB], z[NB]; float dt; uint8_t ovr; } Burst;
bool sendBurst (Burst *b);       // protótipo explícito (o auto-prototype do
                                 // Arduino nasce antes do typedef e quebraria)
Burst bufs[NBUF];
QueueHandle_t qFull, qFree;
volatile uint32_t seq = 0, perdidos = 0;

void captureTask (void *arg) {
  int idx; float peakHold = 999;
  for (;;) {
    if (xQueueReceive(qFree, &idx, 0) != pdTRUE) {
      // sem buffer livre: rádio atrasou demais — descarta o mais velho
      if (xQueueReceive(qFull, &idx, 0) == pdTRUE) perdidos++;
      else { vTaskDelay(1); continue; }
    }
    Burst *b = &bufs[idx];
    int n = 0; b->ovr = 0;
    uint32_t t0 = micros();
    while (n < NB) {
      uint8_t src = rd8(0x2F);
      if (src & 0x40) b->ovr = 1;
      int avail = src & 0x1F;
      while (avail-- && n < NB) { rdSample(b->x[n], b->y[n], b->z[n]); n++; }
      if (!avail) vTaskDelay(1);   // cede CPU p/ o Wi-Fi (FIFO segura 20 ms)
    }
    b->dt = (micros() - t0) / 1e6f;
    xQueueSend(qFull, &idx, portMAX_DELAY);
  }
}

bool wifiUp () {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

// POST chunked: imprime os ints direto no socket — sem 40 kB de String
bool sendBurst (Burst *b) {
  WiFiClient c;
  if (!c.connect(HUB_HOST, HUB_PORT)) return false;
  c.printf("POST /ingest HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\n"
           "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n", HUB_HOST);
  char head[240];
  int hl = snprintf(head, sizeof(head),
    "{\"raw\":1,\"dev\":\"%s\",\"seq\":%u,\"lost\":%u,\"fs\":%.1f,\"ovr\":%d,\"scale\":2,\"sens\":%.4f,\"clip\":0,\"bus\":400",
    DEVICE_ID, (unsigned)seq, (unsigned)perdidos, NB / b->dt, b->ovr, sens);
  c.printf("%x\r\n", hl); c.write((uint8_t *)head, hl); c.print("\r\n");
  const char *k[3] = { ",\"x\":[", ",\"y\":[", ",\"z\":[" };
  int16_t *ax[3] = { b->x, b->y, b->z };
  char part[3200];
  for (int a = 0; a < 3; a++) {
    int p = snprintf(part, sizeof(part), "%s", k[a]);
    for (int i = 0; i < NB; i++) {
      p += snprintf(part + p, sizeof(part) - p, i ? ",%d" : "%d", ax[a][i]);
      if (p > (int)sizeof(part) - 16) {
        c.printf("%x\r\n", p); c.write((uint8_t *)part, p); c.print("\r\n");
        p = 0;
      }
    }
    p += snprintf(part + p, sizeof(part) - p, "]");
    c.printf("%x\r\n", p); c.write((uint8_t *)part, p); c.print("\r\n");
  }
  c.print("1\r\n}\r\n0\r\n\r\n");
  uint32_t t0 = millis();               // espera o 200 (rápido no hub local)
  while (!c.available() && millis() - t0 < 3000) delay(5);
  bool ok = c.available() && c.readStringUntil('\n').indexOf("200") > 0;
  c.stop();
  return ok;
}

// ================================ MAIN ==================================
void setup () {
  nWakes++;
  if (!lisInit(false)) goToSleep();          // sem sensor: dorme e tenta depois

  if (!sniffEngineOn()) goToSleep();         // motor desligado: volta a dormir

  // ---- MOTOR LIGADO: missão ----
  lisInit(true);
  qFull = xQueueCreate(NBUF, sizeof(int));
  qFree = xQueueCreate(NBUF, sizeof(int));
  for (int i = 0; i < NBUF; i++) xQueueSend(qFree, &i, 0);
  xTaskCreate(captureTask, "cap", 4096, NULL, 3, NULL);  // prio > loop: FIFO nunca espera

  wifiUp();                                  // tenta já; buffers seguram o começo

  uint32_t offSince = 0;
  for (;;) {
    int idx;
    if (xQueueReceive(qFull, &idx, pdMS_TO_TICKS(2000)) != pdTRUE) continue;
    Burst *b = &bufs[idx];

    // motor ainda ligado? (mesmo detector, no dado que já temos)
    float pk = bandPeakMg(b->x, b->y, b->z, NB);
    if (pk < ENGINE_ON_MG) {
      if (!offSince) offSince = millis();
    } else offSince = 0;

    if (wifiUp() && sendBurst(b)) seq++;
    else perdidos++;                          // declarado no próximo envio
    xQueueSend(qFree, &idx, 0);

    if (offSince && millis() - offSince > ENGINE_OFF_S * 1000UL) {
      // despedida: avisa o hub e hiberna
      WiFiClient c;
      if (c.connect(HUB_HOST, HUB_PORT)) {
        char bye[160];
        int l = snprintf(bye, sizeof(bye),
          "{\"vib\":0,\"dev\":\"%s\",\"err\":\"motor desligado — hibernando (%u rajadas, %u perdidas)\"}",
          DEVICE_ID, (unsigned)seq, (unsigned)perdidos);
        c.printf("POST /ingest HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", HUB_HOST, l, bye);
        delay(150); c.stop();
      }
      WiFi.disconnect(true);
      goToSleep();
    }
  }
}
void loop () {}
