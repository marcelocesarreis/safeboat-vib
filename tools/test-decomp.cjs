/**
 * SAFEBOAT VIB — teste do motor de decomposição com uma "embarcação sintética"
 *
 * Gera uma rajada como a que o LIS3DSH mandaria num barco navegando:
 *   gravidade 1 g (Z) · balanço/manobra 1,5 Hz 250 mg · motor 30 Hz 50 mg
 *   + 2× (60 Hz) 20 mg · 2 pancadas de mar (burst 400 Hz, 2 g, 30 ms)
 *   + ruído 5 mg — e confere se o motor separa cada componente.
 *
 * Rodar: node tools/test-decomp.cjs
 */
const { processRaw } = require('./live-server.cjs')

const fs = 1650, N = 2048, sens = 0.12          // ±4 g → 0,12 mg/díg
const x = [], y = [], z = []
for (let i = 0; i < N; i++) {
  const t = i / fs
  let az = 1000                                  // gravidade: 1 g em Z (mg)
  az += 250 * Math.sin(2 * Math.PI * 1.5 * t)    // navegação/balanço 1,5 Hz
  az += 50 * Math.sin(2 * Math.PI * 30 * t)      // motor 1× (1800 rpm)
  az += 20 * Math.sin(2 * Math.PI * 60 * t)      // motor 2×
  for (const t0 of [0.35, 0.82]) {               // 2 pancadas de mar
    if (t >= t0 && t < t0 + 0.03) az += 2000 * Math.exp(-(t - t0) * 150) * Math.sin(2 * Math.PI * 400 * (t - t0))
  }
  az += (Math.random() * 2 - 1) * 5              // ruído
  const ax = 30 * Math.sin(2 * Math.PI * 30 * t + 1) + (Math.random() * 2 - 1) * 5
  const ay = 80 * Math.sin(2 * Math.PI * 1.5 * t + 2) + (Math.random() * 2 - 1) * 5
  x.push(Math.round(ax / sens)); y.push(Math.round(ay / sens)); z.push(Math.round(az / sens))
}

const r = processRaw({ x, y, z, fs, sens, ovr: 0, scale: 4, clip: 0 })

console.log('== decomposição da embarcação sintética ==')
console.log(`|g| = ${r.gmag} (esperado ~1.0) · inclinação ${r.tilt}° · eixo dominante ${'XYZ'[r.dom]}`)
console.log(`movimento: RMS ${r.motion.rms} mg (esperado ~${(250 / Math.SQRT2).toFixed(0)}) · pico ${r.motion.peak} mg`)
console.log(`impactos: ${r.impacts.n} blocos (esperado ~2) · pico ${r.impacts.peak} g (esperado ~2)`)
console.log(`máquina: RMS velocidade ${r.viso} mm/s (esperado ~1.9: 50mg@30Hz + 20mg@60Hz)`)
console.log(`qualidade: ${r.quality} (esperado ~0.88 = 14/16 blocos limpos)`)
const df = fs / 512
const peaks = [...r.fft.entries()].filter(([i, v]) => i > 2 && v > 10)
  .sort((a, b) => b[1] - a[1]).slice(0, 4)
  .map(([i, v]) => `${(i * df).toFixed(0)} Hz: ${v.toFixed(0)} mg`)
console.log('picos do espectro máquina (esperado 30 Hz ~50 · 60 Hz ~20):', peaks.join(' | '))

// veredito automático
const ok =
  Math.abs(r.gmag - 1.0) < 0.08 &&
  Math.abs(r.motion.rms - 176) < 60 &&
  r.impacts.n >= 1 && r.impacts.n <= 4 &&
  r.impacts.peak > 0.8 &&
  Math.abs(r.viso - 1.9) < 0.7
console.log(ok ? '\nVEREDITO: SEPAROU ✓' : '\nVEREDITO: FALHOU ✗')
process.exit(ok ? 0 : 1)
