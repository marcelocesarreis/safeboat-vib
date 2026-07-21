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

function processRaw (d) {
  const N = d.x.length
  const axes = [d.x, d.y, d.z]
  const mean = [], rms = [], peak = []
  let dom = 0
  for (let a = 0; a < 3; a++) {
    let m = 0
    for (const v of axes[a]) m += v
    m /= N
    let r = 0, p = 0
    for (const v of axes[a]) { const dd = v - m; r += dd * dd; if (Math.abs(dd) > p) p = Math.abs(dd) }
    mean.push(m * d.sens); rms.push(Math.sqrt(r / N) * d.sens); peak.push(p * d.sens)
    if (rms[a] > rms[dom]) dom = a
  }
  // FFT do eixo dominante em g, resolução cheia (df = fs/N pela taxa medida)
  const mDom = mean[dom] / d.sens
  const sig = axes[dom].map(v => (v - mDom) * d.sens * 0.001)
  const mag = fftMag(sig)
  const df = d.fs / N
  let sumV2 = 0
  for (let i = Math.ceil(10 / df); i <= Math.min(mag.length - 1, Math.floor(500 / df)); i++) {
    const v = mag[i] * 9810 / (2 * Math.PI * i * df) / Math.SQRT2
    sumV2 += v * v
  }
  // espectro p/ exibição: 1024 → 512 bins (máx de pares), em mg
  const fft = []
  for (let i = 0; i < mag.length / 2; i++) fft.push(+(Math.max(mag[2 * i], mag[2 * i + 1]) * 1000).toFixed(2))
  // forma de onda: 512 pts do eixo dominante, mg AC
  const wave = []
  for (let i = 0; i < 512; i++) wave.push(+((axes[dom][i * Math.floor(N / 512)] - mDom) * d.sens).toFixed(1))
  return {
    vib: 1, fftpc: 1, fs: d.fs, ovr: d.ovr, scale: d.scale, dom,
    viso: +Math.sqrt(sumV2).toFixed(3), res: +df.toFixed(3),
    mean: mean.map(v => +v.toFixed(1)), rms: rms.map(v => +v.toFixed(2)), peak: peak.map(v => +v.toFixed(1)),
    fft, wave,
  }
}

function broadcast (obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`
  clients = clients.filter(c => { try { c.write(msg); return true } catch { return false } })
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
startBridge()

// ------------------------------------------------------------- HTTP + SSE
http.createServer((req, res) => {
  const url = req.url.split('?')[0]
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
