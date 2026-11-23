/* ============================================================================
   X-Ray Tube Lab — interface, charts, phantom renderer and tube animation
   ========================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function fmt(value, digits) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    });
  }

  function sci(value) {
    if (!isFinite(value) || value <= 0) return "0";
    var exp = Math.floor(Math.log10(value));
    var mant = value / Math.pow(10, exp);
    if (mant >= 9.995) { mant /= 10; exp += 1; }
    return mant.toFixed(2) + " × 10<sup>" + exp + "</sup>";
  }

  function fmtKerma(value) {
    if (value <= 0) return "0";
    if (value < 0.001) return value.toPrecision(2);
    if (value < 0.01) return value.toFixed(4);
    if (value < 1) return value.toFixed(3);
    if (value < 100) return value.toFixed(2);
    return value.toFixed(0);
  }

  /* ------------------------------------------------------------------ presets */
  var PRESETS = {
    chest: {
      label: "Chest PA",
      params: {
        kVp: 120, mA: 250, exposureTime: 0.01, material: "W", anodeAngle: 12,
        focalSpot: 1.2, inherentFiltration: 2.5, addedFiltration: 0.5,
        sid: 180, oid: 0, generator: "highFrequency"
      }
    },
    abdomen: {
      label: "Abdomen AP",
      params: {
        kVp: 80, mA: 200, exposureTime: 0.1, material: "W", anodeAngle: 12,
        focalSpot: 1.2, inherentFiltration: 2.5, addedFiltration: 0.5,
        sid: 100, oid: 0, generator: "highFrequency"
      }
    },
    extremity: {
      label: "Extremity",
      params: {
        kVp: 60, mA: 100, exposureTime: 0.03, material: "W", anodeAngle: 12,
        focalSpot: 0.6, inherentFiltration: 2.5, addedFiltration: 0.5,
        sid: 100, oid: 0, generator: "highFrequency"
      }
    },
    mammo: {
      label: "Mammography",
      params: {
        kVp: 28, mA: 100, exposureTime: 0.4, material: "Mo", anodeAngle: 12,
        focalSpot: 0.3, inherentFiltration: 0.5, addedFiltration: 0.2,
        sid: 65, oid: 0, generator: "highFrequency"
      }
    },
    ct: {
      label: "CT rotation",
      params: {
        kVp: 120, mA: 250, exposureTime: 0.5, material: "W", anodeAngle: 12,
        focalSpot: 1.2, inherentFiltration: 2.5, addedFiltration: 1.0,
        sid: 100, oid: 0, generator: "constant"
      }
    },
    fluoro: {
      label: "Fluoroscopy",
      params: {
        kVp: 75, mA: 3, exposureTime: 0.05, material: "W", anodeAngle: 12,
        focalSpot: 0.6, inherentFiltration: 2.5, addedFiltration: 0.5,
        sid: 90, oid: 0, generator: "highFrequency"
      }
    }
  };

  /* -------------------------------------------------------------------- parts */
  var PARTS = {
    filament: {
      n: 1, text: "Filament — a tungsten coil heated by a filament current. Electrons escape by thermionic emission; the filament temperature sets the tube current (mA)."
    },
    cup: {
      n: 2, text: "Focusing cup — a negatively biased metal cup that repels the electron cloud into a narrow beam aimed at the focal spot."
    },
    envelope: {
      n: 3, text: "Glass envelope — evacuated so electrons can travel from cathode to anode without colliding with gas molecules."
    },
    anode: {
      n: 4, text: "Anode and focal spot — the tungsten target track where electrons decelerate. Bremsstrahlung and characteristic X-rays are created here, along with more than 99% of the energy as heat."
    },
    window: {
      n: 5, text: "Window and filtration — the beam leaves the vacuum through the window, then passes inherent and added aluminium filtration that absorbs soft photons."
    },
    collimator: {
      n: 6, text: "Collimator — lead blades that shape the useful beam, limiting field size, scatter and patient dose."
    },
    patient: {
      n: 7, text: "Patient — the attenuating object. Bone, soft tissue, lung and air remove different numbers of photons, and that differential absorption is what becomes image contrast."
    },
    detector: {
      n: 8, text: "Detector — converts photons into signal. Their number sets noise, their energy set contrast, and the focal spot plus distances set sharpness."
    }
  };

  var DEFAULT_PART_TEXT = "Hover or tap a numbered part to identify it. The animation runs in slow motion.";

  /* -------------------------------------------------------------------- steps */
  var STEPS = [
    {
      title: "Filament heating",
      sub: "Thermionic emission",
      tag: "Electron source",
      h3: "Filament heating and thermionic emission",
      lede: "A low-voltage supply drives current through the tungsten filament, heating it to roughly 2,400 °C. At that temperature electrons gain enough thermal energy to escape the metal surface.",
      more: "Emission is extremely temperature-sensitive, so the generator regulates filament current to hold the selected mA. The filament sits inside a negatively charged cup that begins shaping the electron beam.",
      formula: "J = A·T²·e<sup>−W/kT</sup><br>Richardson–Dushman: emission rises steeply with temperature",
      value: function (m) { return m.mA + " mA · " + fmt(Math.round(m.filamentTempC)) + " °C"; },
      values: function (m) {
        return [
          ["Tube current", m.mA + " mA"],
          ["Filament temperature", fmt(Math.round(m.filamentTempC)) + " °C"],
          ["Charge per exposure", m.mAs.toFixed(2) + " mAs"],
          ["Electrons per exposure", sci(m.electrons)]
        ];
      }
    },
    {
      title: "Electron focusing",
      sub: "Space charge",
      tag: "Beam formation",
      h3: "Focusing cup and space-charge limitation",
      lede: "The cup's negative potential repels electrons away from its walls and converges them onto the focal spot. Their mutual repulsion — space charge — competes with that focusing force.",
      more: "At high mA the electron cloud expands and the focal spot blooms, softening the image. The line-focus principle lets a large actual focal area project a much smaller effective spot.",
      formula: "Child–Langmuir: J ∝ V<sup>3/2</sup>/d²<br>Space charge limits the focusable current",
      value: function (m) { return m.effectiveFocal.toFixed(2) + " mm effective focus"; },
      values: function (m) {
        return [
          ["Nominal focal spot", m.focalSpot.toFixed(1) + " mm"],
          ["Anode angle", m.anodeAngle + "°"],
          ["Effective focal spot", m.effectiveFocal.toFixed(2) + " mm"],
          ["Field coverage", Math.round(m.coverageCm) + " cm"]
        ];
      }
    },
    {
      title: "Acceleration",
      sub: "kV sets energy",
      tag: "High voltage",
      h3: "Electrostatic acceleration by the kilovoltage",
      lede: "The high voltage between cathode and anode accelerates each electron. An electron crossing 80 kV gains 80 keV of kinetic energy — the ceiling for any photon it can create.",
      more: "The electrons reach a substantial fraction of light speed: about 50% c at 80 kVp. The kVp therefore fixes the endpoint of the spectrum, while the generator waveform decides how much of the cycle sits below that peak.",
      formula: "E<sub>max</sub> = e·V<sub>p</sub><br>v/c = √(1 − (1 + K/511)<sup>−2</sup>)",
      value: function (m) { return m.kVp + " keV · " + Math.round(m.electronSpeedC * 100) + "% c"; },
      values: function (m) {
        return [
          ["Peak voltage", m.kVp + " kVp"],
          ["Kinetic energy", m.kVp + " keV"],
          ["Electron speed", (m.electronSpeedC * 100).toFixed(0) + "% of c"],
          ["Instantaneous power", m.powerKW.toFixed(1) + " kW"]
        ];
      }
    },
    {
      title: "Bremsstrahlung",
      sub: "Continuous spectrum",
      tag: "Target interaction",
      h3: "Bremsstrahlung: braking radiation",
      lede: "Electrons passing near target nuclei are deflected and decelerated. The lost energy appears as photons with a continuous spread of energies up to E_max.",
      more: "Each electron loses a different fraction of its energy, so the spectrum is continuous. Soft photons are far more numerous; most are removed by filtration before they reach the patient.",
      formula: "N(E) ∝ Z·(E<sub>max</sub> − E)/E<br>Kramers' approximation for a thick target",
      value: function (m) { return (m.bremFraction * 100).toFixed(1) + "% of photons"; },
      values: function (m) {
        return [
          ["Bremsstrahlung share", (m.bremFraction * 100).toFixed(1) + "%"],
          ["Maximum energy", m.kVp + " keV"],
          ["Mean energy", m.meanEnergy.toFixed(1) + " keV"],
          ["X-ray conversion", (m.efficiency * 100).toFixed(2) + "%"]
        ];
      }
    },
    {
      title: "Characteristic lines",
      sub: "Inner-shell ionisation",
      tag: "Target interaction",
      h3: "Characteristic radiation and the K-edge",
      lede: "If an incident electron ejects a K-shell electron, an outer electron drops into the vacancy and emits a photon whose energy is unique to the target element.",
      more: "These sharp lines appear only when kVp exceeds the target's K-edge: 69.5 keV for tungsten, 20.0 keV for molybdenum. Below the K-edge the spectrum is pure bremsstrahlung.",
      formula: "E<sub>photon</sub> = E<sub>K</sub> − E<sub>L</sub> = hc/λ<br>Kα (W) = 59.3 keV · Kα (Mo) = 17.5 keV",
      value: function (m) {
        return m.material.lines[0].energy.toFixed(1) + " keV Kα · " + (m.charFraction * 100).toFixed(1) + "%";
      },
      values: function (m) {
        return [
          ["Target", m.material.name + " (Z " + m.material.z + ")"],
          ["K-edge", m.material.kEdge.toFixed(1) + " keV"],
          ["Characteristic share", (m.charFraction * 100).toFixed(1) + "%"],
          ["Strongest line", m.material.lines[0].name + " " + m.material.lines[0].energy.toFixed(1) + " keV"]
        ];
      }
    },
    {
      title: "Heat load",
      sub: "Focal-track heating",
      tag: "Thermal management",
      h3: "More than 99% of the energy becomes heat",
      lede: "Only a small fraction of electron energy leaves as X-rays. The rest is deposited in the focal track, where the target must conduct it away without melting.",
      more: "A rotating anode spreads the load around a circular track. The anode stores heat and radiates it away through the housing; too many exposures too quickly overheat the tube.",
      formula: "Heat ≈ kVp × mAs (J)<br>HU ≈ 1.4 × kVp × mAs",
      value: function (m) { return fmt(Math.round(m.heatJ)) + " J / shot"; },
      values: function (m) {
        return [
          ["Heat per exposure", fmt(Math.round(m.heatJ)) + " J"],
          ["Heat units", fmt(Math.round(m.hu)) + " HU"],
          ["X-ray conversion", (m.efficiency * 100).toFixed(2) + "%"],
          ["Anode load", (tube.anodeHeatFraction() * 100).toFixed(2) + "%"]
        ];
      }
    },
    {
      title: "Filtration",
      sub: "Beam hardening",
      tag: "Beam conditioning",
      h3: "Filtration, collimation and beam hardening",
      lede: "The beam leaves through the glass envelope, insulating oil and window, then any added aluminium. These materials absorb low-energy photons that would add dose without helping the image.",
      more: "Filtration hardens the beam: mean energy and HVL rise while the photon count falls. Collimators then shape the field and reduce scatter, at the cost of a smaller image area.",
      formula: "I = I₀·e<sup>−μx</sup><br>HVL = ln2 / μ",
      value: function (m) { return m.totalFiltration.toFixed(1) + " mm Al · HVL " + m.hvl.toFixed(2); },
      values: function (m) {
        return [
          ["Inherent filtration", m.inherentFiltration.toFixed(1) + " mm Al"],
          ["Added filtration", m.addedFiltration.toFixed(1) + " mm Al"],
          ["Total filtration", m.totalFiltration.toFixed(1) + " mm Al"],
          ["Half-value layer", m.hvl.toFixed(2) + " mm Al"]
        ];
      }
    },
    {
      title: "Detection",
      sub: "Image formation",
      tag: "Imaging",
      h3: "From photons to an image",
      lede: "Photons that exit the window pass the collimator and reach the detector. Their number sets noise, their energies set contrast, and the focal spot plus distances set sharpness.",
      more: "mAs controls quantity and kVp controls quality. Noise falls as 1/√N, so quadrupling mAs halves the noise. Intensity follows the inverse-square law with distance.",
      formula: "I ∝ mAs·kVp² / d²<br>σ ∝ 1/√N, N ∝ mAs",
      value: function (m) { return fmtKerma(m.kerma1mGy) + " mGy @ 1 m"; },
      values: function (m) {
        return [
          ["Air kerma @ 1 m", fmtKerma(m.kerma1mGy) + " mGy"],
          ["At the detector", fmtKerma(m.kerma1mGy * Math.pow(100 / m.sid, 2)) + " mGy"],
          ["Geometric blur", m.unsharpness.toFixed(2) + " mm"],
          ["Quantum noise", (m.noiseSigma * 100).toFixed(1) + "%"]
        ];
      }
    }
  ];

  /* ----------------------------------------------------------------- insights */
  var INSIGHTS = {
    kVp: function (m) {
      return "At " + m.kVp + " kVp the spectrum ends at " + m.kVp + " keV. Raising kVp hardens the beam: more output and penetration, but lower subject contrast and more heat.";
    },
    mA: function (m) {
      return m.mA + " mA changes quantity only: photon count, dose and heat rise together while the spectrum keeps its shape.";
    },
    exposureTime: function (m) {
      return m.time.toFixed(2) + " s at " + m.mA + " mA gives " + m.mAs.toFixed(2) + " mAs. Time adds photons without changing their energies.";
    },
    material: function (m) {
      return m.material.name + " (Z = " + m.material.z + ") sets the bremsstrahlung yield and the characteristic lines. Its K-edge is " + m.material.kEdge.toFixed(1) + " keV.";
    },
    anodeAngle: function (m) {
      return m.anodeAngle + "° projects a " + m.effectiveFocal.toFixed(2) + " mm effective focal spot and limits coverage to about " + Math.round(m.coverageCm) + " cm.";
    },
    focalSpot: function (m) {
      return "A " + m.focalSpot.toFixed(1) + " mm nominal focus projects to " + m.effectiveFocal.toFixed(2) + " mm at " + m.anodeAngle + "°. A smaller focus sharpens detail but concentrates heat.";
    },
    inherentFiltration: function (m) {
      return "Total filtration is " + m.totalFiltration.toFixed(1) + " mm Al, giving an HVL of " + m.hvl.toFixed(2) + " mm Al. More filtration removes soft photons and hardens the beam.";
    },
    addedFiltration: function (m) {
      return "Added aluminium brings total filtration to " + m.totalFiltration.toFixed(1) + " mm Al. The beam hardens (HVL " + m.hvl.toFixed(2) + " mm Al) but fewer photons reach the detector.";
    },
    sid: function (m) {
      return "At " + m.sid + " cm the detector sees " + (Math.pow(100 / m.sid, 2) * 100).toFixed(0) + "% of the intensity it would see at 1 m — the inverse-square law.";
    },
    oid: function (m) {
      if (m.oid === 0) return "With no object–image distance there is no magnification and no geometric blur.";
      return "At " + m.oid + " cm OID the image is magnified " + m.magnification.toFixed(2) + "× and geometric blur is " + m.unsharpness.toFixed(2) + " mm.";
    },
    generator: function (m) {
      return m.generator.name + " (ripple " + m.generator.ripple + "): " + m.generator.note;
    }
  };

  /* ------------------------------------------------------------------ controls */
  var CONTROLS = [
    { id: "mA", key: "mA", out: "mAOut", log: [1, 500, 0], fmt: function (v) { return Math.round(v) + " mA"; }, hint: "Filament temperature sets how many electrons leave the cathode each second." },
    { id: "time", key: "exposureTime", out: "timeOut", log: [0.01, 1.2, 2], fmt: function (v) { return v.toFixed(2) + " s"; }, hint: "mA × seconds = mAs, the total charge per exposure." },
    { id: "kVp", key: "kVp", out: "kVpOut", fmt: function (v) { return Math.round(v) + " kVp"; }, hint: "Sets electron kinetic energy and therefore the maximum photon energy." },
    { id: "anodeAngle", key: "anodeAngle", out: "anodeAngleOut", fmt: function (v) { return Math.round(v) + "°"; }, hint: "A shallow angle shrinks the projected focal spot but narrows the field." },
    { id: "focalSpot", key: "focalSpot", out: "focalSpotOut", fmt: function (v) { return v.toFixed(1) + " mm"; }, hint: "A smaller focus sharpens detail but concentrates heat." },
    { id: "inherentFiltration", key: "inherentFiltration", out: "inherentFiltrationOut", fmt: function (v) { return v.toFixed(1) + " mm"; }, hint: "Glass envelope, insulating oil and the tube window." },
    { id: "addedFiltration", key: "addedFiltration", out: "addedFiltrationOut", fmt: function (v) { return v.toFixed(1) + " mm"; }, hint: "Extra aluminium removes soft photons: lower dose, harder beam." },
    { id: "sid", key: "sid", out: "sidOut", fmt: function (v) { return Math.round(v) + " cm"; }, hint: "Intensity falls with the inverse square of distance." },
    { id: "oid", key: "oid", out: "oidOut", fmt: function (v) { return Math.round(v) + " cm"; }, hint: "Lifting the object magnifies it and blurs its edges." }
  ];

  var tube = new InsertTube();
  var scene = null;
  var state = {
    beamOn: false,
    exposing: false,
    exposureTotal: 0,
    exposureRemain: 0,
    lastShot: null,
    view: "3d",
    selectedStep: 0,
    activePart: null,
    pinned: null,
    hoverEnergy: null,
    m: null,
    maps: null,
    burst: 0,
    toastTimer: null
  };

  var sim = {
    electrons: [],
    photons: [],
    sparks: [],
    emissionAcc: 0,
    spin: 0,
    lastHeatUpdate: 0
  };

  /* ------------------------------------------------------------------ helpers */
  function readControl(def) {
    var input = $(def.id);
    if (!def.log) return Number(input.value);
    var lo = def.log[0];
    var hi = def.log[1];
    var digits = def.log[2];
    var t = Number(input.value) / 1000;
    var raw = lo * Math.pow(hi / lo, t);
    return digits ? Number(raw.toFixed(digits)) : Math.round(raw);
  }

  function paintRange(input) {
    var min = Number(input.min);
    var max = Number(input.max);
    var value = Number(input.value);
    var pct = ((value - min) / (max - min)) * 100;
    input.style.setProperty("--fill", pct + "%");
  }

  function writeControl(def, value) {
    var input = $(def.id);
    if (def.log) {
      var pos = 1000 * Math.log(value / def.log[0]) / Math.log(def.log[1] / def.log[0]);
      input.value = String(Math.round(clamp(pos, 0, 1000)));
    } else {
      input.value = String(value);
    }
    paintRange(input);
    $(def.out).textContent = def.fmt(value);
  }

  function syncControls() {
    var m = tube.compute();
    CONTROLS.forEach(function (def) {
      var value = def.key === "exposureTime" ? tube.p.exposureTime : tube.p[def.key];
      writeControl(def, value);
    });
    $("material").value = tube.p.material;
    $("generator").value = tube.p.generator;
    $("materialZ").textContent = "Z = " + m.material.z;
    $("material").title = m.material.blurb;
    $("generator").title = m.generator.note;
  }

  function markPreset(name) {
    Array.prototype.forEach.call(document.querySelectorAll("#presetChips button"), function (btn) {
      btn.classList.toggle("is-active", btn.dataset.preset === name);
    });
  }

  function updateInsight(key, m) {
    var fn = INSIGHTS[key];
    if (fn) $("insightText").textContent = fn(m);
  }

  /* ------------------------------------------------------------------- stats */
  function updateStats(m) {
    $("statKerma").textContent = fmtKerma(m.kerma1mGy);
    $("statHvl").textContent = m.hvl.toFixed(2);
    $("statMas").textContent = m.mAs < 1 ? m.mAs.toFixed(2) : m.mAs.toFixed(1);
    $("statHeat").textContent = fmt(Math.round(m.heatJ));
    $("headerHeat").textContent = (tube.anodeHeatFraction() * 100).toFixed(1) + "%";
    var sessionMg = tube.sessionKermaGy * 1000;
    $("headerDose").textContent = sessionMg.toFixed(sessionMg < 0.01 ? 3 : 2) + " mGy";
  }

  function updateMetrics(m) {
    $("mElectrons").innerHTML = sci(m.electrons);
    $("mPhotons").innerHTML = sci(m.photons);
    $("mMean").textContent = m.meanEnergy.toFixed(1) + " keV";
    $("mMax").textContent = m.kVp + " keV";
    $("mChar").textContent = (m.charFraction * 100).toFixed(1) + "%";
    $("mFilt").textContent = m.totalFiltration.toFixed(1) + " mm Al";
    $("mFocal").textContent = m.effectiveFocal.toFixed(2) + " mm";
    $("mBlur").textContent = m.unsharpness.toFixed(2) + " mm";
    $("mCoverage").textContent = Math.round(m.coverageCm) + " cm";
    $("mEff").textContent = (m.efficiency * 100).toFixed(2) + "%";
    $("mContrast").textContent = m.contrastRatio.toFixed(1) + "×";
    $("mNoise").textContent = (m.noiseSigma * 100).toFixed(1) + "%";
  }

  function updateStageTags(m) {
    $("stageKVp").textContent = m.kVp + " kVp";
    $("stageCurrent").textContent = m.mA + " mA";
    $("stageMode").textContent = state.beamOn ? "Exposing" : "Standby";
  }

  function updateHeat() {
    var frac = tube.anodeHeatFraction();
    var pct = frac * 100;
    $("heatFill").style.width = Math.max(0.6, pct) + "%";
    $("heatFill").classList.toggle("danger", frac > 0.8);
    $("heatValue").textContent = pct.toFixed(1) + "% · " + fmt(Math.round(tube.anodeHeatJ)) + " J";
    $("heatShots").textContent = tube.exposureCount + (tube.exposureCount === 1 ? " exposure" : " exposures");
    $("headerHeat").textContent = pct.toFixed(1) + "%";
    var sessionMg = tube.sessionKermaGy * 1000;
    $("headerDose").textContent = sessionMg.toFixed(sessionMg < 0.01 ? 3 : 2) + " mGy";
  }

  /* ------------------------------------------------------------------- chart */
  function drawSpectrum(m) {
    var canvas = $("spectrumCanvas");
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = Math.round(rect.width * dpr);
    var ch = Math.round(rect.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    var W = rect.width;
    var H = rect.height;
    var pad = { l: 38, r: 12, t: 16, b: 34 };
    var pw = W - pad.l - pad.r;
    var ph = H - pad.t - pad.b;
    state.chartGeom = { pad: pad, pw: pw, ph: ph, W: W, H: H, xMax: xMax };

    var spec = tube.spectra();
    var bins = spec.filtered;
    var pinned = state.pinned;
    var yMax = spec.maxFiltered * 1.08;
    if (!(yMax > 0)) yMax = 1;
    var pinnedScale = pinned && pinned.max > 0 ? spec.maxFiltered / pinned.max : 1;
    /* Dynamic axis: round the widest kVp (current or pinned) up to a multiple
       of 30 so a 28 kVp mammography spectrum no longer shares a chart with
       120 keV of empty space, while pinned A/B comparisons stay aligned. */
    var pinnedKvp = pinned && pinned.kVp ? pinned.kVp : 0;
    var xMax = Math.max(30, Math.ceil(Math.max(tube.p.kVp, pinnedKvp) / 30) * 30);

    function X(e) { return pad.l + (e / xMax) * pw; }
    function Y(v) { return pad.t + ph - (v / yMax) * ph; }

    /* grid */
    ctx.strokeStyle = "rgba(120, 180, 220, 0.09)";
    ctx.lineWidth = 1;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = "#5b7487";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var y = pad.t + ph - t * ph;
      ctx.beginPath();
      ctx.moveTo(pad.l, y + 0.5);
      ctx.lineTo(pad.l + pw, y + 0.5);
      ctx.stroke();
      ctx.fillText(Math.round(t * 100) + "%", pad.l - 6, y);
    });

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (var e = 0; e <= xMax; e += 30) {
      var x = X(e);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, pad.t);
      ctx.lineTo(x + 0.5, pad.t + ph);
      ctx.stroke();
      if (e > 0 || true) ctx.fillText(String(e), x, pad.t + ph + 6);
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "#587184";
    ctx.font = '8.5px "Cascadia Mono", Consolas, monospace';
    ctx.fillText("relative fluence", pad.l, 2);
    ctx.textAlign = "center";
    ctx.fillText("photon energy (keV)", pad.l + pw / 2, H - 8);

    function areaPath(source, mode) {
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < source.length; i++) {
        var b = source[i];
        if (b.e < 2) continue;
        var v = mode === "char" ? b.char : (b.brem + b.char);
        if (!started) { ctx.moveTo(X(b.e), Y(v)); started = true; }
        else ctx.lineTo(X(b.e), Y(v));
      }
      if (!started) return false;
      ctx.lineTo(X(source[source.length - 1].e), Y(0));
      ctx.lineTo(X(source[0].e), Y(0));
      ctx.closePath();
      return true;
    }

    /* total spectrum fill */
    var fill = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    fill.addColorStop(0, "rgba(70, 217, 255, 0.30)");
    fill.addColorStop(0.65, "rgba(70, 217, 255, 0.10)");
    fill.addColorStop(1, "rgba(70, 217, 255, 0.01)");
    if (areaPath(bins, "total")) {
      ctx.fillStyle = fill;
      ctx.fill();
    }

    /* characteristic contribution */
    ctx.save();
    if (areaPath(bins, "char")) {
      ctx.fillStyle = "rgba(181, 140, 255, 0.55)";
      ctx.fill();
    }
    ctx.restore();

    /* outline */
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < bins.length; i++) {
      var b = bins[i];
      if (b.e < 2) continue;
      var x = X(b.e);
      var y = Y(b.brem + b.char);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#63e2ff";
    ctx.lineWidth = 1.7;
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(70, 217, 255, 0.55)";
    ctx.shadowBlur = 7;
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* pinned curve */
    if (pinned) {
      ctx.beginPath();
      var ps = false;
      for (var j = 0; j < pinned.bins.length; j++) {
        var pb = pinned.bins[j];
        var px = X(pb.e);
        var py = Y((pb.brem + pb.char) * pinnedScale);
        if (!ps) { ctx.moveTo(px, py); ps = true; }
        else ctx.lineTo(px, py);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "rgba(255, 178, 87, 0.85)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* markers */
    var kx = X(m.kVp);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = "rgba(200, 240, 255, 0.32)";
    ctx.beginPath();
    ctx.moveTo(kx, pad.t);
    ctx.lineTo(kx, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9fc4d8";
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = m.kVp > 128 ? "right" : "left";
    ctx.textBaseline = "top";
    ctx.fillText(m.kVp + " kVp", kx + (m.kVp > 128 ? -4 : 4), pad.t + 1);

    var mx = X(m.meanEnergy);
    ctx.setLineDash([1, 3]);
    ctx.strokeStyle = "rgba(160, 255, 235, 0.5)";
    ctx.beginPath();
    ctx.moveTo(mx, pad.t + ph - 6);
    ctx.lineTo(mx, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#7fe8d2";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Ē " + m.meanEnergy.toFixed(0), mx, pad.t + ph - 7);

    /* characteristic line label */
    var line = m.material.lines[0];
    if (m.kVp > m.material.kEdge + 1) {
      var lx = X(line.energy);
      var ly = Y(spec.maxFiltered * 0.35);
      var labelY = clamp(ly, pad.t + 12, pad.t + ph - 40);
      ctx.strokeStyle = "rgba(181, 140, 255, 0.35)";
      ctx.beginPath();
      ctx.moveTo(lx, labelY + 12);
      ctx.lineTo(lx, pad.t + ph);
      ctx.stroke();
      ctx.fillStyle = "#cbb1ff";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("Kα " + line.energy.toFixed(1), lx, labelY);
    }

    if (pinned) {
      ctx.fillStyle = "rgba(255, 178, 87, 0.9)";
      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("pinned " + pinned.label, W - pad.r, pad.t - 2);
    }

    /* hover */
    if (state.hoverEnergy !== null && state.hoverEnergy >= 0 && state.hoverEnergy <= xMax) {
      var hx = X(state.hoverEnergy);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.beginPath();
      ctx.moveTo(hx, pad.t);
      ctx.lineTo(hx, pad.t + ph);
      ctx.stroke();

      var nearest = bins[0];
      var best = Infinity;
      for (var k = 0; k < bins.length; k++) {
        var d = Math.abs(bins[k].e - state.hoverEnergy);
        if (d < best) { best = d; nearest = bins[k]; }
      }
      var hv = nearest.brem + nearest.char;
      var hy = Y(hv);
      ctx.fillStyle = "#eafcff";
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4, 0, TAU);
      ctx.fill();

      var txt = nearest.e.toFixed(0) + " keV · " + Math.round((hv / (spec.maxFiltered || 1)) * 100) + "%";
      ctx.font = '9.5px "Cascadia Mono", Consolas, monospace';
      var tw = ctx.measureText(txt).width + 12;
      var tx = clamp(hx - tw / 2, pad.l, W - pad.r - tw);
      var ty = clamp(hy - 26, pad.t, pad.t + ph - 18);
      ctx.fillStyle = "rgba(5, 14, 20, 0.92)";
      ctx.strokeStyle = "rgba(70, 217, 255, 0.35)";
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(tx, ty, tw, 17, 5) : ctx.rect(tx, ty, tw, 17);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#c9f4ff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, tx + 6, ty + 9);
      $("chartHover").textContent = txt;
    } else {
      $("chartHover").textContent = "Hover or drag for energy";
    }
  }

  /* ------------------------------------------------------------------- image */
  function rounded(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildPhantomMaps() {
    var thickness = tube.p.bodyThickness || 24;
    if (!state.maps || state.maps.bodyCm !== thickness) {
      state.maps = window.ChestPhantom.buildMaps(thickness);
    }
    return state.maps;
  }

  /* The detector is dark until an exposure is triggered: captureImage() runs the
     physically based ChestPhantom using the parameters in force at that instant,
     and drawShot() merely re-blits the stored radiograph (so nothing changes
     when the sliders move — only a fresh Expose updates it). */
  function drawEmptyImage() {
    var canvas = $("imageCanvas");
    if (!canvas) return;
    if (canvas.width !== 600 || canvas.height !== 400) {
      canvas.width = 600;
      canvas.height = 400;
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05090d";
    ctx.fillRect(0, 0, 600, 400);
    ctx.strokeStyle = "rgba(70, 217, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(24.5, 24.5, 551, 351);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(160, 200, 225, 0.8)";
    ctx.font = '12px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No image yet", 300, 190);
    ctx.fillStyle = "rgba(115, 155, 180, 0.75)";
    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.fillText("Press ⚡ Expose to acquire a radiograph", 300, 212);
    if (scene) scene.setImage(null);
    $("imageTag").textContent = "—";
    $("imageNoise").textContent = "Noise σ —";
    $("imageBlur").textContent = "Blur —";
    $("imageContrast").textContent = "Contrast —";
  }

  function drawShot() {
    var shot = state.lastShot;
    var canvas = $("imageCanvas");
    if (!shot || !canvas) return;
    if (canvas.width !== 600 || canvas.height !== 400) {
      canvas.width = 600;
      canvas.height = 400;
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05090d";
    ctx.fillRect(0, 0, 600, 400);

    var iw = shot.width;
    var ih = shot.height;
    var scale = Math.min(600 / iw, 400 / ih);
    var dw = Math.round(iw * scale);
    var dh = Math.round(ih * scale);
    var dx = Math.round((600 - dw) / 2);
    var dy = Math.round((400 - dh) / 2);

    var off = document.createElement("canvas");
    off.width = iw;
    off.height = ih;
    var octx = off.getContext("2d");
    var img = octx.createImageData(iw, ih);
    var data = img.data;
    for (var i = 0; i < iw * ih; i++) {
      var g = shot.gray[i];
      var o = i * 4;
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, dx, dy, dw, dh);
    ctx.strokeStyle = "rgba(70, 217, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);

    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = "rgba(205, 240, 255, 0.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("PA chest phantom · " + shot.stats.pixelMm.toFixed(1) + " mm/px", dx + 8, dy + 7);
    ctx.textAlign = "right";
    ctx.fillText("magnification " + shot.stats.magnification.toFixed(2) + "×", dx + dw - 8, dy + 7);
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("scatter " + shot.stats.spr.toFixed(2) + " · heel drop " + Math.round(shot.stats.heelDrop * 100) + "%", dx + 8, dy + dh - 7);
  }

  function captureImage() {
    if (!window.ChestPhantom) return;
    /* Physically based capture: every pixel integrates the filtered spectrum
       over the projected material thicknesses of a PA chest phantom. */
    var shot = window.ChestPhantom.capture(tube, buildPhantomMaps());
    state.lastShot = shot;
    drawShot();
    if (scene) scene.setImage(shot);

    var m = tube.compute();
    $("imageTag").textContent = m.kVp + " kVp · " + m.material.symbol;
    $("imageNoise").textContent = "Noise σ " + (m.noiseSigma * 100).toFixed(1) + "%";
    $("imageBlur").textContent = "Blur " + m.unsharpness.toFixed(2) + " mm";
    $("imageContrast").textContent = "Contrast " + m.contrastRatio.toFixed(1) + "×";
  }

  /* ------------------------------------------------------------------ tube */
  function photonColor(energy, characteristic) {
    if (characteristic) return "#c9a6ff";
    if (energy < 20) return "#ff7a5c";
    if (energy < 35) return "#ffb066";
    if (energy < 55) return "#ffe08a";
    if (energy < 80) return "#c8f4ff";
    return "#eafcff";
  }

  function spawnElectron() {
    var e = {
      x0: 264,
      y0: 306 + (Math.random() - 0.5) * 8,
      x1: 721,
      y1: 306 + (Math.random() - 0.5) * 10,
      t: 0,
      dur: clamp(1.05 - state.m.kVp / 320, 0.5, 1.0),
      size: 1.4 + Math.random() * 0.8
    };
    sim.electrons.push(e);
    if (sim.electrons.length > 340) sim.electrons.shift();
  }

  function spawnPhoton(x, y) {
    var ph = tube.samplePhoton();
    var angle = (Math.random() - 0.5) * 1.28; // ±36.7°
    var speed = 290 + Math.random() * 90;
    sim.photons.push({
      x: x,
      y: y,
      vx: Math.sin(angle) * speed,
      vy: Math.cos(angle) * speed,
      energy: ph.energy,
      char: ph.characteristic,
      checked: false,
      life: 1
    });
    if (sim.photons.length > 420) sim.photons.shift();
  }

  function spark(x, y, color, size) {
    sim.sparks.push({ x: x, y: y, r: size || 2, life: 1, color: color });
    if (sim.sparks.length > 160) sim.sparks.shift();
  }

  function updateSimulation(dt) {
    var m = state.m;
    if (!m) return;

    sim.spin += dt * (state.beamOn ? 7 : 0);
    sim.burst = Math.max(0, sim.burst - dt * 1.6);

    if (state.beamOn && !document.hidden) {
      var rate = clamp(8 + m.mA * 1.25, 10, 330);
      sim.emissionAcc += dt * rate;
      var n = Math.min(10, Math.floor(sim.emissionAcc));
      sim.emissionAcc -= n;
      for (var i = 0; i < n; i++) spawnElectron();
    }

    for (var e = sim.electrons.length - 1; e >= 0; e--) {
      var el = sim.electrons[e];
      el.t += dt / el.dur;
      if (el.t >= 1) {
        spawnPhoton(el.x1, el.y1);
        spark(el.x1, el.y1, "rgba(255, 210, 140, 0.9)", 3.4);
        sim.electrons.splice(e, 1);
      }
    }

    for (var p = sim.photons.length - 1; p >= 0; p--) {
      var photon = sim.photons[p];
      photon.x += photon.vx * dt;
      photon.y += photon.vy * dt;

      if (!photon.checked && photon.y >= 521) {
        photon.checked = true;
        if (Math.random() > tube.transmissionAt(photon.energy)) {
          spark(photon.x, 521, photonColor(photon.energy, photon.char), 2.2);
          sim.photons.splice(p, 1);
          continue;
        }
      }

      if (photon.y >= 586) {
        if (photon.x > 420 && photon.x < 940) {
          spark(photon.x, 586, photonColor(photon.energy, photon.char), 2.6);
        }
        sim.photons.splice(p, 1);
      }
    }

    for (var s = sim.sparks.length - 1; s >= 0; s--) {
      var sp = sim.sparks[s];
      sp.life -= dt * 2.6;
      sp.r += dt * 16;
      if (sp.life <= 0) sim.sparks.splice(s, 1);
    }
  }

  function drawTube() {
    var canvas = $("tubeCanvas");
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = Math.round(rect.width * dpr);
    var ch = Math.round(rect.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var scale = Math.min(canvas.width / 1000, canvas.height / 620);
    var ox = (canvas.width - 1000 * scale) / 2;
    var oy = (canvas.height - 620 * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);

    var m = state.m || tube.compute();
    var heat = tube.anodeHeatFraction();
    var beam = state.beamOn;

    /* backdrop */
    var bg = ctx.createRadialGradient(500, 120, 40, 500, 300, 700);
    bg.addColorStop(0, "#0a1722");
    bg.addColorStop(1, "#05090d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1000, 620);

    /* housing */
    var housingGrad = ctx.createLinearGradient(0, 24, 0, 540);
    housingGrad.addColorStop(0, "#152430");
    housingGrad.addColorStop(0.55, "#0e1a24");
    housingGrad.addColorStop(1, "#091219");
    rounded(ctx, 24, 24, 952, 516, 26);
    ctx.fillStyle = housingGrad;
    ctx.fill();
    ctx.strokeStyle = "#243b4d";
    ctx.lineWidth = 1.6;
    ctx.stroke();

    rounded(ctx, 34, 34, 932, 496, 20);
    ctx.strokeStyle = "rgba(120, 180, 220, 0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();

    /* housing bolts */
    [[44, 44], [956, 44], [44, 520], [956, 520]].forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3.4, 0, TAU);
      ctx.fillStyle = "#1d303f";
      ctx.fill();
      ctx.strokeStyle = "#2d475a";
      ctx.stroke();
    });

    /* cooling oil hint */
    var oil = ctx.createLinearGradient(0, 90, 0, 520);
    oil.addColorStop(0, "rgba(52, 110, 145, 0.10)");
    oil.addColorStop(1, "rgba(30, 70, 95, 0.04)");
    rounded(ctx, 80, 80, 840, 440, 50);
    ctx.fillStyle = oil;
    ctx.fill();

    /* glass envelope */
    rounded(ctx, 116, 108, 788, 368, 62);
    var glass = ctx.createLinearGradient(0, 108, 0, 476);
    glass.addColorStop(0, "rgba(140, 210, 255, 0.055)");
    glass.addColorStop(0.5, "rgba(110, 180, 230, 0.025)");
    glass.addColorStop(1, "rgba(120, 200, 255, 0.05)");
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.strokeStyle = "rgba(130, 200, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(160, 132);
    ctx.quadraticCurveTo(300, 112, 460, 118);
    ctx.strokeStyle = "rgba(190, 235, 255, 0.14)";
    ctx.lineWidth = 2;
    ctx.stroke();

    /* cathode assembly */
    var metal = ctx.createLinearGradient(150, 186, 300, 424);
    metal.addColorStop(0, "#33475a");
    metal.addColorStop(0.5, "#1c2c39");
    metal.addColorStop(1, "#101c26");

    rounded(ctx, 150, 196, 34, 216, 8);
    ctx.fillStyle = metal;
    ctx.fill();
    ctx.strokeStyle = "#3a5165";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(182, 186);
    ctx.lineTo(300, 186);
    ctx.lineTo(300, 222);
    ctx.lineTo(216, 222);
    ctx.lineTo(216, 388);
    ctx.lineTo(300, 388);
    ctx.lineTo(300, 424);
    ctx.lineTo(182, 424);
    ctx.closePath();
    ctx.fillStyle = metal;
    ctx.fill();
    ctx.strokeStyle = "#415b70";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    /* filament leads */
    ctx.strokeStyle = "#6c8497";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(258, 240);
    ctx.lineTo(258, 272);
    ctx.moveTo(258, 338);
    ctx.lineTo(258, 370);
    ctx.stroke();

    /* filament coil */
    var filamentGlow = beam ? clamp(0.35 + m.mA / 420, 0.35, 1) : 0.18;
    ctx.save();
    ctx.beginPath();
    for (var fy = 272; fy <= 338; fy += 4) {
      var fx = 258 + Math.sin((fy - 272) * 1.35) * 5.2;
      if (fy === 272) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    }
    ctx.strokeStyle = "rgb(" + Math.round(150 + 105 * filamentGlow) + "," + Math.round(90 + 120 * filamentGlow) + "," + Math.round(45 + 80 * filamentGlow) + ")";
    ctx.lineWidth = 2.4;
    ctx.shadowColor = "rgba(255, 180, 90, 0.95)";
    ctx.shadowBlur = 16 * filamentGlow;
    ctx.stroke();
    ctx.restore();

    var fg = ctx.createRadialGradient(258, 305, 2, 258, 305, 44);
    fg.addColorStop(0, "rgba(255, 190, 110, " + (0.45 * filamentGlow) + ")");
    fg.addColorStop(1, "rgba(255, 150, 60, 0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(258, 305, 44, 0, TAU);
    ctx.fill();

    /* polarity marks */
    ctx.font = "600 20px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(110, 220, 255, 0.8)";
    ctx.fillText("−", 132, 166);
    ctx.fillStyle = "rgba(255, 178, 87, 0.85)";
    ctx.fillText("+", 894, 166);

    /* anode disc */
    ctx.save();
    ctx.translate(824, 300);
    ctx.rotate(-0.08);
    var disc = ctx.createRadialGradient(-20, -40, 10, 0, 0, 180);
    disc.addColorStop(0, "#4a382e");
    disc.addColorStop(0.55, "#241913");
    disc.addColorStop(1, "#120c09");
    ctx.beginPath();
    ctx.ellipse(0, 0, 66, 166, 0, 0, TAU);
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.strokeStyle = "#b37048";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, 64, 164, 0, 0, TAU);
    ctx.clip();
    for (var sp = 0; sp < 10; sp++) {
      var a = sim.spin + sp * (TAU / 10);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * 90, Math.sin(a) * 180);
      ctx.strokeStyle = "rgba(255, 185, 130, 0.075)";
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    /* anode body */
    ctx.beginPath();
    ctx.moveTo(756, 150);
    ctx.lineTo(860, 196);
    ctx.lineTo(860, 410);
    ctx.lineTo(700, 460);
    ctx.closePath();
    var copper = ctx.createLinearGradient(700, 150, 860, 460);
    copper.addColorStop(0, "#7c4c31");
    copper.addColorStop(0.5, "#4a291b");
    copper.addColorStop(1, "#2b1711");
    ctx.fillStyle = copper;
    ctx.fill();
    ctx.strokeStyle = "#8a5a3d";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    /* anode hub */
    ctx.beginPath();
    ctx.arc(842, 300, 21, 0, TAU);
    var hub = ctx.createRadialGradient(836, 292, 2, 842, 300, 22);
    hub.addColorStop(0, "#c08a62");
    hub.addColorStop(1, "#38231a");
    ctx.fillStyle = hub;
    ctx.fill();
    ctx.strokeStyle = "#d09a70";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(842, 300, 6, 0, TAU);
    ctx.fillStyle = "#1b120e";
    ctx.fill();

    /* tungsten target face */
    ctx.beginPath();
    ctx.moveTo(742, 150);
    ctx.lineTo(756, 150);
    ctx.lineTo(700, 460);
    ctx.lineTo(686, 460);
    ctx.closePath();
    var tungsten = ctx.createLinearGradient(690, 150, 760, 460);
    tungsten.addColorStop(0, "#d4e0ea");
    tungsten.addColorStop(0.45, "#93a6b7");
    tungsten.addColorStop(1, "#5f7284");
    ctx.fillStyle = tungsten;
    ctx.fill();
    ctx.strokeStyle = "#dce8f2";
    ctx.lineWidth = 0.8;
    ctx.stroke();

    /* heat glow on the focal track */
    if (heat > 0.001 || beam) {
      var glowStrength = clamp(0.2 + heat * 1.8 + (beam ? 0.22 : 0), 0, 0.95);
      var hg = ctx.createRadialGradient(721, 306, 2, 721, 306, 164);
      hg.addColorStop(0, "rgba(255, 196, 120, " + glowStrength * 0.55 + ")");
      hg.addColorStop(0.35, "rgba(255, 110, 50, " + glowStrength * 0.26 + ")");
      hg.addColorStop(1, "rgba(255, 70, 30, 0)");
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(721, 306, 164, 0, TAU);
      ctx.fill();
    }

    /* beam cone */
    var beamAlpha = beam ? 0.16 : 0.05;
    var cone = ctx.createLinearGradient(721, 306, 721, 584);
    cone.addColorStop(0, "rgba(140, 240, 255, " + beamAlpha + ")");
    cone.addColorStop(0.7, "rgba(120, 225, 255, " + beamAlpha * 0.4 + ")");
    cone.addColorStop(1, "rgba(120, 225, 255, 0.015)");
    ctx.beginPath();
    ctx.moveTo(721, 306);
    ctx.lineTo(480, 584);
    ctx.lineTo(920, 584);
    ctx.closePath();
    ctx.fillStyle = cone;
    ctx.fill();

    ctx.strokeStyle = "rgba(130, 230, 255, " + (beam ? 0.16 : 0.05) + ")";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(721, 306);
    ctx.lineTo(480, 584);
    ctx.moveTo(721, 306);
    ctx.lineTo(920, 584);
    ctx.stroke();

    /* electron path */
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(110, 225, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(266, 306);
    ctx.lineTo(721, 306);
    ctx.stroke();
    ctx.setLineDash([]);

    /* electrons */
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < sim.electrons.length; i++) {
      var e = sim.electrons[i];
      var t = e.t * e.t;
      var x = e.x0 + (e.x1 - e.x0) * t;
      var y = e.y0 + (e.y1 - e.y0) * t;
      var tx = e.x0 + (e.x1 - e.x0) * Math.max(0, e.t * e.t - 0.03);
      var ty = e.y0 + (e.y1 - e.y0) * Math.max(0, e.t * e.t - 0.03);
      ctx.strokeStyle = "rgba(110, 230, 255, 0.55)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = "#a9f2ff";
      ctx.beginPath();
      ctx.arc(x, y, e.size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    /* photons */
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var p = 0; p < sim.photons.length; p++) {
      var ph = sim.photons[p];
      var color = photonColor(ph.energy, ph.char);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = ph.char ? 1.9 : 1.25;
      ctx.beginPath();
      ctx.moveTo(ph.x - ph.vx * 0.028, ph.y - ph.vy * 0.028);
      ctx.lineTo(ph.x, ph.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ph.x, ph.y, ph.char ? 2 : 1.4, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    /* sparks */
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var sp = 0; sp < sim.sparks.length; sp++) {
      var s = sim.sparks[sp];
      ctx.globalAlpha = clamp(s.life, 0, 1) * 0.8;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    /* window */
    rounded(ctx, 538, 518, 340, 22, 4);
    ctx.fillStyle = "rgba(120, 220, 255, 0.13)";
    ctx.fill();
    ctx.strokeStyle = "rgba(150, 235, 255, 0.45)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(150, 235, 255, 0.10)";
    for (var wx = 548; wx < 870; wx += 12) {
      ctx.beginPath();
      ctx.moveTo(wx, 520);
      ctx.lineTo(wx, 538);
      ctx.stroke();
    }

    /* collimator blades */
    function blade(x1, x2, x3, x4) {
      ctx.beginPath();
      ctx.moveTo(x1, 548);
      ctx.lineTo(x2, 548);
      ctx.lineTo(x3, 572);
      ctx.lineTo(x4, 572);
      ctx.closePath();
      var g = ctx.createLinearGradient(0, 548, 0, 572);
      g.addColorStop(0, "#46596a");
      g.addColorStop(1, "#18232d");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "#5f7588";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.save();
      ctx.clip();
      ctx.strokeStyle = "rgba(180, 210, 230, 0.10)";
      ctx.lineWidth = 1.6;
      for (var hx = Math.min(x1, x4) - 12; hx < Math.max(x2, x3) + 12; hx += 9) {
        ctx.beginPath();
        ctx.moveTo(hx, 548);
        ctx.lineTo(hx - 9, 572);
        ctx.stroke();
      }
      ctx.restore();
    }
    blade(476, 562, 552, 476);
    blade(960, 878, 886, 962);

    ctx.fillStyle = "#243440";
    ctx.fillRect(514, 540, 10, 9);
    ctx.fillRect(920, 540, 10, 9);

    /* detector */
    rounded(ctx, 420, 584, 520, 24, 7);
    var det = ctx.createLinearGradient(0, 584, 0, 608);
    det.addColorStop(0, "#132c3b");
    det.addColorStop(1, "#08151e");
    ctx.fillStyle = det;
    ctx.fill();
    ctx.strokeStyle = "rgba(70, 217, 255, 0.42)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.strokeStyle = "rgba(70, 217, 255, 0.10)";
    for (var dx = 432; dx < 930; dx += 14) {
      ctx.beginPath();
      ctx.moveTo(dx, 588);
      ctx.lineTo(dx, 604);
      ctx.stroke();
    }

    if (sim.burst > 0) {
      var box = ctx.createRadialGradient(700, 596, 2, 700, 596, 260);
      box.addColorStop(0, "rgba(210, 250, 255, " + 0.18 * sim.burst + ")");
      box.addColorStop(1, "rgba(210, 250, 255, 0)");
      ctx.fillStyle = box;
      ctx.fillRect(400, 540, 560, 80);
    }

    /* part markers */
    var markers = [
      ["filament", 1, 292, 250],
      ["cup", 2, 196, 350],
      ["envelope", 3, 470, 132],
      ["anode", 4, 850, 214],
      ["window", 5, 512, 530],
      ["collimator", 6, 452, 566],
      ["detector", 8, 398, 598]
    ];
    markers.forEach(function (mk) {
      var active = state.activePart === mk[0];
      ctx.save();
      ctx.beginPath();
      ctx.arc(mk[2], mk[3], active ? 12.5 : 10.5, 0, TAU);
      ctx.fillStyle = active ? "rgba(70, 217, 255, 0.22)" : "rgba(5, 14, 20, 0.88)";
      ctx.fill();
      ctx.strokeStyle = active ? "#b8f5ff" : "rgba(70, 217, 255, 0.55)";
      ctx.lineWidth = active ? 2 : 1;
      if (active) {
        ctx.shadowColor = "rgba(70, 217, 255, 0.9)";
        ctx.shadowBlur = 12;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = active ? "#eafcff" : "#9fe6fb";
      ctx.font = "600 10.5px 'Cascadia Mono', Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(mk[1]), mk[2], mk[3] + 0.5);
      ctx.restore();
    });

    /* soft scanline texture */
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = "#9fd8ee";
    for (var sy = 0; sy < 620; sy += 4) {
      ctx.beginPath();
      ctx.moveTo(0, sy + 0.5);
      ctx.lineTo(1000, sy + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ pipeline */
  function renderPipeline() {
    var host = $("pipeline");
    host.innerHTML = STEPS.map(function (step, i) {
      return '<button type="button" class="step-card" role="tab" aria-selected="false" data-step="' + i + '">' +
        '<span class="step-num">0' + (i + 1) + "</span>" +
        '<span class="step-title">' + step.title + "</span>" +
        '<span class="step-value" data-value="' + i + '">—</span>' +
        '<span class="step-sub">' + step.sub + "</span>" +
        "</button>";
    }).join("");

    Array.prototype.forEach.call(host.querySelectorAll(".step-card"), function (btn) {
      btn.addEventListener("click", function () {
        selectStep(Number(btn.dataset.step));
      });
    });
  }

  function updatePipelineValues(m) {
    STEPS.forEach(function (step, i) {
      var el = document.querySelector('[data-value="' + i + '"]');
      if (el) el.textContent = step.value(m);
    });
    if (state.selectedStep != null) renderDetail(m);
  }

  function selectStep(index) {
    state.selectedStep = index;
    Array.prototype.forEach.call(document.querySelectorAll(".step-card"), function (btn) {
      var on = Number(btn.dataset.step) === index;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    renderDetail(state.m || tube.compute());
  }

  function renderDetail(m) {
    var step = STEPS[state.selectedStep];
    var values = step.values(m).map(function (row) {
      return "<div><dt>" + row[0] + "</dt><dd>" + row[1] + "</dd></div>";
    }).join("");

    $("stepDetail").innerHTML =
      '<div class="detail-main">' +
        '<span class="detail-tag">Stage 0' + (state.selectedStep + 1) + " — " + step.tag + "</span>" +
        "<h3>" + step.h3 + "</h3>" +
        '<p class="detail-lede">' + step.lede + "</p>" +
        '<p class="detail-more">' + step.more + "</p>" +
      "</div>" +
      '<div class="detail-side">' +
        '<div class="formula">' + step.formula + "</div>" +
        '<dl class="detail-values">' + values + "</dl>" +
      "</div>";
  }

  /* ------------------------------------------------------------------- update */
  function updateAll(changedKey) {
    var m = tube.compute();
    state.m = m;
    updateStats(m);
    updateMetrics(m);
    updateHeat();
    updateStageTags(m);
    drawSpectrum(m);
    updatePipelineValues(m);
    if (changedKey && INSIGHTS[changedKey]) updateInsight(changedKey, m);
  }

  /* -------------------------------------------------------------------- events */
  function bindControls() {
    CONTROLS.forEach(function (def) {
      var input = $(def.id);
      input.title = def.hint;
      if (def.log) {
        input.min = "0";
        input.max = "1000";
        input.step = "1";
      }
      input.addEventListener("input", function () {
        var value = readControl(def);
        var update = {};
        update[def.key] = value;
        tube.set(update);
        $(def.out).textContent = def.fmt(value);
        paintRange(input);
        markPreset(null);
        updateAll(def.key);
      });
    });

    $("material").addEventListener("change", function () {
      tube.set({ material: this.value });
      markPreset(null);
      syncControls();
      updateAll("material");
    });

    $("generator").addEventListener("change", function () {
      tube.set({ generator: this.value });
      markPreset(null);
      syncControls();
      updateAll("generator");
    });

    Array.prototype.forEach.call(document.querySelectorAll("#presetChips button"), function (btn) {
      btn.addEventListener("click", function () {
        var preset = PRESETS[btn.dataset.preset];
        if (!preset) return;
        tube.set(preset.params);
        syncControls();
        markPreset(btn.dataset.preset);
        $("insightText").textContent = "Preset loaded — " + preset.label + ". " + INSIGHTS.kVp(tube.compute());
        updateAll(null);
      });
    });

    $("resetBtn").addEventListener("click", function () {
      tube.set(InsertTube.DEFAULTS);
      tube.resetHeat();
      syncControls();
      markPreset(null);
      $("insightText").textContent = "Back to the default 80 kVp tungsten setup. Change any control to see how it reshapes the beam, the heat load and the image.";
      updateAll(null);
    });

    $("exposeBtn").addEventListener("click", expose);

    $("view3d").addEventListener("click", function () { setView("3d"); });
    $("view2d").addEventListener("click", function () { setView("2d"); });

    $("pinBtn").addEventListener("click", function () {
      if (state.pinned) {
        state.pinned = null;
        this.textContent = "Pin for comparison";
        this.setAttribute("aria-pressed", "false");
      } else {
        var spec = tube.spectra();
        state.pinned = {
          bins: spec.filtered.map(function (b) { return { e: b.e, brem: b.brem, char: b.char }; }),
          max: spec.maxFiltered,
          kVp: tube.p.kVp,
          label: tube.p.kVp + " kVp · " + tube.totalFiltration.toFixed(1) + " mm Al"
        };
        this.textContent = "Clear pin";
        this.setAttribute("aria-pressed", "true");
      }
      drawSpectrum(tube.compute());
    });

    Array.prototype.forEach.call(document.querySelectorAll("#partsLegend button"), function (btn) {
      var key = btn.dataset.part;
      btn.addEventListener("mouseenter", function () {
        setActivePart(key);
      });
      btn.addEventListener("mouseleave", function () {
        setActivePart(null);
      });
      btn.addEventListener("focus", function () { setActivePart(key); });
      btn.addEventListener("blur", function () { setActivePart(null); });
      btn.addEventListener("click", function () {
        setActivePart(key);
      });
    });

    var chart = $("spectrumCanvas");
    chart.addEventListener("pointermove", function (ev) {
      var geom = state.chartGeom;
      if (!geom) return;
      var rect = chart.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var ratio = (x - geom.pad.l) / geom.pw;
      state.hoverEnergy = clamp(ratio * geom.xMax, 0, geom.xMax - 0.5);
      drawSpectrum(tube.compute());
    });
    chart.addEventListener("pointerleave", function () {
      state.hoverEnergy = null;
      drawSpectrum(tube.compute());
    });
  }

  function setActivePart(key) {
    state.activePart = key;
    if (scene) scene.hoverPart = key;
    $("partInfo").textContent = key ? PARTS[key].text : DEFAULT_PART_TEXT;
    Array.prototype.forEach.call(document.querySelectorAll("#partsLegend button"), function (btn) {
      btn.classList.toggle("is-active", btn.dataset.part === key);
    });
  }

  function setBeam(on) {
    state.beamOn = on;
    $("beamStatus").classList.toggle("is-off", !on);
    $("beamStatusText").textContent = on ? "X-ray on" : "Standby";
    $("stageMode").textContent = on ? "Exposing" : "Standby";
  }

  /* A real tube radiates only while the hand switch is held: the beam is a pulse
     whose length is the selected exposure time, not a continuous stream. The
     pulse is played back in slow motion so short exposures stay visible. */
  function startExposure() {
    var visDur = clamp(tube.p.exposureTime * 12, 0.5, 4.0);
    state.exposing = true;
    state.exposureTotal = visDur;
    state.exposureRemain = visDur;
    setBeam(true);
  }

  function endExposure() {
    state.exposing = false;
    state.exposureRemain = 0;
    setBeam(false);
  }

  function showToast(text) {
    var toast = $("stageToast");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toast.classList.remove("show");
    }, 2300);
  }

  function expose() {
    var m = tube.compute();
    startExposure();
    tube.addExposure();
    state.burst = 1;
    state.m = tube.compute();

    var flash = $("exposureFlash");
    flash.classList.remove("flash");
    void flash.offsetWidth;
    flash.classList.add("flash");

    captureImage();
    updateHeat();
    updateStats(state.m);
    updateAll(null);

    showToast(m.kVp + " kVp · " + m.mAs.toFixed(1) + " mAs · " + fmtKerma(m.kerma1mGy) + " mGy at 1 m");
  }

  /* ------------------------------------------------------------------- scene */
  function setView(name) {
    var is3d = name === "3d" && !!scene;
    state.view = is3d ? "3d" : "2d";
    $("sceneCanvas").classList.toggle("is-hidden", !is3d);
    $("tubeCanvas").classList.toggle("is-hidden", is3d);
    $("view3d").classList.toggle("is-active", is3d);
    $("view2d").classList.toggle("is-active", !is3d);
    $("view3d").setAttribute("aria-pressed", String(is3d));
    $("view2d").setAttribute("aria-pressed", String(!is3d));
    $("orbitHint").hidden = !is3d;
  }

  function renderScene(dt) {
    var m = state.m || tube.compute();
    scene.setTube(tube);
    scene.setMachine({
      rpm: state.beamOn && !reducedMotion ? 9000 : 0,
      beam: !!state.beamOn,
      filamentGlow: state.beamOn ? clamp(0.22 + m.mA / 520, 0, 1) : 0.04,
      prep: 0,
      exposure: state.burst
    });
    scene.hoverPart = state.activePart;
    scene.draw(dt);
  }

  /* ---------------------------------------------------------------------- loop */
  var lastFrame = performance.now();
  /* Honour the OS reduce-motion setting: drop anode autorotation and thin the
     particle streams while keeping the teaching content readable. */
  var reducedMotion = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function loop(now) {
    var dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;

    if (state.exposing) {
      state.exposureRemain -= dt;
      if (state.exposureRemain <= 0) {
        endExposure();
      } else {
        var frac = 1 - state.exposureRemain / state.exposureTotal;
        $("stageMode").textContent = "Exposing " + Math.round(frac * 100) + "%";
      }
    }

    if (state.m) {
      tube.cool(dt);
      if (now - sim.lastHeatUpdate > 450) {
        updateHeat();
        sim.lastHeatUpdate = now;
      }
    }

    if (state.view === "3d" && scene) {
      renderScene(dt);
    } else {
      updateSimulation(dt);
      drawTube();
    }
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------------- init */
  function init() {
    var sceneCanvas = $("sceneCanvas");
    if (sceneCanvas && window.TubeScene) {
      scene = new TubeScene(sceneCanvas);
      scene.setTube(tube);
    }

    renderPipeline();
    bindControls();
    syncControls();
    setBeam(false);
    setView("3d");
    selectStep(0);
    updateAll(null);
    drawEmptyImage();
    updateHeat();

    window.addEventListener("resize", function () {
      clearTimeout(window.__xrayResize);
      window.__xrayResize = setTimeout(function () {
        if (state.m) {
          drawSpectrum(state.m);
          if (state.lastShot) drawShot();
        }
      }, 120);
    });

    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
