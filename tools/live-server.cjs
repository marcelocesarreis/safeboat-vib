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
  $p.Open()
  [Console]::Out.WriteLine('__PORTA_OK__')
  while ($true) {
    $d = $p.ReadExisting()
    if ($d.Length) { [Console]::Out.Write($d); [Console]::Out.Flush() }
    Start-Sleep -Milliseconds 25
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
      else if (line.startsWith('{"vib"')) {
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
