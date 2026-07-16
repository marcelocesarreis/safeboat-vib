/**
 * SAFEBOAT VIB — rede de análise de vibração (implementação de referência)
 *
 * Mesmo pipeline que roda no firmware (features no sensor) e no hub (comparação
 * entre sensores). No navegador, um simulador substitui o LIS3DH real.
 *
 * Pipeline:
 *  1. Aquisição      — blocos de aceleração a fs=3200 Hz (motor + referência casco)
 *  2. Cancelamento   — estima o acoplamento k do movimento comum de baixa
 *                      frequência (mar) entre motor e referência e subtrai:
 *                      comp = motor − k·ref  (só na banda < 5 Hz do mar)
 *  3. FFT            — 2048 pontos, janela Hann
 *  4. Features       — RMS de velocidade 10–1000 Hz (ISO 10816), fator de
 *                      crista, curtose, amplitude 1×/2×/harmônicos
 *  5. Diagnóstico    — assinatura espectral → falha provável + severidade
 */
;(() => {
  const FS = 3200            // Hz — taxa de amostragem do LIS3DH (LP mode 5.376k real; 3.2k usado)
  const N = 2048             // tamanho do bloco / FFT

  // ------------------------------------------------------------- simulador
  // Gera aceleração (em g) de dois canais: sensor no motor e referência no casco.
  // O balanço do mar é COMUM aos dois (com ganho/fase levemente diferentes) —
  // exatamente o que o cancelamento explora.
  class VibraSim {
    constructor () {
      this.rpm = 1800
      this.sea = 0.35          // estado do mar 0..1
      this.fault = null        // null | desbalanceamento | desalinhamento | rolamento | folga
      this.faultT0 = 0
      this.t = 0
      this.phases = Array.from({ length: 12 }, () => Math.random() * Math.PI * 2)
    }
    setFault (f, t) { this.fault = f; this.faultT0 = t }
    // severidade da falha cresce de 0→1 em ~25 s (história preditiva: tendência)
    sev (t) { return this.fault ? Math.min(1, (t - this.faultT0) / 25) : 0 }

    // gera um bloco de N amostras; retorna { motor, ref } em g
    block (tNow) {
      const motor = new Float32Array(N)
      const ref = new Float32Array(N)
      const f1 = this.rpm / 60                 // fundamental de rotação (Hz)
      const s = this.sev(tNow)
      const ph = this.phases
      // amplitudes-base (g) do motor saudável
      let A1 = 0.045, A2 = 0.018, A3 = 0.006
      let hfBurst = 0, harm = 0
      if (this.fault === 'desbalanceamento') A1 += 0.38 * s
      if (this.fault === 'desalinhamento') { A2 += 0.22 * s; A1 += 0.06 * s }
      if (this.fault === 'rolamento') hfBurst = 0.55 * s
      if (this.fault === 'folga') harm = 0.10 * s

      const bpfo = 4.68 * f1                   // freq. de defeito de pista externa
      // batida de casco (slamming): cresce com o quadrado do estado do mar e
      // excita modos estruturais de 11–17 Hz — DENTRO da banda de análise.
      // É isso que um filtro passa-alta cego não separa da máquina.
      const slamA = this.sea * this.sea * 0.10
      const seaAt = (t) => {
        const am = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t + ph[8])
        return this.sea * (0.55 * Math.sin(2 * Math.PI * 0.12 * t + ph[0]) +
                           0.32 * Math.sin(2 * Math.PI * 0.33 * t + ph[1]) +
                           0.18 * Math.sin(2 * Math.PI * 0.72 * t + ph[2]) +
                           0.08 * Math.sin(2 * Math.PI * 1.10 * t + ph[3])) +
               slamA * am * (Math.sin(2 * Math.PI * 11.3 * t + ph[9]) +
                             0.7 * Math.sin(2 * Math.PI * 16.7 * t + ph[10]))
      }
      for (let i = 0; i < N; i++) {
        const t = this.t + i / FS
        // ---- mar: ondas 0.12–1.1 Hz + slamming 11–17 Hz, comum aos dois canais ----
        const sea = seaAt(t)
        // ---- motor ----
        let m = A1 * Math.sin(2 * Math.PI * f1 * t + ph[4]) +
                A2 * Math.sin(2 * Math.PI * 2 * f1 * t + ph[5]) +
                A3 * Math.sin(2 * Math.PI * 3 * f1 * t + ph[6])
        if (harm > 0) for (let h = 3; h <= 6; h++) m += (harm / h) * Math.sin(2 * Math.PI * h * f1 * t + ph[h])
        if (hfBurst > 0) {
          // impactos periódicos do rolamento excitando ressonância ~950 Hz
          const phase = (t * bpfo) % 1
          if (phase < 0.10) m += hfBurst * Math.exp(-phase * 46) * Math.sin(2 * Math.PI * 950 * t)
        }
        m += 0.008 * (Math.random() * 2 - 1)                    // ruído de banda larga
        motor[i] = m + sea                                       // mar entra inteiro no canal do motor
        // ---- referência no casco: mesmo mar (ganho 0.94, atraso 1 ms — vibração
        // estrutural viaja a ~3 km/s, sensores a poucos metros) + ruído próprio ----
        const seaR = seaAt(t - 0.001)
        ref[i] = 0.94 * seaR + 0.006 * (Math.random() * 2 - 1) +
                 0.004 * Math.sin(2 * Math.PI * 11.7 * t + ph[7])   // ressonância leve do casco
      }
      this.t += N / FS
      return { motor, ref }
    }
  }

  // ------------------------------------------------------------------- DSP
  function fftMag (x) {                     // FFT radix-2 real → magnitudes N/2
    const n = x.length
    const re = new Float32Array(n), im = new Float32Array(n)
    for (let i = 0; i < n; i++) {           // janela Hann
      re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)))
    }
    // bit reversal
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
    const mag = new Float32Array(n / 2)
    for (let i = 0; i < n / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * 4 / n
    return mag
  }

  // passa-baixa simples (média móvel exponencial) p/ isolar a banda do mar
  function lowpass (x, alpha = 0.02) {
    const y = new Float32Array(x.length)
    let acc = x[0]
    for (let i = 0; i < x.length; i++) { acc += alpha * (x[i] - acc); y[i] = acc }
    return y
  }

  class VibraDetector {
    constructor () {
      this.history = []        // { t, rms } tendência
      this.k = 0               // acoplamento estimado motor↔referência
    }
    // comp = motor − k̂·lp(ref); k̂ estimado por projeção na banda do mar+slam (<~25 Hz).
    // A referência não contém máquina, então a subtração nunca toca a assinatura do motor.
    process (motor, ref, tNow, cancel = true) {
      const lm = lowpass(motor, 0.049), lr = lowpass(ref, 0.049)   // fc ≈ 25 Hz: pega swell E slamming
      let num = 0, den = 0
      for (let i = 200; i < N; i++) { num += lm[i] * lr[i]; den += lr[i] * lr[i] }
      const kInst = den > 1e-9 ? num / den : 0
      this.k += 0.25 * (kInst - this.k)                    // suaviza a estimativa
      const comp = new Float32Array(N)
      if (cancel) {
        // subtrai a referência em banda larga: ela só contém barco (mar + slam +
        // ressonâncias de casco) — nunca máquina — então não há o que preservar nela.
        // O passa-baixa serve apenas para estimar k̂ na banda onde os dois canais
        // são coerentes, sem viés do ruído de alta frequência.
        for (let i = 0; i < N; i++) comp[i] = motor[i] - this.k * ref[i]
        // remove só o resíduo de deriva (<~1 Hz) — não toca a banda da máquina
        const lc = lowpass(comp, 0.002)
        for (let i = 0; i < N; i++) comp[i] -= lc[i]
      } else {
        for (let i = 0; i < N; i++) comp[i] = motor[i]
      }

      const spec = fftMag(comp)                            // g por bin
      const df = FS / N                                    // 1.5625 Hz/bin

      // RMS de velocidade 10–1000 Hz (a[g]→v[mm/s]: v = a·9810/(2πf))
      let sumV2 = 0
      for (let i = Math.ceil(10 / df); i <= Math.floor(1000 / df); i++) {
        const v = spec[i] * 9810 / (2 * Math.PI * (i * df)) / Math.SQRT2
        sumV2 += v * v
      }
      const rms = Math.sqrt(sumV2)

      // fator de crista e curtose (do sinal compensado)
      let peak = 0, mean = 0
      for (let i = 0; i < N; i++) { peak = Math.max(peak, Math.abs(comp[i])); mean += comp[i] }
      mean /= N
      let m2 = 0, m4 = 0
      for (let i = 0; i < N; i++) { const d = comp[i] - mean; m2 += d * d; m4 += d * d * d * d }
      m2 /= N; m4 /= N
      const rmsA = Math.sqrt(m2)
      const crest = rmsA > 1e-9 ? peak / rmsA : 0
      const kurt = m2 > 1e-12 ? m4 / (m2 * m2) : 3

      this.history.push({ t: tNow, rms })
      if (this.history.length > 480) this.history.shift()

      return { comp, spec, df, rms, crest, kurt, k: this.k }
    }

    // ISO 10816-3 (grupo 2, base rígida) — zonas por RMS de velocidade
    static zone (rms) {
      if (rms <= 1.4) return { z: 'A', label: 'NOVO', color: '#15803d' }
      if (rms <= 2.8) return { z: 'B', label: 'BOM', color: '#15803d' }
      if (rms <= 7.1) return { z: 'C', label: 'ALERTA', color: '#a16207' }
      return { z: 'D', label: 'CRÍTICO', color: '#b91c1c' }
    }

    // diagnóstico pela assinatura espectral
    diagnose (r, rpm) {
      const f1 = rpm / 60, df = r.df
      const at = f => { const i = Math.round(f / df); let m = 0; for (let j = i - 1; j <= i + 1; j++) m = Math.max(m, r.spec[j] || 0); return m }
      const a1 = at(f1), a2 = at(2 * f1)
      let hf = 0
      for (let i = Math.ceil(700 / df); i < Math.floor(1400 / df); i++) hf += r.spec[i]
      let harm = 0
      for (let h = 3; h <= 6; h++) harm += at(h * f1)
      const cands = [
        { key: 'desbalanceamento', score: a1 / 0.05, txt: `pico dominante em 1× (${f1.toFixed(0)} Hz) — desbalanceamento do conjunto girante. Verificar hélice/eixo, acoplamento e depósitos.` },
        { key: 'desalinhamento', score: a2 / 0.02 * (a2 > a1 * 0.55 ? 1.4 : 0.6), txt: `2× (${(2 * f1).toFixed(0)} Hz) elevado vs 1× — desalinhamento motor–eixo. Verificar coxins e alinhamento do flange.` },
        { key: 'rolamento', score: (hf / 0.35) * (r.kurt > 4 ? 1.6 : 0.5), txt: `energia de alta frequência + curtose ${r.kurt.toFixed(1)} — impacto periódico de rolamento/engrenagem. Programar troca.` },
        { key: 'folga', score: harm / 0.05, txt: 'família de harmônicos 3×–6× — folga estrutural/mecânica. Verificar parafusos de fixação e coxins.' },
      ].sort((a, b) => b.score - a.score)
      return cands[0].score > 1.6 ? cands[0] : null
    }
  }

  // -------------------------------------------------------------- renderers
  function drawWave (cv, data, color, gLim, label) {
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    ctx.fillStyle = '#06070c'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,.08)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
    for (const f of [0.25, 0.75]) { ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke() }
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const step = Math.max(1, Math.floor(data.length / w))
    for (let x = 0; x < w; x++) {
      const v = data[Math.min(data.length - 1, x * step)]
      const y = h / 2 - (v / gLim) * (h / 2) * 0.92
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,.55)'
    ctx.font = '11px "Source Sans 3", sans-serif'
    ctx.fillText(label, 10, 16)
    ctx.fillText(`±${gLim} g`, w - 44, 16)
  }

  function drawSpec (cv, spec, df, rpm, fMax = 400) {
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    ctx.fillStyle = '#06070c'
    ctx.fillRect(0, 0, w, h)
    const nB = Math.floor(fMax / df)
    const f1 = rpm / 60
    // marcadores 1× e 2×
    for (const [mult, lab] of [[1, '1×'], [2, '2×']]) {
      const x = (mult * f1 / fMax) * w
      ctx.strokeStyle = 'rgba(255,255,255,.16)'
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, h - 16); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,.6)'
      ctx.font = '11px "Source Sans 3", sans-serif'
      ctx.fillText(lab, x + 3, 30)
    }
    // barras (escala log leve)
    const grad = ctx.createLinearGradient(0, h, 0, 0)
    grad.addColorStop(0, '#3b82f6'); grad.addColorStop(0.6, '#f59e0b'); grad.addColorStop(1, '#ef4444')
    ctx.fillStyle = grad
    const bw = Math.max(1, w / nB)
    for (let i = 1; i < nB; i++) {
      const m = spec[i]
      const y = Math.min(1, Math.pow(m / 0.25, 0.5)) * (h - 34)
      ctx.fillRect((i / nB) * w, h - 16 - y, bw * 0.85, y)
    }
    // eixo
    ctx.fillStyle = 'rgba(255,255,255,.45)'
    ctx.font = '10px "Source Sans 3", sans-serif'
    for (const f of [0, 100, 200, 300, 400]) {
      ctx.fillText(`${f}`, (f / fMax) * w + 2, h - 4)
    }
    ctx.fillText('Hz', w - 18, h - 4)
  }

  function drawTrend (cv, history, tNow) {
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    ctx.fillStyle = '#06070c'
    ctx.fillRect(0, 0, w, h)
    const span = 90                       // janela de 90 s
    const rMax = 12
    // zonas ISO como faixas
    const bands = [[0, 2.8, 'rgba(21,128,61,.14)'], [2.8, 7.1, 'rgba(161,98,7,.14)'], [7.1, rMax, 'rgba(185,28,28,.14)']]
    for (const [r0, r1, c] of bands) {
      ctx.fillStyle = c
      ctx.fillRect(0, h - (r1 / rMax) * h, w, ((r1 - r0) / rMax) * h)
    }
    ctx.strokeStyle = 'rgba(255,255,255,.25)'
    ctx.setLineDash([4, 4])
    for (const th of [2.8, 7.1]) {
      const y = h - (th / rMax) * h
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    ctx.setLineDash([])
    const pts = history.filter(p => p.t > tNow - span)
    if (pts.length > 2) {
      ctx.strokeStyle = '#60a5fa'
      ctx.lineWidth = 2
      ctx.beginPath()
      for (const p of pts) {
        const x = (1 - (tNow - p.t) / span) * w
        const y = h - Math.min(1, p.rms / rMax) * h
        p === pts[0] ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      // projeção linear (últimos 20 s) até o limiar C — o "preditivo"
      const rec = pts.filter(p => p.t > tNow - 20)
      if (rec.length > 4) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0
        for (const p of rec) { sx += p.t; sy += p.rms; sxx += p.t * p.t; sxy += p.t * p.rms }
        const n = rec.length
        const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx)
        const last = rec[rec.length - 1]
        if (slope > 0.005) {
          ctx.strokeStyle = 'rgba(239,68,68,.8)'
          ctx.setLineDash([6, 5])
          ctx.beginPath()
          const x0 = (1 - (tNow - last.t) / span) * w
          const y0 = h - Math.min(1, last.rms / rMax) * h
          ctx.moveTo(x0, y0)
          const tHit = last.t + (7.1 - last.rms) / slope
          const x1 = Math.min(w, (1 + (tHit - tNow) / span) * w)
          const y1 = h - (Math.min(rMax, last.rms + slope * (tHit - last.t)) / rMax) * h
          ctx.lineTo(x1, y1)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,.55)'
    ctx.font = '11px "Source Sans 3", sans-serif'
    ctx.fillText('RMS velocidade mm/s · janela 90 s · projeção até zona C', 10, 16)
  }

  window.Vibra = { VibraSim, VibraDetector, drawWave, drawSpec, drawTrend, FS, N }
})()
