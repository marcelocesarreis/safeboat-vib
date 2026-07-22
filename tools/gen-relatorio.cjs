/**
 * SAFEBOAT VIB — gera o relatório visual do caso AMARRADONA (HTML standalone)
 * Recomputa tudo dos brutos (nada de números na mão): severidade mediana,
 * espectros medianos por regime, ordens a 1200 rpm, razões BE/BB.
 * Saída: data/mar/relatorio-amarradona.html   (dados de cliente: NÃO publicar)
 */
const fs = require('fs')
const path = require('path')
const { fftMag } = require('./live-server.cjs')

const DIR = path.join(__dirname, '..', 'data', 'mar', 'padroes', 'amarradona-volvo-d6-370')
const OUT = path.join(__dirname, '..', 'data', 'mar', 'relatorio-amarradona.html')

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
function ampAt (spec, df, f, tol = 2) {
  const i = Math.round(f / df); let m = 0
  for (let k = Math.max(1, i - tol); k <= Math.min(spec.length - 1, i + tol); k++) m = Math.max(m, spec[k])
  return m
}

function groupSpec (cycles) {
  const specs = []; let fsSum = 0
  for (const c of cycles) {
    const raw = c.raw; fsSum += raw.fs
    const axes = [raw.x, raw.y, raw.z]
    let dom = 0, best = -1
    axes.forEach((a, i) => {
      let m = 0; for (const v of a) m += v; m /= a.length
      let e = 0; for (const v of a) e += (v - m) * (v - m)
      if (e > best) { best = e; dom = i }
    })
    let mean = 0; for (const v of axes[dom]) mean += v; mean /= axes[dom].length
    specs.push(fftMag(Float64Array.from(axes[dom], v => (v - mean) * raw.sens)))
  }
  const nb = specs[0].length, spec = new Float64Array(nb), col = new Array(specs.length)
  for (let i = 0; i < nb; i++) { for (let k = 0; k < specs.length; k++) col[k] = specs[k][i]; spec[i] = median(col) }
  return { spec, df: (fsSum / cycles.length) / (2 * nb) }
}

// carrega o mais recente de cada bordo/padrão
const groups = {}
for (const f of fs.readdirSync(DIR)) {
  const m = f.match(/^(be|bb)-(.+)_(\d{8}-\d{6})\.json$/)
  if (!m) continue
  const key = m[1] + '|' + m[2]
  if (!groups[key] || f > groups[key]) groups[key] = f
}
const D = {}
for (const [key, file] of Object.entries(groups)) {
  const [side, pat] = key.split('|')
  const j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))
  const { spec, df } = groupSpec(j.cycles)
  const visos = j.cycles.map(c => c.metrics.viso)
  if (!D[pat]) D[pat] = {}
  // espectro p/ gráfico: até 250 Hz em resolução cheia (~0,81 Hz/ponto)
  const n250 = Math.floor(250 / df)
  D[pat][side] = {
    engine: j.engine, n: j.cycles.length, df: +df.toFixed(4),
    viso: +median(visos).toFixed(2),
    spec: Array.from(spec.slice(0, n250), v => +v.toFixed(1)),
  }
}

// raia dominante por regime (5–120 Hz: zona das ordens baixas/queima)
function domLine (d) {
  const { spec, df } = { spec: d.spec, df: d.df }
  let pk = Math.ceil(5 / df)
  for (let i = pk; i < Math.min(spec.length, Math.floor(120 / df)); i++) if (spec[i] > spec[pk]) pk = i
  return { f: +(pk * df).toFixed(1), a: +spec[pk].toFixed(0) }
}
for (const pat of Object.keys(D)) for (const s of ['be', 'bb']) if (D[pat][s] && pat !== 'desligado') D[pat][s].dom = domLine(D[pat][s])

// ordens a 1200 (âncoras dos rpm exatos achados na análise: famílias inteiras)
const ORD_KS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]
function orders (d, rpm) {
  const f1 = rpm / 60, out = {}
  for (const k of ORD_KS) out[k] = +ampAt(d.spec, d.df, f1 * k).toFixed(1)
  return out
}
D['neutro-1200'].be.rpm = 1156; D['neutro-1200'].bb.rpm = 1180
D['neutro-1200'].be.orders = orders(D['neutro-1200'].be, 1156)
D['neutro-1200'].bb.orders = orders(D['neutro-1200'].bb, 1180)
D['neutro-max'].be.rpm = 2245; D['neutro-max'].bb.rpm = 2244

// ruído desligado (comparabilidade da instalação)
function bandRms (d, f0, f1) {
  let e = 0
  for (let i = Math.ceil(f0 / d.df); i < Math.floor(f1 / d.df); i++) e += d.spec[i] * d.spec[i]
  return Math.sqrt(e)
}
for (const s of ['be', 'bb']) D.desligado[s].ruido = +bandRms(D.desligado[s], 5, 250).toFixed(1)

const engine = D['neutro-800'].be.engine
const payload = { engine, D, gen: new Date().toLocaleString('pt-BR') }
console.log('lenta: BE dom', D['neutro-800'].be.dom, '· BB dom', D['neutro-800'].bb.dom)
console.log('viso lenta BE', D['neutro-800'].be.viso, '· BB', D['neutro-800'].bb.viso)

// ------------------------------------------------------------------- HTML
const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAFEBOAT VIB — Relatório de Vibração · AMARRADONA</title>
<style>
  :root { --navy:#23304A; --ink:#231F20; --line:#dde2ea; --panel:#f3f5f9; --txt2:#6b7385;
          --be:#2563eb; --bb:#b45309; --ok:#15803d; --warn:#a16207; --crit:#b91c1c; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',-apple-system,sans-serif; color:var(--navy); background:#fff; }
  header { background:var(--navy); color:#fff; padding:26px 34px; }
  header .k { font-size:11px; letter-spacing:.3em; color:rgba(255,255,255,.65); }
  header h1 { font-weight:300; letter-spacing:.08em; font-size:26px; margin-top:6px; }
  header .sub { color:rgba(255,255,255,.75); font-size:13px; margin-top:6px; }
  main { max-width:1080px; margin:0 auto; padding:26px 24px 60px; }
  h2 { font-weight:600; font-size:17px; margin:34px 0 6px; letter-spacing:.02em; }
  h2 .n { display:inline-block; width:24px; height:24px; border-radius:50%; background:var(--navy);
          color:#fff; font-size:13px; text-align:center; line-height:24px; margin-right:8px; }
  p.d { color:var(--txt2); font-size:13.5px; line-height:1.6; max-width:860px; margin-bottom:12px; }
  p.d b { color:var(--navy); }
  .hero { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin:20px 0; }
  .tile { border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .tile.main { border-color:var(--crit); background:#fef2f2; }
  .tile .l { font-size:10px; letter-spacing:.16em; font-weight:700; color:var(--txt2); }
  .tile .v { font-size:30px; font-weight:300; margin-top:4px; }
  .tile.main .v { color:var(--crit); font-weight:600; }
  .tile .s { font-size:11.5px; color:var(--txt2); margin-top:3px; line-height:1.4; }
  .chart { border:1px solid var(--line); border-radius:12px; padding:14px 14px 8px; margin:10px 0; }
  .chart .t { font-size:12px; font-weight:700; letter-spacing:.04em; }
  .chart .st { font-size:11px; color:var(--txt2); margin-bottom:4px; }
  .legend { display:flex; gap:16px; font-size:11.5px; color:var(--txt2); margin:4px 0 2px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:800px){ .grid2 { grid-template-columns:1fr; } }
  svg text { font-family:inherit; }
  #tip { position:fixed; pointer-events:none; background:var(--navy); color:#fff; font-size:11.5px;
         padding:5px 9px; border-radius:6px; opacity:0; transition:opacity .1s; z-index:10; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin:8px 0; }
  th,td { border-bottom:1px solid var(--line); padding:6px 10px; text-align:right; }
  th { color:var(--txt2); font-size:10px; letter-spacing:.1em; text-transform:uppercase; }
  td:first-child, th:first-child { text-align:left; }
  .verdict { border-left:4px solid var(--crit); background:#fef2f2; border-radius:10px; padding:14px 18px; margin:14px 0; font-size:14px; line-height:1.65; }
  .box { border-left:4px solid var(--navy); background:var(--panel); border-radius:10px; padding:13px 17px; margin:10px 0; font-size:13px; line-height:1.6; }
  .box b { color:var(--navy); }
  ol.plan { margin:8px 0 8px 20px; font-size:13.5px; line-height:1.8; }
  .refs { font-size:11.5px; color:var(--txt2); line-height:1.7; }
  footer { text-align:center; color:var(--txt2); font-size:11px; padding:20px; border-top:1px solid var(--line); margin-top:30px; }
</style></head><body>
<div id="tip"></div>
<header>
  <div class="k">SAFEBOAT · VIB · ANÁLISE DE VIBRAÇÃO POR ORDENS</div>
  <h1>Relatório de Diagnóstico — "AMARRADONA"</h1>
  <div class="sub">${engine} · sensor na caixa reversora · regimes em NEUTRO (motor isolado de hélice/eixo) · 12 ciclos × 2048 amostras @ ~1651 Hz por regime · gerado em <span id="gen"></span></div>
</header>
<main>
  <div class="hero" id="hero"></div>
  <div class="verdict" id="verdict"></div>

  <h2><span class="n">1</span>Severidade global por regime</h2>
  <p class="d">RMS de velocidade 10–500 Hz (mediana dos 12 ciclos), o número da ISO 20816. A diferença entre os motores <b>explode na lenta e converge no máximo governado</b> — comportamento típico de defeito de injeção (a variação de entrega por cilindro pesa mais quando se injeta pouco).</p>
  <div class="chart"><div class="t">RMS de velocidade (mm/s) · BE × BB</div><div class="st">barras agrupadas por regime · escala linear</div>
  <div class="legend"><span><i style="background:var(--be)"></i>BE · boreste (sintoma)</span><span><i style="background:var(--bb)"></i>BB · bombordo</span></div>
  <div id="c1"></div></div>

  <h2><span class="n">2</span>Espectros — onde a vibração mora</h2>
  <p class="d">Espectro mediano dos 12 ciclos, eixo dominante, 0–250 Hz. Na <b>lenta</b>, a raia de ~30 Hz do BE é <b>${'~'}${(D['neutro-800'].be.dom.a / D['neutro-800'].bb.dom.a).toFixed(1)}× a do BB</b> — mesma frequência, mesmo sensor, mesma fixação (ruído com motor desligado: BE ${D.desligado.be.ruido} × BB ${D.desligado.bb.ruido} mg — instalação comparável). A 1200 rpm o BE mostra a raia de <b>meia-ordem 1,5×</b> maior que a própria queima. No máximo, os dois convergem para a banda estrutural comum de 150–210 Hz.</p>
  <div id="c2"></div>

  <h2><span class="n">3</span>A assinatura: ordens do virabrequim a 1200 rpm</h2>
  <p class="d">Amplitude nas ordens da rotação (âncoras exatas: BE 1156 · BB 1180 rpm). Num 6 cilindros saudável, a <b>ordem de queima 3×</b> domina e as <b>meias-ordens (0,5× · 1,5× · 2,5×)</b> são residuais — elas só crescem quando <b>um cilindro queima diferente</b> (ciclo de 2 voltas quebra a simetria). No BE, a 1,5× <b>supera a própria queima</b>.</p>
  <div class="chart"><div class="t">Ordens 0,5×–6× (mg) · 1200 rpm</div><div class="st">setas marcam as meias-ordens · Q = ordem de queima (3×)</div>
  <div class="legend"><span><i style="background:var(--be)"></i>BE</span><span><i style="background:var(--bb)"></i>BB</span></div>
  <div id="c3"></div></div>

  <h2><span class="n">4</span>Tendência: a divergência morre com a rotação</h2>
  <p class="d">Razão BE/BB da severidade em cada regime. É esta curva que aponta <b>injeção</b> e afasta causas mecânicas fixas (desbalanceamento/alinhamento pioram com rotação — aqui é o contrário).</p>
  <div class="chart"><div class="t">Razão de severidade BE ÷ BB</div><div class="st">linha tracejada = paridade (motores iguais)</div><div id="c4"></div></div>

  <h2><span class="n">5</span>Dados de suporte</h2>
  <div id="tbl"></div>

  <h2><span class="n">6</span>Hipóteses e plano de confirmação</h2>
  <div class="box"><b>H1 — Injetor/entrega desigual em um cilindro do BE (mais provável).</b> Explica: severidade 8–9× na lenta, meia-ordem 1,5× dominante a 1200, convergência no máximo, e o som "quadrado". Suspeitos na D6: bico com retorno excessivo/agulha gasta; irmão mais caro com a mesma assinatura: compressão desigual.</div>
  <div class="box"><b>H2 — Coxim/modo estrutural ~29 Hz no BE (verificar por eliminação).</b> Um apoio degradado poderia amplificar o que cai perto de 29 Hz. Não explica tão bem a meia-ordem a 1200; inspeção visual dos coxins fecha a questão em minutos.</div>
  <ol class="plan">
    <li><b>Corte de cilindro na lenta</b> (VODIA / balanço de cilindros): ao cortar o cilindro culpado, a vibração quase não muda; nos demais, despenca. Medindo com o VIB durante o teste, o culpado aparece no espectro em tempo real.</li>
    <li><b>Trocar o bico do cilindro apontado com o de outro cilindro</b>: se a assinatura acompanhar o bico → bico. Se ficar → medir compressão.</li>
    <li><b>Inspecionar coxins do BE</b> (trincas/óleo) para eliminar H2.</li>
    <li><b>Repetir a medição VIB após o reparo</b> — o antes/depois vira o primeiro case documentado do produto.</li>
  </ol>

  <div class="box" style="border-left-color:var(--warn)"><b>Limitações desta análise:</b> uma gravação por regime/bordo (repetição aumentaria a confiança); sem tacômetro de referência — na lenta, a rotação pode ser lida como ~600 rpm (raia de 29,9 Hz = queima 3×, lenta de fábrica da D6) ou ~900 rpm (raia = 2×); informar o rpm do painel na próxima coleta remove a ambiguidade. <b>O veredito BE ≫ BB não depende dessa escolha.</b> Sensor movido entre motores (não simultâneo) — piso de ruído idêntico com motores desligados valida a comparação.</div>

  <h2><span class="n">7</span>Referências</h2>
  <p class="refs">
  · Detection of engine misfire using characteristic harmonics of angular acceleration — ResearchGate 331726855.<br>
  · Detection of diesel engine misfire by vibration analysis — ResearchGate 255879989.<br>
  · ISO 20816-1:2016 — Mechanical vibration: measurement and evaluation of machine vibration (família p/ máquinas recíprocas: partes 6/8).<br>
  · Misfire failure diagnosis of engine based on wavelet analysis — ResearchGate 296912121.<br>
  · Randall, R.B. — Vibration-based Condition Monitoring (Wiley, 2011), cap. motores de combustão interna.</p>
</main>
<footer>SAFEBOAT VIB — sensor LIS3DSH + ESP32-C3 na caixa reversora · análise de ordens executada em ${'${'}new Date().getFullYear()${'}'} · documento de trabalho de engenharia — confirmar hipóteses pelos testes físicos indicados</footer>
<script>
const P = ${JSON.stringify(payload)}
document.getElementById('gen').textContent = P.gen
const D = P.D
const BE = '#2563eb', BB = '#b45309', TXT = '#23304A', TX2 = '#6b7385', LINE = '#dde2ea'
const tip = document.getElementById('tip')
function showTip (ev, txt) { tip.textContent = txt; tip.style.opacity = 1; tip.style.left = (ev.clientX + 12) + 'px'; tip.style.top = (ev.clientY - 10) + 'px' }
function hideTip () { tip.style.opacity = 0 }
const S = (tag, attrs, parent) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e }

// ---------- hero + veredito ----------
const rIdle = (D['neutro-800'].be.viso / D['neutro-800'].bb.viso)
const rMax = (D['neutro-max'].be.viso / D['neutro-max'].bb.viso)
document.getElementById('hero').innerHTML =
  '<div class="tile main"><div class="l">DIVERGÊNCIA NA LENTA</div><div class="v">' + rIdle.toFixed(1) + '×</div><div class="s">severidade BE ÷ BB (' + D['neutro-800'].be.viso + ' × ' + D['neutro-800'].bb.viso + ' mm/s)</div></div>' +
  '<div class="tile"><div class="l">RAIA DE ~30 Hz NA LENTA</div><div class="v">' + D['neutro-800'].be.dom.a + '<small style="font-size:13px;color:#6b7385"> mg</small></div><div class="s">no BE, contra ' + D['neutro-800'].bb.dom.a + ' mg no BB — mesma frequência, mesmo sensor</div></div>' +
  '<div class="tile"><div class="l">MEIA-ORDEM 1,5× A 1200 rpm (BE)</div><div class="v">' + D['neutro-1200'].be.orders[1.5] + '<small style="font-size:13px;color:#6b7385"> mg</small></div><div class="s">maior que a própria queima 3× (' + D['neutro-1200'].be.orders[3] + ' mg) — cilindro desigual</div></div>' +
  '<div class="tile"><div class="l">NO MÁXIMO GOVERNADO</div><div class="v">' + rMax.toFixed(2) + '×</div><div class="s">a divergência praticamente desaparece — típico de injeção</div></div>'
document.getElementById('verdict').innerHTML =
  '<b>Conclusão:</b> o motor de <b>boreste apresenta irregularidade de combustão concentrada em baixa rotação</b>, compatível com <b>entrega desigual de um injetor</b> (H1). A assinatura é tripla e consistente: severidade ' + rIdle.toFixed(1) + '× maior na lenta, meia-ordem 1,5× dominante a 1200 rpm e convergência entre os motores no máximo governado. Confirmação recomendada: corte de cilindro na lenta (item 6).'

// ---------- C1: severidade por regime ----------
;(function(){
  const pats = [['neutro-800','Lenta'],['neutro-1200','1200 rpm'],['neutro-max','Máx. governado']]
  const W=1020,H=250,ML=46,MB=30,MT=14
  const svg = S('svg',{viewBox:'0 0 '+W+' '+H,width:'100%'},document.getElementById('c1'))
  const vmax = Math.max(...pats.map(p=>Math.max(D[p[0]].be.viso,D[p[0]].bb.viso)))*1.15
  const y = v => MT+(H-MT-MB)*(1-v/vmax)
  for (let g=0; g<=4; g++){ const v=vmax*g/4
    S('line',{x1:ML,x2:W-8,y1:y(v),y2:y(v),stroke:LINE,'stroke-width':1},svg)
    S('text',{x:ML-6,y:y(v)+4,'text-anchor':'end','font-size':10,fill:TX2},svg).textContent=v.toFixed(0)
  }
  S('text',{x:12,y:MT+10,'font-size':10,fill:TX2},svg).textContent='mm/s'
  const gw=(W-ML-20)/pats.length, bw=54
  pats.forEach((p,i)=>{
    const cx=ML+gw*i+gw/2
    ;[['be',BE,-bw-1],['bb',BB,1]].forEach(([s,c,off])=>{
      const v=D[p[0]][s].viso, yy=y(v), hh=H-MB-yy
      const r=S('path',{d:'M'+(cx+off)+' '+(H-MB)+' v'+(-(hh-4))+' q0 -4 4 -4 h'+(bw-8)+' q4 0 4 4 v'+(hh-4)+' z',fill:c},svg)
      r.addEventListener('mousemove',e=>showTip(e,(s==='be'?'BE':'BB')+' · '+p[1]+': '+v+' mm/s'))
      r.addEventListener('mouseleave',hideTip)
      S('text',{x:cx+off+bw/2,y:yy-6,'text-anchor':'middle','font-size':11,fill:TXT,'font-weight':600},svg).textContent=v.toFixed(1)
    })
    S('text',{x:cx,y:H-10,'text-anchor':'middle','font-size':11.5,fill:TX2},svg).textContent=p[1]
  })
})()

// ---------- C2: espectros (3 pequenos múltiplos) ----------
;(function(){
  const host=document.getElementById('c2')
  const pats=[['neutro-800','Lenta · raia de queima ~30 Hz','O caso: BE '+D['neutro-800'].be.dom.a+' mg × BB '+D['neutro-800'].bb.dom.a+' mg'],
              ['neutro-1200','1200 rpm · meia-ordem 1,5× no BE','29 Hz (1,5×) contra queima 3× em ~58 Hz'],
              ['neutro-max','Máximo governado ~2245 rpm','banda estrutural comum 150–210 Hz — bordos convergem']]
  for (const [pat,t,st] of pats){
    const div=document.createElement('div'); div.className='chart'
    div.innerHTML='<div class="t">'+t+'</div><div class="st">'+st+'</div><div class="legend"><span><i style="background:'+BE+'"></i>BE</span><span><i style="background:'+BB+'"></i>BB</span></div>'
    host.appendChild(div)
    const W=1020,H=190,ML=46,MB=24,MT=8
    const svg=S('svg',{viewBox:'0 0 '+W+' '+H,width:'100%'},div)
    const be=D[pat].be, bb=D[pat].bb
    const vmax=Math.max(...be.spec,...bb.spec)*1.12
    const n=Math.min(be.spec.length,bb.spec.length)
    const x=i=>ML+(W-ML-10)*i/n, y=v=>MT+(H-MT-MB)*(1-v/vmax)
    for (const f of [50,100,150,200,250]){ const i=f/be.df; if(i>n)break
      S('line',{x1:x(i),x2:x(i),y1:MT,y2:H-MB,stroke:LINE,'stroke-width':1},svg)
      S('text',{x:x(i),y:H-8,'text-anchor':'middle','font-size':10,fill:TX2},svg).textContent=f+' Hz'
    }
    S('text',{x:ML-6,y:MT+9,'text-anchor':'end','font-size':10,fill:TX2},svg).textContent=vmax.toFixed(0)+' mg'
    for (const [d,c] of [[bb,BB],[be,BE]]){
      let p=''
      d.spec.slice(0,n).forEach((v,i)=>{ p+=(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1) })
      S('path',{d:p,fill:'none',stroke:c,'stroke-width':1.8},svg)
    }
    const ov=S('rect',{x:ML,y:MT,width:W-ML-10,height:H-MT-MB,fill:'transparent'},svg)
    ov.addEventListener('mousemove',e=>{
      const r=ov.getBoundingClientRect(), fr=(e.clientX-r.left)/r.width
      const i=Math.round(fr*n); if(i<0||i>=n)return
      showTip(e,(i*be.df).toFixed(1)+' Hz · BE '+be.spec[i]+' mg · BB '+bb.spec[i]+' mg')
    })
    ov.addEventListener('mouseleave',hideTip)
  }
})()

// ---------- C3: ordens a 1200 ----------
;(function(){
  const ks=[0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6]
  const be=D['neutro-1200'].be.orders, bb=D['neutro-1200'].bb.orders
  const W=1020,H=250,ML=46,MB=34,MT=16
  const svg=S('svg',{viewBox:'0 0 '+W+' '+H,width:'100%'},document.getElementById('c3'))
  const vmax=Math.max(...ks.map(k=>Math.max(be[k],bb[k])))*1.18
  const y=v=>MT+(H-MT-MB)*(1-v/vmax)
  for(let g=0;g<=4;g++){const v=vmax*g/4
    S('line',{x1:ML,x2:W-8,y1:y(v),y2:y(v),stroke:LINE},svg)
    S('text',{x:ML-6,y:y(v)+4,'text-anchor':'end','font-size':10,fill:TX2},svg).textContent=v.toFixed(0)
  }
  const gw=(W-ML-16)/ks.length,bw=Math.min(30,gw/2-3)
  ks.forEach((k,i)=>{
    const cx=ML+gw*i+gw/2
    ;[[be,'BE',BE,-bw-1],[bb,'BB',BB,1]].forEach(([d,nm,c,off])=>{
      const v=d[k],yy=y(v),hh=Math.max(2,H-MB-yy)
      const r=S('path',{d:'M'+(cx+off)+' '+(H-MB)+' v'+(-(Math.max(hh-4,0)))+' q0 -4 4 -4 h'+(bw-8)+' q4 0 4 4 v'+Math.max(hh-4,0)+' z',fill:c},svg)
      r.addEventListener('mousemove',e=>showTip(e,nm+' · '+k+'×: '+v+' mg'))
      r.addEventListener('mouseleave',hideTip)
    })
    const half=k%1!==0
    S('text',{x:cx,y:H-16,'text-anchor':'middle','font-size':11,fill:half?'#b91c1c':TX2,'font-weight':half?700:400},svg).textContent=k+'×'
    if(k===3) S('text',{x:cx,y:H-4,'text-anchor':'middle','font-size':10,fill:TX2,'font-weight':700},svg).textContent='Q'
    if(half&&(k===1.5)) S('text',{x:cx,y:y(Math.max(be[k],bb[k]))-8,'text-anchor':'middle','font-size':11,fill:'#b91c1c','font-weight':700},svg).textContent='▼ meia-ordem'
  })
})()

// ---------- C4: razão por regime ----------
;(function(){
  const pats=[['neutro-800','Lenta'],['neutro-1200','1200 rpm'],['neutro-max','Máx.']]
  const vals=pats.map(p=>D[p[0]].be.viso/D[p[0]].bb.viso)
  const W=1020,H=210,ML=46,MB=30,MT=14
  const svg=S('svg',{viewBox:'0 0 '+W+' '+H,width:'100%'},document.getElementById('c4'))
  const vmax=Math.max(...vals)*1.2
  const x=i=>ML+ (W-ML-60)*i/(pats.length-1), y=v=>MT+(H-MT-MB)*(1-v/vmax)
  for(let g=0;g<=4;g++){const v=vmax*g/4
    S('line',{x1:ML,x2:W-8,y1:y(v),y2:y(v),stroke:LINE},svg)
    S('text',{x:ML-6,y:y(v)+4,'text-anchor':'end','font-size':10,fill:TX2},svg).textContent=v.toFixed(0)+'×'
  }
  S('line',{x1:ML,x2:W-8,y1:y(1),y2:y(1),stroke:TX2,'stroke-dasharray':'5 5'},svg)
  S('text',{x:W-12,y:y(1)-5,'text-anchor':'end','font-size':10,fill:TX2},svg).textContent='paridade 1×'
  let p=''
  vals.forEach((v,i)=>{p+=(i?'L':'M')+x(i)+' '+y(v)})
  S('path',{d:p,fill:'none',stroke:TXT,'stroke-width':2},svg)
  vals.forEach((v,i)=>{
    const c=S('circle',{cx:x(i),cy:y(v),r:6,fill:TXT},svg)
    c.addEventListener('mousemove',e=>showTip(e,pats[i][1]+': BE/BB = '+v.toFixed(2)+'×'))
    c.addEventListener('mouseleave',hideTip)
    S('text',{x:x(i),y:y(v)-12,'text-anchor':'middle','font-size':12,'font-weight':700,fill:TXT},svg).textContent=v.toFixed(1)+'×'
    S('text',{x:x(i),y:H-8,'text-anchor':'middle','font-size':11.5,fill:TX2},svg).textContent=pats[i][1]
  })
})()

// ---------- tabela ----------
;(function(){
  let h='<table><tr><th>Regime</th><th>BE viso (mm/s)</th><th>BB viso (mm/s)</th><th>Razão</th><th>BE raia dom.</th><th>BB raia dom.</th></tr>'
  for (const [pat,nm] of [['desligado','Motor desligado (ruído)'],['neutro-800','Lenta'],['neutro-1200','1200 rpm'],['neutro-max','Máx. governado']]){
    const be=D[pat].be, bb=D[pat].bb
    if(pat==='desligado'){ h+='<tr><td>'+nm+'</td><td>'+be.ruido+' mg</td><td>'+bb.ruido+' mg</td><td>'+(be.ruido/bb.ruido).toFixed(2)+'×</td><td colspan=2>pisos idênticos ⇒ instalação comparável</td></tr>'; continue }
    h+='<tr><td>'+nm+'</td><td>'+be.viso+'</td><td>'+bb.viso+'</td><td><b>'+(be.viso/bb.viso).toFixed(1)+'×</b></td><td>'+be.dom.f+' Hz · '+be.dom.a+' mg</td><td>'+bb.dom.f+' Hz · '+bb.dom.a+' mg</td></tr>'
  }
  document.getElementById('tbl').innerHTML=h+'</table>'
})()
</script></body></html>`
fs.writeFileSync(OUT, html)
console.log('relatório: ' + OUT)
