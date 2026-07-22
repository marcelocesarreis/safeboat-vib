/**
 * SAFEBOAT VIB — ANÁLISE DE ORDENS do teste de mar (diagnóstico de combustão)
 *
 * Física do diagnóstico (motor 4 tempos, N cilindros):
 *   ordem 1 = rotação do virabrequim (1× = rpm/60)
 *   ordem de QUEIMA = N/2 (todos os cilindros contribuem — deve DOMINAR)
 *   MEIA-ORDEM (0,5×) = frequência do ciclo termodinâmico (2 voltas):
 *     só aparece forte quando UM cilindro queima diferente dos outros
 *     (injetor, compressão, bico) — quebra a simetria da sequência.
 *   Motor "quadrado"/áspero ⇒ meias-ordens e sub-harmônicos crescem
 *     em relação à ordem de queima.
 *
 * Índices calculados por bordo/padrão:
 *   R_half = Σ(meias-ordens 0,5..Nf−0,5) / A(ordem de queima)
 *   R_low  = (A0,5 + A1 + A1,5) / A(queima)
 *   e a comparação BE × BB desses índices é o veredito.
 *
 * Uso: node tools/analyze-mar.cjs <pasta com data/padroes> [--cyl N]
 * Sai: relatório no console + relatorio-mar.html na pasta dos dados.
 */
const fs = require('fs')
const path = require('path')
const { fftMag } = require('./live-server.cjs')

// ------------------------------------------------------------------ entrada
const args = process.argv.slice(2)
let root = args.find(a => !a.startsWith('--'))
const cylArg = args.includes('--cyl') ? parseInt(args[args.indexOf('--cyl') + 1]) : null
if (!root) { console.error('uso: node tools/analyze-mar.cjs <pasta> [--cyl N]'); process.exit(1) }
root = path.resolve(root)

// acha a pasta padroes a partir de qualquer raiz dada
function findPadroes (r) {
  const cands = [r, path.join(r, 'padroes'), path.join(r, 'data', 'padroes')]
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
    const subs = fs.readdirSync(c).filter(s => fs.statSync(path.join(c, s)).isDirectory())
    if (path.basename(c) === 'padroes') return c
    if (subs.includes('padroes')) return path.join(c, 'padroes')
    if (subs.includes('data')) return path.join(c, 'data', 'padroes')
  }
  return null
}
const padroesDir = findPadroes(root)
if (!padroesDir) { console.error('não achei data/padroes dentro de ' + root); process.exit(1) }

const engines = fs.readdirSync(padroesDir).filter(s => fs.statSync(path.join(padroesDir, s)).isDirectory())
if (!engines.length) { console.error('nenhum motor em ' + padroesDir); process.exit(1) }

// nº de cilindros: --cyl, ou heurística no nome do motor
function guessCyl (name) {
  const n = name.toLowerCase()
  let m = n.match(/(\d+)\s*cil/) || n.match(/[qv](\d)\b/) || n.match(/\bd(\d)\b/) || n.match(/\b(\d)\.\d\s*l?\b/)
  if (m) { const c = parseInt(m[1]); if (c >= 3 && c <= 12) return c }
  return null
}

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// amplitude de pico em torno de f (máx de ±tol bins)
function ampAt (spec, df, f, tol = 2) {
  const i = Math.round(f / df)
  let m = 0
  for (let k = Math.max(1, i - tol); k <= Math.min(spec.length - 1, i + tol); k++) m = Math.max(m, spec[k])
  return m
}

// espectro mediano do conjunto de ciclos (FFT cheia 2048 → df ≈ 0,8 Hz), em mg
function groupSpectrum (cycles) {
  const specs = []
  let fsSum = 0
  for (const c of cycles) {
    const raw = c.raw
    const N = raw.x.length
    fsSum += raw.fs
    const axes = [raw.x, raw.y, raw.z]
    // eixo dominante pela energia AC
    let dom = 0, best = -1
    const acs = axes.map(a => {
      let m = 0; for (const v of a) m += v; m /= a.length
      let e = 0; for (const v of a) e += (v - m) * (v - m)
      return e
    })
    acs.forEach((e, i) => { if (e > best) { best = e; dom = i } })
    let mean = 0; for (const v of axes[dom]) mean += v; mean /= N
    const sig = Float64Array.from(axes[dom], v => (v - mean) * raw.sens)   // mg
    specs.push(fftMag(sig))
  }
  const fs0 = fsSum / cycles.length
  const nb = specs[0].length
  const spec = new Float64Array(nb)
  const col = new Array(specs.length)
  for (let i = 0; i < nb; i++) {
    for (let k = 0; k < specs.length; k++) col[k] = specs[k][i]
    spec[i] = median(col)
  }
  return { spec, df: fs0 / (2 * nb), fs: fs0 }
}

// acha o 1× do virabrequim: pente de ORDENS INTEIRAS (tolerância apertada)
// em torno do rpm esperado. Meias-ordens NÃO entram aqui — num motor liso o
// pente meio-ordem é degenerado e trava em rotação falsa (bug pego no teste
// sintético). Empate ~10% → fica o candidato mais perto do rpm declarado.
function combScore (spec, df, f0, ks, flat = false) {
  let s = 0
  for (const k of ks) s += ampAt(spec, df, f0 * k, 1) / (flat ? 1 : Math.sqrt(k))
  return s
}
function findCrank (spec, df, rpmRange) {
  const range = rpmRange ? [rpmRange[0] / 60, rpmRange[1] / 60] : [8, 70]
  let bestF = range[0], bestS = -1
  for (let f = range[0]; f <= range[1]; f += df / 4) {
    const s = combScore(spec, df, f, [1, 2, 3, 4, 5, 6, 7, 8])
    if (s > bestS) { bestS = s; bestF = f }
  }
  // desambiguação: o pente com peso 1/√k pode travar em 3/2, 2/3, 2× ou ½
  // do verdadeiro (confusões clássicas sem tacômetro). Reavalia os candidatos
  // com pesos PLANOS — a família inteira de ordens decide, não a raia grande.
  const cands = [bestF, bestF / 2, bestF * 2, bestF * 2 / 3, bestF * 3 / 2, bestF * 1 / 3]
    .filter(f => f >= range[0] * 0.95 && f <= range[1] * 1.05)
  let fin = bestF, finS = -1
  for (const f of cands) {
    const s = combScore(spec, df, f, [1, 2, 3, 4, 5, 6, 7, 8], true)   // pesos planos
    if (s > finS * 1.02 || (s >= finS * 0.98 && f > fin)) { finS = Math.max(s, finS); fin = f }
    else if (s > finS) finS = s
  }
  return fin
}
// picos dominantes do espectro (transparência: confere a âncora na mão)
function topPeaks (spec, df, n = 5) {
  const out = []
  for (let i = Math.ceil(5 / df); i < Math.min(spec.length - 1, Math.floor(500 / df)); i++) {
    if (spec[i] > spec[i - 1] && spec[i] >= spec[i + 1]) out.push([i * df, spec[i]])
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, n)
}

// faixas REALISTAS de busca da rotação (rpm): o rótulo é nominal — diesel
// marítimo em lenta real gira 550–700; "máximo" desengatado vai ao governador
const EXPECT_RANGE = {
  'neutro-800': [480, 1050], 'neutro-1200': [950, 1500], 'neutro-max': [1700, 3700],
  'engatado-900': [550, 1150], 'engatado-1200': [950, 1500], 'engatado-2000': [1700, 2400], 'engatado-max': [1700, 3700],
}

// ------------------------------------------------------------------ análise
const report = { engines: [] }
for (const eng of engines) {
  const dir = path.join(padroesDir, eng)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const groups = {}
  for (const f of files) {
    let m = f.match(/^(be|bb)-(.+)_(\d{8}-\d{6})\.json$/)
    let side, pat
    if (m) { side = m[1]; pat = m[2] } else { m = f.match(/^(.+)_(\d{8}-\d{6})\.json$/); if (!m) continue; side = 'be'; pat = m[1] }
    const key = side + '|' + pat
    if (!groups[key] || f > groups[key]) groups[key] = f
  }
  const first = JSON.parse(fs.readFileSync(path.join(dir, Object.values(groups)[0]), 'utf8'))
  const engineName = first.engine || eng
  const cyl = cylArg || guessCyl(engineName) || 6
  const Nf = cyl / 2                                  // ordem de queima (4 tempos)
  console.log(`\n===== MOTOR: ${engineName} · ${cyl} cilindros (ordem de queima ${Nf}×) =====`)
  if (!cylArg && !guessCyl(engineName)) console.log('  (nº de cilindros não identificado no nome — assumindo 6; use --cyl N p/ corrigir)')

  const engOut = { engine: engineName, cyl, Nf, patterns: {} }
  for (const [key, file] of Object.entries(groups).sort()) {
    const [side, pat] = key.split('|')
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const { spec, df, fs: fsm } = groupSpectrum(d.cycles)
    let out = { side, file, n: d.cycles.length, df: +df.toFixed(3) }
    if (pat === 'desligado') {
      let e = 0
      for (let i = Math.ceil(5 / df); i < Math.floor(500 / df); i++) e += spec[i] * spec[i]
      out.ruido = +Math.sqrt(e).toFixed(2)
    } else {
      const f1 = findCrank(spec, df, EXPECT_RANGE[pat])
      out.rpm = Math.round(f1 * 60)
      out.peaks = topPeaks(spec, df).map(([f, a]) => `${f.toFixed(1)}Hz(${(f / f1).toFixed(2)}x)=${a.toFixed(0)}mg`)
      out.orders = {}
      for (let k = 0.5; k <= Math.max(8, Nf * 2 + 1); k += 0.5) {
        out.orders[k] = +ampAt(spec, df, f1 * k).toFixed(2)
      }
      const aFire = Math.max(out.orders[Nf], 0.01)
      let halves = 0, lows = 0
      for (let k = 0.5; k < Nf; k += 0.5) {
        if (k % 1 !== 0) halves += out.orders[k]
        if (k <= 1.5) lows += out.orders[k]
      }
      out.aFire = aFire
      // piso de confiança: queima precisa se destacar do piso espectral
      const floorSpec = median(Array.from(spec.slice(Math.ceil(5 / df), Math.floor(400 / df))))
      out.fireOk = aFire > 4 * floorSpec && aFire > 1
      out.R_half = +(halves / aFire).toFixed(3)
      out.R_low = +(lows / aFire).toFixed(3)
      if (!out.fireOk) out.aviso = 'ordem de queima fraca — rpm/nº de cilindros a confirmar'
    }
    // espectro decimado p/ o relatório (0–400 Hz)
    const nOut = Math.min(spec.length, Math.floor(400 / df))
    const dec = Math.max(1, Math.floor(nOut / 500))
    out.plot = { df: df * dec, spec: [] }
    for (let i = 0; i < nOut; i += dec) {
      let m = 0
      for (let j = i; j < Math.min(nOut, i + dec); j++) m = Math.max(m, spec[j])
      out.plot.spec.push(+m.toFixed(2))
    }
    if (!engOut.patterns[pat]) engOut.patterns[pat] = {}
    engOut.patterns[pat][side] = out
    const tag = pat === 'desligado'
      ? `ruído ambiente ${out.ruido} mg`
      : `rpm ${out.rpm} · A(queima ${Nf}×)=${out.aFire} mg · R_half=${out.R_half} · R_low=${out.R_low}`
    console.log(`  ${side.toUpperCase()} · ${pat.padEnd(14)} ${tag}  [${d.cycles.length} ciclos]`)
    if (out.peaks) console.log(`      picos: ${out.peaks.join(' · ')}`)
    if (out.orders) {
      const ks = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]
      console.log('      ordens: ' + ks.map(k => `${k}×=${out.orders[k]}`).join(' '))
    }
  }

  // vereditos BE × BB por padrão
  console.log('  --- comparação BE × BB ---')
  engOut.verdicts = []
  for (const [pat, sides] of Object.entries(engOut.patterns)) {
    if (pat === 'desligado' || !sides.be || !sides.bb) continue
    if (!sides.be.fireOk || !sides.bb.fireOk) {
      engOut.verdicts.push(`${pat}: ordem de queima não confirmada num dos bordos — verificar rpm/cilindros antes de comparar`)
      continue
    }
    const rH = +(Math.max(sides.bb.R_half, 0.02) / Math.max(sides.be.R_half, 0.02)).toFixed(2)
    const worse = sides.bb.R_half > sides.be.R_half ? 'BB' : 'BE'
    const ratio = worse === 'BB' ? rH : +(1 / rH).toFixed(2)
    let v = `${pat}: R_half BE=${sides.be.R_half} × BB=${sides.bb.R_half} → `
    v += ratio >= 1.8
      ? `IRREGULARIDADE DE COMBUSTÃO ${ratio}× maior no ${worse} (assinatura de injetor/compressão desigual)`
      : `diferença de combustão pequena (${ratio}×)`
    engOut.verdicts.push(v)
    console.log('  · ' + v)
  }
  report.engines.push(engOut)
}

// ------------------------------------------------------------ relatório HTML
const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>SAFEBOAT VIB — Análise do Teste de Mar</title>
<style>
 body{font-family:'Segoe UI',sans-serif;color:#23304A;max-width:1150px;margin:20px auto;padding:0 16px}
 h1{font-weight:300;letter-spacing:.08em} h2{margin-top:28px} h3{color:#6b7385}
 canvas{border:1px solid #23304A;border-radius:8px;background:#06070c;display:block;margin:8px 0;max-width:100%}
 table{border-collapse:collapse;font-size:13px;margin:8px 0}
 td,th{border-bottom:1px solid #dde2ea;padding:5px 12px;text-align:right}
 td:first-child,th:first-child{text-align:left}
 .v{background:#f3f5f9;border-left:3px solid #23304A;padding:10px 14px;border-radius:8px;margin:6px 0;font-size:14px}
 .crit{border-left-color:#b91c1c;font-weight:600}
</style></head><body>
<h1>SAFEBOAT VIB — Análise de Ordens · Teste de Mar</h1>
<div id="app"></div>
<script>
const R = ${JSON.stringify(report)}
const app = document.getElementById('app')
for (const eng of R.engines) {
  app.insertAdjacentHTML('beforeend', '<h2>'+eng.engine+' · '+eng.cyl+' cil · queima '+eng.Nf+'×</h2>')
  for (const v of (eng.verdicts||[]))
    app.insertAdjacentHTML('beforeend', '<div class="v'+(v.includes('IRREGULARIDADE')?' crit':'')+'">'+v+'</div>')
  for (const [pat, sides] of Object.entries(eng.patterns)) {
    app.insertAdjacentHTML('beforeend', '<h3>'+pat+'</h3>')
    // barras de ordens BE × BB
    if (sides.be && sides.be.orders || sides.bb && sides.bb.orders) {
      const cv = document.createElement('canvas'); cv.width=1100; cv.height=240
      app.appendChild(cv)
      const ctx = cv.getContext('2d')
      const ks = Object.keys((sides.be||sides.bb).orders).map(Number).filter(k=>k<=eng.Nf*2)
      let top = 1
      for (const s of ['be','bb']) if (sides[s]) for (const k of ks) top = Math.max(top, sides[s].orders[k])
      const bw = 1100/(ks.length*3)
      ks.forEach((k,i)=>{
        const x0 = i*3*bw
        if (sides.be) { ctx.fillStyle='#60a5fa'; const h=200*sides.be.orders[k]/top; ctx.fillRect(x0, 210-h, bw*0.95, h) }
        if (sides.bb) { ctx.fillStyle='#f59e0b'; const h=200*sides.bb.orders[k]/top; ctx.fillRect(x0+bw, 210-h, bw*0.95, h) }
        ctx.fillStyle = (k===eng.Nf)?'#ef4444':'rgba(255,255,255,.6)'
        ctx.font='11px sans-serif'; ctx.fillText(k+'x', x0+2, 228)
      })
      ctx.fillStyle='#60a5fa'; ctx.fillText('BE', 1040, 16); ctx.fillStyle='#f59e0b'; ctx.fillText('BB', 1070, 16)
    }
    // tabela
    let t = '<table><tr><th></th><th>rpm</th><th>A queima (mg)</th><th>R_half</th><th>R_low</th><th>ciclos</th></tr>'
    for (const s of ['be','bb']) if (sides[s] && sides[s].orders)
      t += '<tr><td>'+s.toUpperCase()+'</td><td>'+sides[s].rpm+'</td><td>'+sides[s].aFire+'</td><td>'+sides[s].R_half+'</td><td>'+sides[s].R_low+'</td><td>'+sides[s].n+'</td></tr>'
    for (const s of ['be','bb']) if (sides[s] && sides[s].ruido !== undefined)
      t += '<tr><td>'+s.toUpperCase()+' (desligado)</td><td colspan=4>ruído ambiente '+sides[s].ruido+' mg</td><td>'+sides[s].n+'</td></tr>'
    app.insertAdjacentHTML('beforeend', t+'</table>')
  }
}
</script></body></html>`
const outFile = path.join(padroesDir, '..', 'relatorio-mar.html')
fs.writeFileSync(outFile, html)
console.log('\nrelatório: ' + outFile)
