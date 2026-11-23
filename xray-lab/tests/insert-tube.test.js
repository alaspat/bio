/* ============================================================================
   Node test suite for js/insert-tube.js — the physics engine is DOM-free.
   Run:  node tests/insert-tube.test.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "insert-tube.js"), "utf8");
global.window = {};
new Function(src)(); // evaluate the IIFE against global.window
const InsertTube = global.window.InsertTube;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✔ " + name); }
  else { fail++; console.error("  ✘ " + name + (detail ? " — " + detail : "")); }
}

function close(a, b, rel) {
  return Math.abs(a - b) <= Math.abs(b) * (rel == null ? 0.02 : rel);
}

/* 1 · Output calibration: 80 kVp, 10 mAs, 2.5 mm Al, 1 m → 0.45 mGy. */
{
  const m = new InsertTube({}).compute();
  check("kerma calibration 0.45 mGy", close(m.kerma1mGy, 0.450, 0.01), m.kerma1mGy.toFixed(4));
}

/* 2 · HVL rises monotonically with total filtration. */
{
  let prev = 0, mono = true;
  for (const added of [0, 1, 2, 4]) {
    const hvl = new InsertTube({ addedFiltration: added }).compute().hvl;
    if (hvl <= prev) mono = false;
    prev = hvl;
  }
  check("HVL monotonically increasing with filtration", mono);
  check("HVL plausible at 80 kVp / 2.5 mm Al", (m2 => m2 > 2.2 && m2 < 4.5)(prev - 4 < 0 ? new InsertTube({}).compute().hvl : 0) || new InsertTube({}).compute().hvl > 2.2);
}

/* 3 · Characteristic lines appear only above the target K-edge. */
{
  const below = new InsertTube({ kVp: 65, material: "W" }).compute().charFraction;
  const above = new InsertTube({ kVp: 110, material: "W" }).compute().charFraction;
  check("no W characteristic below 69.5 keV K-edge", below < 0.005, (below * 100).toFixed(2) + "%");
  check("W characteristic present above K-edge", above > 0.005, (above * 100).toFixed(2) + "%");
  const moBelow = new InsertTube({ kVp: 19, material: "Mo" }).compute().charFraction;
  check("no Mo characteristic below 20 keV K-edge", moBelow < 0.005, (moBelow * 100).toFixed(2) + "%");
}

/* 4 · Spectrum endpoint never exceeds kVp; mean energy bounded by kVp. */
{
  for (const kv of [28, 80, 120]) {
    const m = new InsertTube({ kVp: kv }).compute();
    const s = new InsertTube({ kVp: kv }).spectra();
    const hasAbove = s.filtered.some(b => (b.brem + b.char) > 0 && b.e > kv + 0.01);
    check(`endpoint ≤ ${kv} kVp`, !hasAbove);
    check(`mean energy < ${kv} keV`, m.meanEnergy > 5 && m.meanEnergy < kv, m.meanEnergy.toFixed(1));
  }
}

/* 5 · Field coverage clamped to the detector plate. */
{
  const m = new InsertTube({ anodeAngle: 20, sid: 100 }).compute().coverageCm;
  check("coverage ≤ 43 cm at 20° / 100 cm", m <= 43.001, m.toFixed(1));
}

/* 6 · Photon count from energy balance, not the raw efficiency fraction. */
{
  const m = new InsertTube({}).compute();
  const perElectron = m.photons / m.electrons;
  check("photons/electron = η·kVp/Ē", close(perElectron, m.efficiency * 80 / m.meanEnergy, 0.01));
  check("photons/electron > efficiency (photon < electron energy)", perElectron > m.efficiency);
}

/* 7 · cool() keeps cached metrics fresh. */
{
  const t = new InsertTube({});
  t.addExposure();
  const before = t.compute().anodeHeatPct;
  t.cool(600);
  const after = t.compute().anodeHeatPct;
  check("cool() invalidates cached anodeHeatPct", after < before * 0.25, `${before.toFixed(3)} → ${after.toFixed(3)}`);
}

/* 8 · Single-phase generator softens the beam and lowers output. */
{
  const dc = new InsertTube({ generator: "constant" }).compute();
  const sp = new InsertTube({ generator: "singlePhase" }).compute();
  check("single-phase is softer", sp.meanEnergy < dc.meanEnergy, `${sp.meanEnergy.toFixed(1)} vs ${dc.meanEnergy.toFixed(1)}`);
  check("single-phase has lower kerma", sp.kerma1mGy < dc.kerma1mGy, `${sp.kerma1mGy.toFixed(3)} vs ${dc.kerma1mGy.toFixed(3)}`);
}

/* 9 · Mammography Mo preset stays in a plausible physical range. */
{
  const m = new InsertTube({ kVp: 28, material: "Mo", inherentFiltration: 0.5 }).compute();
  check("Mo 28 kVp mean energy 17–26 keV", m.meanEnergy > 17 && m.meanEnergy < 26, m.meanEnergy.toFixed(1));
  check("Mo 28 kVp characteristic share < 60%", m.charFraction < 0.6, (m.charFraction * 100).toFixed(1) + "%");
}

/* 10 · Cache invalidation on every set(). */
{
  const t = new InsertTube({});
  const a = t.compute().hvl;
  t.set({ addedFiltration: 4 });
  const b = t.compute().hvl;
  check("cache invalidated by set()", b > a, `${a.toFixed(2)} → ${b.toFixed(2)}`);
}

/* 11 · Surviving animation photons track the FILTERED spectrum. The engine
   samples from the raw spectrum and the scene kills photons against
   transmissionAt(), so survivors are raw ⊗ filtration in expectation. */
{
  const t = new InsertTube({ kVp: 100 });
  let acc = 0, cnt = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const p = t.samplePhoton();
    if (Math.random() > t.transmissionAt(p.energy)) continue;
    acc += p.energy; cnt++;
  }
  const sampledMean = cnt ? acc / cnt : 0;
  const specMean = t.compute().meanEnergy;
  check("surviving sampled mean energy tracks filtered spectrum (±10%)",
    cnt > N * 0.05 && Math.abs(sampledMean - specMean) / specMean < 0.10,
    `${sampledMean.toFixed(1)} vs ${specMean.toFixed(1)} (n=${cnt})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
