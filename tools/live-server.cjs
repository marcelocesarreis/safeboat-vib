/**
 * SAFEBOAT VIB — servidor do MONITOR DE BANCADA AO VIVO (porta 8102)
 *
 * Ponte COM3 → navegador: spawna um PowerShell que lê a serial do protótipo
 * (o firmware v0.3 entra em modo monitor sozinho e emite 1 linha JSON por
 * ciclo de medição) e retransmite via SSE para tools/live.html.
 *
 * A ponte é SÓ leitura — abrir a porta (DTR) já reseta a placa, que 4 s
 * depois começa a transmitir. Se o Node morrer, o Write da ponte quebra o
 * pipe e o PowerShell sai sozinho (não deixa a COM3 presa).
 *
 * Rodar: node tools/live-server.cjs   →   http://localhost:8102
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PORT = 8102
const COM = process.env.VIB_COM || 'COM3'

let clients = []
let last = null          // último ciclo (novos clientes recebem na hora)
let status = 'abrindo ' + COM + '…'

// ------------------------------------------------- análise no PC (v0.4)
// O firmware manda a rajada BRUTA (3 eixos × 2048 int16); aqui roda a FFT
// de resolução cheia (mesmo pipeline do engine.js da página do produto).
function fftMag (vals) {
  const n = vals.length
  const re = new Float64Array(n), im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = vals[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)))
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const t = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = t
      }
    }
  }
  const mag = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * 4 / n
  return mag
}

function median (arr) {
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ================== DECOMPOSIÇÃO DINÂMICA (o modelo do produto) ==========
// O acelerômetro num barco navegando mede TUDO somado: gravidade girando
// (atitude), aceleração de manobra, pancadas de mar e a vibração da máquina.
// Separação por assinatura física:
//   gravidade  → passa-baixa 0,4 Hz por eixo (vetor g rastreado)
//   movimento  → banda 0,4–8 Hz do resíduo (navegação/manobra/mão)
//   impactos   → transientes: sub-blocos com RMS ≫ mediana dos vizinhos
//   máquina    → >8 Hz, espectro por MEDIANA DE WELCH (8 janelas de 512):
//                a pancada contamina 1–2 janelas, a mediana as ignora;
//                as raias do motor (1×, 2×…) estão em todas e sobrevivem.
const machSt = { on: false, hits: 0, miss: 0 }   // estado MÁQUINA com histerese

function processRaw (d) {
  const N = d.x.length
  const fs = d.fs
  const toG = d.sens * 0.001                 // dígito → g
  const axes = [d.x, d.y, d.z]

  // ---- gravidade por eixo (LP 0,4 Hz, inicializado na média) + resíduo ----
  const aG = 1 - Math.exp(-2 * Math.PI * 0.4 / fs)
  const grav = [], dyn = [], rmsDyn = []
  for (let a = 0; a < 3; a++) {
    let m = 0
    for (const v of axes[a]) m += v
    m /= N
    let g = m
    const dd = new Float64Array(N)
    for (let i = 0; i < N; i++) { g += aG * (axes[a][i] - g); dd[i] = (axes[a][i] - g) * toG }
    grav.push(m * toG)
    let r = 0
    for (const v of dd) r += v * v
    rmsDyn.push(Math.sqrt(r / N))
    dyn.push(dd)
  }
  const dom = rmsDyn.indexOf(Math.max(...rmsDyn))
  const gmag = Math.hypot(grav[0], grav[1], grav[2])
  const tilt = Math.acos(Math.min(1, Math.abs(grav[2]) / (gmag || 1))) * 180 / Math.PI

  // ---- movimento (0,4–8 Hz) × máquina (>8 Hz), 2 polos ----
  const s = dyn[dom]
  const aM = 1 - Math.exp(-2 * Math.PI * 8 / fs)
  let l1 = 0, l2 = 0
  const mot = new Float64Array(N), mach = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    l1 += aM * (s[i] - l1); l2 += aM * (l1 - l2)
    mot[i] = l2; mach[i] = s[i] - l2
  }
  let motR = 0, motP = 0
  for (const v of mot) { motR += v * v; if (Math.abs(v) > motP) motP = Math.abs(v) }
  motR = Math.sqrt(motR / N)

  // ---- impactos: 16 sub-blocos de 128; transiente = RMS ≫ mediana ----
  const NB = 16, BL = Math.floor(N / NB)
  const bRms = [], bPeak = []
  for (let b = 0; b < NB; b++) {
    let r = 0, p = 0
    for (let i = b * BL; i < (b + 1) * BL; i++) { r += mach[i] * mach[i]; if (Math.abs(mach[i]) > p) p = Math.abs(mach[i]) }
    bRms.push(Math.sqrt(r / BL)); bPeak.push(p)
  }
  const medR = median(bRms) || 1e-9
  const impactMask = bRms.map((r, b) => (r > 3 * medR && bPeak[b] > 5 * medR) ? 1 : 0)
  const nImp = impactMask.reduce((a, v) => a + v, 0)
  let impPeak = 0
  impactMask.forEach((f, b) => { if (f && bPeak[b] > impPeak) impPeak = bPeak[b] })

  // ---- espectro da máquina: mediana de Welch (janelas 512, hop 256),
  //      EXCLUINDO janelas que contêm impacto (se sobrarem ≥3 limpas) ----
  const W = 512, HOP = 256
  const wins = [], winClean = []
  for (let k = 0; k + W <= N; k += HOP) {
    const b0 = Math.floor(k / BL), b1 = Math.min(NB - 1, Math.floor((k + W - 1) / BL))
    let clean = true
    for (let b = b0; b <= b1; b++) if (impactMask[b]) clean = false
    wins.push(fftMag(mach.slice(k, k + W)))
    winClean.push(clean)
  }
  const useWins = winClean.filter(Boolean).length >= 3
    ? wins.filter((_, k) => winClean[k]) : wins
  const medSpec = new Float64Array(W / 2)
  const col = new Float64Array(useWins.length)
  for (let i = 0; i < W / 2; i++) {
    for (let k = 0; k < useWins.length; k++) col[k] = useWins[k][i]
    medSpec[i] = median(col)
  }
  const df = fs / W
  let sumV2 = 0
  for (let i = Math.ceil(10 / df); i <= Math.min(W / 2 - 1, Math.floor(500 / df)); i++) {
    const v = medSpec[i] * 9810 / (2 * Math.PI * i * df) / Math.SQRT2
    sumV2 += v * v
  }
  sumV2 /= 1.5     // ENBW da janela Hann: integrar bins de espectro calibrado
                   // em amplitude sobreconta a potência em 1,5×
  const quality = 1 - nImp / NB              // fração de blocos limpos

  // ---- detecção "MÁQUINA LIGADA": raia dominante proeminente sobre o piso ----
  // Máquina girando = raia estreita muito acima do piso espectral (ruído/
  // ambiente é largo e baixo). Proeminência = pico / mediana do espectro.
  const i0 = Math.ceil(10 / df)
  let pkI = i0
  for (let i = i0; i < W / 2; i++) if (medSpec[i] > medSpec[pkI]) pkI = i
  const floorSpec = median(medSpec.slice(i0)) || 1e-9
  const pkMg = medSpec[pkI] * 1000
  const prom = medSpec[pkI] / floorSpec
  const detected = (pkMg > 4 && prom > 8) || pkMg > 15

  // ---- saídas p/ o painel ----
  const fft = []
  for (let i = 0; i < W / 2; i++) fft.push(+(medSpec[i] * 1000).toFixed(2))
  const step = Math.floor(N / 512)
  const wave = [], waveMach = []
  for (let i = 0; i < 512; i++) {
    wave.push(+(s[i * step] * 1000).toFixed(1))
    waveMach.push(+(mach[i * step] * 1000).toFixed(1))
  }
  const mean = grav.map(v => +(v * 1000).toFixed(1))
  const rms = rmsDyn.map(v => +(v * 1000).toFixed(2))
  // histerese entre ciclos: liga com 2 detecções seguidas, desliga com 3 faltas
  if (detected) { machSt.hits = Math.min(9, machSt.hits + 1); machSt.miss = 0 }
  else { machSt.miss = Math.min(9, machSt.miss + 1); machSt.hits = 0 }
  if (!machSt.on && machSt.hits >= 2) machSt.on = true
  if (machSt.on && machSt.miss >= 3) machSt.on = false

  return {
    vib: 1, fftpc: 1, decomp: 1, fs: d.fs, ovr: d.ovr, scale: d.scale, clip: d.clip || 0, bus: d.bus || 400, dom,
    machine: { on: machSt.on, f: +(pkI * df).toFixed(1), rpm: Math.round(pkI * df * 60), amp: +pkMg.toFixed(1), prom: +prom.toFixed(1) },
    viso: +Math.sqrt(sumV2).toFixed(3), res: +df.toFixed(2), quality: +quality.toFixed(2),
    gmag: +gmag.toFixed(3), tilt: +tilt.toFixed(1),
    motion: { rms: +(motR * 1000).toFixed(1), peak: +(motP * 1000).toFixed(0) },
    impacts: { n: nImp, peak: +impPeak.toFixed(2) },
    mean, rms, peak: bPeak.map(v => +(v * 1000).toFixed(0)),
    impactMask, fft, wave, waveMach,
  }
}

function broadcast (obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`
  clients = clients.filter(c => { try { c.write(msg); return true } catch { return false } })
}

// ------------------------- GRAVADOR DE PADRÕES (teste de mar) -------------
// Grava N ciclos consecutivos (bruto + métricas) rotulados com o padrão
// operacional e o modelo do motor. Arquivos em data/padroes/<motor>/ —
// nunca sobrescreve: cada gravação ganha carimbo de hora.
const REC_DIR = path.join(__dirname, '..', 'data', 'padroes')
const PATTERNS = {
  'desligado': 'Motor desligado',
  'neutro-800': 'Lenta 800 rpm (neutro)',
  'neutro-1200': '1200 rpm (neutro)',
  'neutro-max': 'RPM máximo (neutro)',
  'engatado-900': 'Engatado 900 rpm',
  'engatado-1200': 'Engatado 1200 rpm',
  'engatado-2000': 'Engatado 2000 rpm',
  'engatado-max': 'Engatado máximo',
}
const REC_N = 12                 // ciclos por padrão (~18 s de dados)
let rec = { active: false, pattern: null, engine: '', got: 0, cycles: [] , startedAt: 0 }

function slugify (s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'motor'
}
function stamp () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function recStatus () {
  return { rec: { active: rec.active, pattern: rec.pattern, got: rec.got, target: REC_N, engine: rec.engine } }
}
function saveRec () {
  const dir = path.join(REC_DIR, slugify(rec.engine))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${rec.pattern}_${stamp()}.json`)
  fs.writeFileSync(file, JSON.stringify({
    engine: rec.engine, pattern: rec.pattern, label: PATTERNS[rec.pattern],
    startedAt: rec.startedAt, savedAt: Date.now(), n: rec.cycles.length, cycles: rec.cycles,
  }))
  console.log(`padrão salvo: ${file} (${rec.cycles.length} ciclos)`)
  broadcast({ recDone: { pattern: rec.pattern, file: path.basename(file), n: rec.cycles.length } })
}
function recFeed (raw, processed) {
  if (!rec.active) return
  rec.cycles.push({
    t: Date.now(),
    raw: { fs: raw.fs, ovr: raw.ovr, scale: raw.scale, sens: raw.sens, clip: raw.clip || 0, bus: raw.bus || 400, x: raw.x, y: raw.y, z: raw.z },
    metrics: {
      viso: processed.viso, quality: processed.quality, gmag: processed.gmag, tilt: processed.tilt,
      dom: processed.dom, motion: processed.motion, impacts: processed.impacts, machine: processed.machine,
    },
  })
  rec.got = rec.cycles.length
  if (rec.got >= REC_N) { saveRec(); rec.active = false }
  broadcast(recStatus())
}
function recList (engine) {
  const dir = path.join(REC_DIR, slugify(engine))
  const out = {}
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)_(\d{8}-\d{6})\.json$/)
      if (!m || !PATTERNS[m[1]]) continue
      if (!out[m[1]]) out[m[1]] = { count: 0, last: '' }
      out[m[1]].count++
      if (m[2] > out[m[1]].last) out[m[1]].last = m[2]
    }
  }
  return out
}

// ---------------------------------------------------------- ponte serial
function startBridge () {
  const ps = `
$ErrorActionPreference='Stop'
try {
  $p = New-Object System.IO.Ports.SerialPort '${COM}',115200,'None',8,'One'
  $p.DtrEnable = $true
  $p.ReadBufferSize = 1048576
  $p.Open()
  [Console]::Out.WriteLine('__PORTA_OK__')
  while ($true) {
    $d = $p.ReadExisting()
    if ($d.Length) { [Console]::Out.Write($d); [Console]::Out.Flush() }
    Start-Sleep -Milliseconds 10
  }
} catch { [Console]::Out.WriteLine('__PORTA_ERRO__ ' + $_.Exception.Message); exit 1 }
`
  const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })
  let buf = ''
  child.stdout.on('data', d => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line.startsWith('__PORTA_OK__')) { status = 'conectado em ' + COM; broadcast({ status }) }
      else if (line.startsWith('__PORTA_ERRO__')) { status = 'erro: ' + line.slice(15); broadcast({ status }) }
      else if (line.startsWith('{"raw"')) {
        try {
          const raw = JSON.parse(line)
          last = processRaw(raw)          // FFT + análise no PC
          last.status = status
          broadcast(last)
          recFeed(raw, last)              // gravador de padrões (se ativo)
        } catch {}
      } else if (line.startsWith('{"vib"')) {
        try { last = JSON.parse(line); last.status = status; broadcast(last) } catch {}
      } else if (line.trim()) {
        broadcast({ log: line })
      }
    }
  })
  child.on('exit', code => {
    status = `ponte serial caiu (código ${code}) — tentando de novo em 3 s`
    broadcast({ status })
    setTimeout(startBridge, 3000)
  })
  process.on('exit', () => { try { child.kill() } catch {} })
}
// ------------------------- modo simulação (VIB_SIM=1): embarcação sintética
// Gera ciclos como os do sensor real — p/ demo do painel e testes sem hardware.
function startSim () {
  status = 'SIMULAÇÃO — embarcação sintética (sem hardware)'
  let t0 = 0
  setInterval(() => {
    const fs = 1650, N = 2048, sens = 0.12
    const x = [], y = [], z = []
    const mar = 0.5 + 0.5 * Math.sin(t0 / 9)             // estado do mar oscila
    for (let i = 0; i < N; i++) {
      const t = t0 + i / fs
      let az = 1000 + mar * 300 * Math.sin(2 * Math.PI * 1.2 * t)
      az += 45 * Math.sin(2 * Math.PI * 30 * t) + 18 * Math.sin(2 * Math.PI * 60 * t)
      if (mar > 0.6 && (t % 4) < 0.03) az += 1800 * Math.exp(-((t % 4)) * 150) * Math.sin(2 * Math.PI * 420 * t)
      az += (Math.random() * 2 - 1) * 6
      x.push(Math.round((25 * Math.sin(2 * Math.PI * 30 * t + 1) + (Math.random() * 2 - 1) * 6) / sens))
      y.push(Math.round((mar * 120 * Math.sin(2 * Math.PI * 1.2 * t + 2) + (Math.random() * 2 - 1) * 6) / sens))
      z.push(Math.round(az / sens))
    }
    t0 += N / fs + 0.15
    const raw = { x, y, z, fs, sens, ovr: 0, scale: 4, clip: 0 }
    last = processRaw(raw)
    last.status = status
    broadcast(last)
    recFeed(raw, last)
  }, 1400)
}

// exporta o motor p/ testes (tools/test-decomp.cjs) sem subir o servidor
module.exports = { processRaw, fftMag }
if (require.main !== module) return

if (process.env.VIB_SIM === '1') startSim()
else startBridge()

// ------------------------------------------------------------- HTTP + SSE
http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  // ---- gravador de padrões ----
  if (url === '/rec/start' && req.method === 'POST') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const { pattern, engine } = JSON.parse(body)
        if (!PATTERNS[pattern]) throw new Error('padrão inválido')
        if (!engine || !engine.trim()) throw new Error('informe o modelo do motor')
        rec = { active: true, pattern, engine: engine.trim(), got: 0, cycles: [], startedAt: Date.now() }
        broadcast(recStatus())
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(recStatus()))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  if (url === '/rec/stop' && req.method === 'POST') {
    rec.active = false
    broadcast(recStatus())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(recStatus()))
  }
  if (url === '/rec/list') {
    const q = new URLSearchParams(req.url.split('?')[1] || '')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ patterns: PATTERNS, recorded: recList(q.get('engine') || ''), target: REC_N }))
  }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify({ status })}\n\n`)
    if (last) res.write(`data: ${JSON.stringify(last)}\n\n`)
    clients.push(res)
    req.on('close', () => { clients = clients.filter(c => c !== res) })
    return
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return fs.createReadStream(path.join(__dirname, 'live.html')).pipe(res)
  }
  if (url === '/img/logo-safeboat-branco.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    return fs.createReadStream(path.join(__dirname, '..', 'public', 'img', 'logo-safeboat-branco.png')).pipe(res)
  }
  res.writeHead(404); res.end('404')
}).listen(PORT, () => console.log(`VIB monitor ao vivo: http://localhost:${PORT} (lendo ${COM})`))
