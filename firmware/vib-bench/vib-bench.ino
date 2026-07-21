/**
 * SAFEBOAT VIB — firmware de BANCADA v0.2 (primeiros testes do protótipo)
 *
 * Alvo:   ESP32-C3 SuperMini (USB CDC nativo) + acelerômetro ST via I²C
 * Fiação: SDA=GPIO8 · SCL=GPIO9 · (INT1=GPIO3 — ainda não usado)
 *
 * AUTODETECÇÃO do chip (a placa do protótipo veio vendida como "LIS3DH"
 * mas o silício é um LIS3DSH — WHO_AM_I 0x3F em 0x1D):
 *   LIS3DSH (0x1D/0x1E, id 0x3F): 16 bits · ODR 1600 Hz · FIFO 32  ← protótipo
 *   LIS3DH  (0x18/0x19, id 0x33): 12 bits · ODR 1344 Hz · FIFO 32
 *
 * Console serial de engenharia (115200, USB CDC):
 *   i  info (chip, endereço, config, escala)
 *   r  uma amostra (g)
 *   s  liga/desliga stream ~50 Hz em CSV — abra o Serial Plotter
 *   b  RAJADA 2048 amostras @ ODR máximo → stats por eixo (RMS-AC, pico,
 *      crista) + FFT 2048 c/ Hann → top-6 picos espectrais (Hz | mg) +
 *      RMS de VELOCIDADE 10–500 Hz em mm/s (o número da ISO 10816)
 *   g  alterna fundo de escala ±2/±4/±8/±16 g
 *   f  mede o ODR real (conta amostras por 2 s)
 *
 * É o pipeline da página (engine.js) portado p/ C — a rajada 'b' é o
 * embrião do ciclo de medição do produto.
 *
 * Compilar: arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc
 * Gravar:   arduino-cli upload -p COM3 --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc
 */
#include <Wire.h>

// ------------------------------------------------------------------ pinos
#define PIN_SDA 8
#define PIN_SCL 9

// ---------------------------------------------------- registradores comuns ST
#define REG_WHO_AM_I   0x0F
#define REG_OUT_X_L    0x28
#define REG_FIFO_SRC   0x2F
#define AUTO_INC       0x80   // só o LIS3DH usa o bit no subendereço

#define N_BURST 2048

enum Chip { NONE, LIS3DH, LIS3DSH };
Chip chip = NONE;
uint8_t lisAddr = 0;
float odrHz = 1600;
uint8_t fsIdx = 1;            // 0..3 → ±2/±4/±8/±16 g
// sensibilidade mg/dígito por escala:
const float SENS_3DSH[4] = { 0.06f, 0.12f, 0.24f, 0.73f };   // 16 bits
const float SENS_3DH[4]  = { 1.0f, 2.0f, 4.0f, 8.0f };       // 12 bits (>>4)
const uint8_t FS_3DSH[4] = { 0b000, 0b001, 0b011, 0b100 };   // CTRL5 FSCALE

bool streaming = false;
uint32_t tStream = 0;
// modo monitor: emite ciclos de medição em JSON (consumido por tools/live-server.cjs).
// Liga sozinho 4 s após o boot se nenhum comando chegar — a ponte serial só lê.
bool monitor = false;
bool cmdSeen = false;
uint32_t bootT = 0;

int16_t bx[N_BURST], by[N_BURST], bz[N_BURST];
float re[N_BURST], im[N_BURST];

float mgPerDig () { return chip == LIS3DSH ? SENS_3DSH[fsIdx] : SENS_3DH[fsIdx]; }

// ------------------------------------------------------------------ I²C
// Recuperação de barramento travado: se o escravo ficou no meio de uma
// transação (reset do ESP com I²C em curso), ele segura SDA em baixo e
// nada mais funciona (toda leitura vira 0xFF). Solução clássica: até 9
// pulsos de SCL p/ o escravo despejar o byte pendente + condição de STOP.
void busClear () {
  Wire.end();
  pinMode(PIN_SDA, INPUT_PULLUP);
  pinMode(PIN_SCL, INPUT_PULLUP);
  delayMicroseconds(10);
  if (digitalRead(PIN_SDA) == LOW) {
    pinMode(PIN_SCL, OUTPUT_OPEN_DRAIN);
    for (int i = 0; i < 9 && digitalRead(PIN_SDA) == LOW; i++) {
      digitalWrite(PIN_SCL, LOW); delayMicroseconds(6);
      digitalWrite(PIN_SCL, HIGH); delayMicroseconds(6);
    }
    // STOP: SDA sobe com SCL alto
    pinMode(PIN_SDA, OUTPUT_OPEN_DRAIN);
    digitalWrite(PIN_SDA, LOW); delayMicroseconds(6);
    digitalWrite(PIN_SCL, HIGH); delayMicroseconds(6);
    digitalWrite(PIN_SDA, HIGH); delayMicroseconds(6);
  }
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
}
// saúde do sensor: identidade E configuração. Se o módulo piscar a
// alimentação (jumper frouxo), o WHO_AM_I volta a responder mas os CTRL
// voltam ao padrão de fábrica (ODR desligado) — a FIFO nunca mais enche.
bool lisAlive () {
  uint8_t id = rd8(REG_WHO_AM_I);
  if (chip == LIS3DSH) return id == 0x3F && rd8(0x20) == 0x9F;
  return id == 0x33 && rd8(0x20) == 0x97;
}

uint8_t rd8 (uint8_t reg) {
  Wire.beginTransmission(lisAddr); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom(lisAddr, (uint8_t)1);
  return Wire.read();
}
void wr8 (uint8_t reg, uint8_t val) {
  Wire.beginTransmission(lisAddr); Wire.write(reg); Wire.write(val); Wire.endTransmission();
}
void rdSample (int16_t &x, int16_t &y, int16_t &z) {
  uint8_t sub = REG_OUT_X_L | (chip == LIS3DH ? AUTO_INC : 0);  // 3DSH: ADD_INC no CTRL6
  Wire.beginTransmission(lisAddr); Wire.write(sub); Wire.endTransmission(false);
  Wire.requestFrom(lisAddr, (uint8_t)6);
  uint8_t b[6]; for (int i = 0; i < 6; i++) b[i] = Wire.read();
  x = (int16_t)(b[0] | (b[1] << 8));
  y = (int16_t)(b[2] | (b[3] << 8));
  z = (int16_t)(b[4] | (b[5] << 8));
  if (chip == LIS3DH) { x >>= 4; y >>= 4; z >>= 4; }            // 12 bits HR
}

// ------------------------------------------------------------ init por chip
void applyScale () {
  if (chip == LIS3DSH) {
    wr8(0x24, (FS_3DSH[fsIdx] << 3));       // CTRL5: BW=800 Hz (00) + FSCALE
  } else {
    wr8(0x23, 0x88 | (fsIdx << 4));         // CTRL4: BDU + HR + FS
  }
}
bool lisInit () {
  struct { uint8_t addr; uint8_t id; Chip c; } probe[] = {
    { 0x18, 0x33, LIS3DH }, { 0x19, 0x33, LIS3DH },
    { 0x1D, 0x3F, LIS3DSH }, { 0x1E, 0x3F, LIS3DSH },
  };
  for (auto &p : probe) {
    Wire.beginTransmission(p.addr);
    if (Wire.endTransmission() != 0) continue;
    lisAddr = p.addr;
    if (rd8(REG_WHO_AM_I) == p.id) { chip = p.c; break; }
    lisAddr = 0;
  }
  if (chip == NONE) return false;

  if (chip == LIS3DSH) {
    odrHz = 1600;
    wr8(0x20, 0x9F);                        // CTRL4: ODR=1001 (1600 Hz) · BDU · XYZ
    applyScale();                           // CTRL5
    wr8(0x25, 0x50);                        // CTRL6: FIFO_EN + ADD_INC
    wr8(0x2E, 0x40);                        // FIFO stream mode
  } else {
    odrHz = 1344;
    wr8(0x20, 0x97);                        // CTRL1: ODR 1,344 kHz · XYZ
    applyScale();                           // CTRL4
    wr8(0x24, 0x40);                        // CTRL5: FIFO enable
    wr8(0x2E, 0x80);                        // FIFO stream mode
  }
  return true;
}
void fifoReset () {
  if (chip == LIS3DSH) { wr8(0x2E, 0x00); wr8(0x2E, 0x40); }
  else { wr8(0x2E, 0x00); wr8(0x2E, 0x80); }
}

void printInfo () {
  Serial.printf("\n== SAFEBOAT VIB · bancada v0.2 ==\n");
  Serial.printf("chip: %s em 0x%02X · WHO_AM_I=0x%02X · %s\n",
    chip == LIS3DSH ? "LIS3DSH" : "LIS3DH", lisAddr, rd8(REG_WHO_AM_I),
    chip == LIS3DSH ? "16 bits" : "12 bits (HR)");
  Serial.printf("ODR %.0f Hz · ±%d g · %.2f mg/digito · FIFO stream\n",
    odrHz, 2 << fsIdx, mgPerDig());
  Serial.printf("comandos: i info · r amostra · s stream · b rajada+FFT · g escala · f mede ODR\n\n");
}

// ------------------------------------------------------------------- FFT
void fft (int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { float t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (int len = 2; len <= n; len <<= 1) {
    float ang = -2.0f * PI / len;
    float wr = cosf(ang), wi = sinf(ang);
    for (int i = 0; i < n; i += len) {
      float cwr = 1, cwi = 0;
      for (int k = 0; k < len / 2; k++) {
        float ur = re[i + k], ui = im[i + k];
        float vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        float vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        float t = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = t;
      }
    }
  }
}

// ------------------------------------------------------------------ rajada
// retorna false em TIMEOUT (3× o tempo esperado): sensor parou de produzir
// (ex.: perdeu alimentação e voltou em power-down) — sem isso o loop trava
// p/ sempre esperando uma FIFO que nunca enche.
bool captureBurst (float &dt, bool &ovr) {
  fifoReset();
  int n = 0; ovr = false;
  uint32_t t0 = micros();
  const uint32_t limite = (uint32_t)(N_BURST / odrHz * 3e6f) + 500000;
  while (n < N_BURST) {
    if (micros() - t0 > limite) { dt = (micros() - t0) / 1e6f; return false; }
    uint8_t src = rd8(REG_FIFO_SRC);
    if (src & 0x40) ovr = true;
    int avail = src & 0x1F;
    while (avail-- && n < N_BURST) { rdSample(bx[n], by[n], bz[n]); n++; }
  }
  dt = (micros() - t0) / 1e6f;
  return true;
}

void burst () {
  const float mg = mgPerDig();
  Serial.printf("rajada: %d amostras @ %.0f Hz (%.2f s)...\n", N_BURST, odrHz, N_BURST / odrHz);
  float dt; bool ovr;
  if (!captureBurst(dt, ovr)) {
    Serial.println("TIMEOUT: sensor nao produziu dados — reconfigurando (confira os jumpers de VCC/GND)");
    busClear(); delay(20); lisInit();
    return;
  }
  Serial.printf("capturado em %.2f s · taxa efetiva %.0f Hz%s\n", dt, N_BURST / dt, ovr ? " · FIFO OVERRUN!" : "");

  int16_t *axes[3] = { bx, by, bz };
  const char axName[3] = { 'X', 'Y', 'Z' };
  int dom = 0; float domRms = 0;
  for (int a = 0; a < 3; a++) {
    float mean = 0;
    for (int i = 0; i < N_BURST; i++) mean += axes[a][i];
    mean /= N_BURST;
    float rms = 0, peak = 0;
    for (int i = 0; i < N_BURST; i++) {
      float d = axes[a][i] - mean;
      rms += d * d;
      if (fabsf(d) > peak) peak = fabsf(d);
    }
    rms = sqrtf(rms / N_BURST);
    Serial.printf("%c: media %+8.1f mg · RMS-AC %8.2f mg · pico %8.1f mg · crista %.1f\n",
      axName[a], mean * mg, rms * mg, peak * mg, rms > 0.01f ? peak / rms : 0);
    if (rms * mg > domRms) { domRms = rms * mg; dom = a; }
  }

  float mean = 0;
  for (int i = 0; i < N_BURST; i++) mean += axes[dom][i];
  mean /= N_BURST;
  for (int i = 0; i < N_BURST; i++) {
    float w = 0.5f - 0.5f * cosf(2.0f * PI * i / (N_BURST - 1));
    re[i] = (axes[dom][i] - mean) * mg * 0.001f * w;
    im[i] = 0;
  }
  fft(N_BURST);
  // resolucao pela taxa MEDIDA (o oscilador do ST varia alguns % do nominal;
  // com df nominal os picos sairiam ~4% deslocados — mataria a leitura de RPM)
  float df = 1.0f / dt;
  int nb = N_BURST / 2;
  for (int i = 0; i < nb; i++) re[i] = sqrtf(re[i] * re[i] + im[i] * im[i]) * 4.0f / N_BURST;
  Serial.printf("FFT eixo %c · resolucao %.2f Hz:\n", axName[dom], df);
  static bool used[N_BURST / 2];
  memset(used, 0, sizeof(used));
  for (int p = 0; p < 6; p++) {
    int best = -1; float bm = 0;
    for (int i = 3; i < nb - 1; i++) {
      if (used[i]) continue;
      if (re[i] > bm && re[i] >= re[i - 1] && re[i] >= re[i + 1]) { bm = re[i]; best = i; }
    }
    if (best < 0 || bm * 1000 < 0.3f) break;
    Serial.printf("  pico %d: %7.1f Hz · %7.2f mg\n", p + 1, best * df, bm * 1000);
    for (int i = best - 3; i <= best + 3; i++) if (i >= 0 && i < nb) used[i] = true;
  }
  float sumV2 = 0;
  for (int i = (int)ceilf(10 / df); i <= (int)floorf(500 / df); i++) {
    float v = re[i] * 9810.0f / (2.0f * PI * (i * df)) / 1.41421f;
    sumV2 += v * v;
  }
  Serial.printf("RMS de velocidade 10-500 Hz: %.2f mm/s  (ISO 10816: A<1.4 B<2.8 C<7.1 D>7.1)\n\n", sqrtf(sumV2));
}

// ------------------------------------------- ciclo do modo monitor (JSON)
// v0.4: o ESP só ADQUIRE — despeja a rajada BRUTA (3 eixos × 2048 int16)
// numa linha JSON e a FFT/análise roda no PC (tools/live-server.cjs), com
// resolução cheia nos 3 eixos. ~40 kB/linha: trivial p/ o USB CDC nativo.
void monitorCycle () {
  if (!lisAlive()) {
    Serial.println("{\"vib\":0,\"err\":\"sensor fora do barramento — recuperando\"}");
    busClear();
    delay(20);
    if (!lisInit()) { delay(1000); return; }
    Serial.println("{\"vib\":0,\"err\":\"sensor recuperado\"}");
  }
  float dt; bool ovr;
  if (!captureBurst(dt, ovr)) {
    Serial.println("{\"vib\":0,\"err\":\"captura sem dados (sensor reiniciou?) — reconfigurando\"}");
    busClear(); delay(20); lisInit();
    return;
  }
  if (N_BURST / dt > odrHz * 1.5f) {
    Serial.println("{\"vib\":0,\"err\":\"leituras invalidas — reconfigurando\"}");
    busClear(); delay(20); lisInit();
    return;
  }
  Serial.printf("{\"raw\":1,\"fs\":%.1f,\"ovr\":%d,\"scale\":%d,\"sens\":%.4f",
    N_BURST / dt, ovr ? 1 : 0, 2 << fsIdx, mgPerDig());
  const char *k[3] = { ",\"x\":[", ",\"y\":[", ",\"z\":[" };
  int16_t *axes[3] = { bx, by, bz };
  for (int a = 0; a < 3; a++) {
    Serial.print(k[a]);
    for (int i = 0; i < N_BURST; i++) Serial.printf(i ? ",%d" : "%d", axes[a][i]);
    Serial.print("]");
  }
  Serial.println("}");
}

// ------------------------- versão antiga (FFT no ESP), mantida p/ referência
void monitorCycleOnDevice () {
  // watchdog do sensor: se o barramento morreu (fio mexido, reset no meio
  // de transação), destrava e re-inicializa em vez de emitir lixo 0xFF
  if (!lisAlive()) {
    Serial.println("{\"vib\":0,\"err\":\"sensor fora do barramento — recuperando\"}");
    busClear();
    delay(20);
    if (!lisInit()) { delay(1000); return; }
    Serial.println("{\"vib\":0,\"err\":\"sensor recuperado\"}");
  }
  const float mg = mgPerDig();
  float dt; bool ovr;
  if (!captureBurst(dt, ovr)) {
    Serial.println("{\"vib\":0,\"err\":\"captura sem dados (sensor reiniciou?) — reconfigurando\"}");
    busClear(); delay(20); lisInit();
    return;
  }
  // captura implausível (taxa >1,5× nominal) = leituras 0xFF: reconfigura
  if (N_BURST / dt > odrHz * 1.5f) {
    Serial.println("{\"vib\":0,\"err\":\"leituras invalidas — reconfigurando\"}");
    busClear(); delay(20); lisInit();
    return;
  }

  int16_t *axes[3] = { bx, by, bz };
  float mean[3], rms[3], peak[3];
  int dom = 0;
  for (int a = 0; a < 3; a++) {
    float m = 0;
    for (int i = 0; i < N_BURST; i++) m += axes[a][i];
    m /= N_BURST;
    float r = 0, p = 0;
    for (int i = 0; i < N_BURST; i++) {
      float d = axes[a][i] - m;
      r += d * d;
      if (fabsf(d) > p) p = fabsf(d);
    }
    mean[a] = m * mg; rms[a] = sqrtf(r / N_BURST) * mg; peak[a] = p * mg;
    if (rms[a] > rms[dom]) dom = a;
  }

  for (int i = 0; i < N_BURST; i++) {
    float w = 0.5f - 0.5f * cosf(2.0f * PI * i / (N_BURST - 1));
    re[i] = (axes[dom][i] - mean[dom] / mg) * mg * 0.001f * w;
    im[i] = 0;
  }
  fft(N_BURST);
  float df = 1.0f / dt;
  int nb = N_BURST / 2;
  for (int i = 0; i < nb; i++) re[i] = sqrtf(re[i] * re[i] + im[i] * im[i]) * 4.0f / N_BURST;
  float sumV2 = 0;
  for (int i = (int)ceilf(10 / df); i <= (int)floorf(500 / df); i++) {
    float v = re[i] * 9810.0f / (2.0f * PI * (i * df)) / 1.41421f;
    sumV2 += v * v;
  }

  Serial.printf("{\"vib\":1,\"fs\":%.1f,\"ovr\":%d,\"scale\":%d,\"dom\":%d,\"viso\":%.3f",
    N_BURST / dt, ovr ? 1 : 0, 2 << fsIdx, dom, sqrtf(sumV2));
  Serial.printf(",\"mean\":[%.1f,%.1f,%.1f],\"rms\":[%.2f,%.2f,%.2f],\"peak\":[%.1f,%.1f,%.1f]",
    mean[0], mean[1], mean[2], rms[0], rms[1], rms[2], peak[0], peak[1], peak[2]);
  Serial.print(",\"fft\":[");                 // 256 bins, mg, máx de cada 4
  for (int i = 0; i < 256; i++) {
    float m = 0;
    for (int k = i * 4; k < i * 4 + 4 && k < nb; k++) if (re[k] > m) m = re[k];
    Serial.printf(i ? ",%.2f" : "%.2f", m * 1000);
  }
  Serial.print("],\"wave\":[");               // 256 pts do eixo dominante, mg AC
  for (int i = 0; i < 256; i++) {
    float v = (axes[dom][i * 8] - mean[dom] / mg) * mg;
    Serial.printf(i ? ",%.1f" : "%.1f", v);
  }
  Serial.println("]}");
}

// ------------------------------------------------------------------ setup
void setup () {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 4000) delay(10);
  busClear();                                // destrava o barramento se preciso
  delay(50);
  if (!lisInit()) {
    Serial.println("ERRO: nenhum acelerometro suportado. Confira SDA=8 SCL=9 VCC=3V3 GND.");
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() != 0) continue;
      lisAddr = a;
      uint8_t r00 = rd8(0x00), r0D = rd8(0x0D), r0F = rd8(0x0F);
      Serial.printf("0x%02X vivo: reg00=0x%02X reg0D=0x%02X reg0F=0x%02X\n", a, r00, r0D, r0F);
    }
    lisAddr = 0;
    return;
  }
  printInfo();
  bootT = millis();
}

// ------------------------------------------------------------------- loop
void loop () {
  if (chip == NONE) {                        // sem sensor: tenta de novo a cada 2 s
    static uint32_t tRetry = 0;              // (reencaixou o jumper → volta sozinho)
    if (millis() - tRetry > 2000) {
      tRetry = millis();
      busClear(); delay(10);
      if (lisInit()) {
        Serial.println("sensor conectado!");
        printInfo();
        bootT = millis(); cmdSeen = false;
      } else {
        Serial.println("{\"vib\":0,\"err\":\"sensor desconectado — confira os jumpers (VCC 3V3, GND, SDA=8, SCL=9)\"}");
      }
    }
    return;
  }
  if (!cmdSeen && !monitor && millis() - bootT > 4000) {
    monitor = true;                          // bancada: liga sozinho p/ o live-server
    Serial.println("modo monitor automatico (qualquer comando desliga; 'm' religa)");
  }
  if (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') return;
    cmdSeen = true;
    if (monitor && c != 'm') monitor = false;
    switch (c) {
      case 'm': monitor = !monitor;
        Serial.printf("monitor: %s\n", monitor ? "ON" : "OFF"); break;
      case 'i': printInfo(); break;
      case 'r': { int16_t x, y, z; rdSample(x, y, z);
        Serial.printf("X %+.3f g · Y %+.3f g · Z %+.3f g\n",
          x * mgPerDig() * 0.001f, y * mgPerDig() * 0.001f, z * mgPerDig() * 0.001f); } break;
      case 's': streaming = !streaming;
        if (streaming) Serial.println("x_mg,y_mg,z_mg");
        break;
      case 'b': streaming = false; burst(); break;
      case 'g': fsIdx = (fsIdx + 1) & 3;
        applyScale();
        Serial.printf("fundo de escala: +-%d g (%.2f mg/dig)\n", 2 << fsIdx, mgPerDig()); break;
      case 'f': {
        fifoReset();
        uint32_t t0 = millis(); uint32_t cnt = 0;
        while (millis() - t0 < 2000) {
          int avail = rd8(REG_FIFO_SRC) & 0x1F;
          while (avail--) { int16_t x, y, z; rdSample(x, y, z); cnt++; }
        }
        Serial.printf("ODR real: %.1f Hz (nominal %.0f)\n", cnt / 2.0f, odrHz); } break;
    }
  }
  if (monitor) { monitorCycle(); return; }
  if (streaming && millis() - tStream >= 20) {
    tStream = millis();
    int16_t x, y, z; rdSample(x, y, z);
    Serial.printf("%.1f,%.1f,%.1f\n", x * mgPerDig(), y * mgPerDig(), z * mgPerDig());
  }
}
