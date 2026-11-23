/* ============================================================================
   CT & Fluoroscopy Lab — modality simulation
   ----------------------------------------------------------------------------
   Reuses the InsertTube physics engine (spectra, filtration, kerma) and the
   ChestPhantom projection model.  Adds:
     * an analytic elliptical axial phantom whose Radon transform is exact,
     * filtered back-projection (ramp filter) with prompt HU read-out,
     * a 3D gantry room and a 3D C-arm room (js/scene3d.js) plus a sinogram,
     * a pulsed fluoroscopy loop with a moving contrast bolus and dose logging.

   Exposes nothing: this file wires the page on DOMContentLoaded.
   ========================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fmt(v, d) {
    return v.toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function gauss() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  /* =======================================================================
     1 · AXIAL PHANTOM  — a torso cross-section as a stack of ellipses.
     Every ellipse carries a mu-delta (cm^-1) added on top of the background.
     ======================================================================= */

  function buildAxialPhantom(meanEnergy) {
    var muSoft = InsertTube.linearMu("soft", meanEnergy);
    var muFat = InsertTube.linearMu("fat", meanEnergy);
    var muBone = InsertTube.linearMu("bone", meanEnergy);
    var muLung = InsertTube.linearMu("lung", meanEnergy);
    var muAir = InsertTube.linearMu("air", meanEnergy);

    var E = [];
    function add(x, y, a, b, phiDeg, mu) {
      E.push({ x: x, y: y, a: a, b: b, phi: phiDeg * DEG, mu: mu });
    }

    /* outer shell: subcutaneous fat over a soft-tissue interior */
    add(0, 0, 15.2, 10.8, 0, muFat);
    add(0, 0, 13.7, 9.4, 0, muSoft - muFat);

    /* lungs (air-filled, well below soft tissue) */
    add(-7.3, 1.6, 5.2, 7.5, -7, muLung - muSoft);
    add(7.3, 1.6, 5.2, 7.5, 7, muLung - muSoft);
    /* a small soft-tissue nodule + a calcified focus in the left lung */
    add(-6.4, 4.2, 1.1, 1.1, 0, muSoft - muLung);
    add(-8.1, -1.4, 0.7, 0.7, 0, muBone - muLung);

    /* mediastinum / heart */
    add(2.4, -2.0, 4.9, 5.6, -18, muSoft * 1.05 - muSoft);
    /* liver under the right hemithorax */
    add(7.6, -4.0, 5.6, 4.1, 12, muSoft * 1.03 - muSoft);
    /* stomach gas bubble */
    add(-6.6, -8.2, 2.3, 1.6, 0, muAir - muSoft);
    /* aorta just anterior to the spine */
    add(1.6, -6.4, 1.3, 1.3, 0, muSoft * 1.06 - muSoft);

    /* vertebral body + spinous process */
    add(0, -8.2, 2.6, 2.3, 0, muBone - muSoft);
    add(0, -10.6, 0.9, 1.5, 0, muBone - muSoft);

    /* sternum */
    add(0, 8.8, 2.4, 1.0, 0, muBone - muSoft);

    /* ribs: small bone rings around the thoracic wall */
    for (var i = 0; i < 12; i++) {
      var a = TAU * (i + 0.5) / 12;
      var x = 13.0 * Math.cos(a);
      var y = 9.0 * Math.sin(a);
      if (Math.abs(x) < 3) continue;               /* skip the sternum / spine */
      add(x, y, 0.95, 0.62, Math.atan2(y, x) / DEG, muBone - muSoft);
    }

    return E;
  }

  /* Analytic Radon transform of one angle through the ellipse stack. */
  function radonRow(E, theta, M, fov, sigma, out) {
    var half = fov / 2;
    var step = fov / M;
    var cth = Math.cos(theta);
    var sth = Math.sin(theta);
    var n = E.length;
    for (var m = 0; m < M; m++) {
      var s = -half + (m + 0.5) * step;
      var sum = 0;
      for (var i = 0; i < n; i++) {
        var e = E[i];
        var cp = Math.cos(theta - e.phi);
        var sp = Math.sin(theta - e.phi);
        var aT = Math.sqrt(e.a * e.a * cp * cp + e.b * e.b * sp * sp);
        var d = s - (e.x * cth + e.y * sth);
        if (d > -aT && d < aT) {
          sum += 2 * e.mu * e.a * e.b / aT * Math.sqrt(1 - (d * d) / (aT * aT));
        }
      }
      out[m] = sigma > 0 ? sum + gauss() * sigma : sum;
    }
    return out;
  }

  /* =======================================================================
     2 · FILTERED BACK-PROJECTION
     ======================================================================= */

  function rampKernel(M, dr) {
    var h = new Float32Array(M);
    h[0] = 1 / (4 * dr * dr);
    for (var k = 1; k < M; k++) {
      h[k] = (k % 2 === 1) ? -1 / (Math.PI * Math.PI * k * k * dr * dr) : 0;
    }
    return h;
  }

  /* Hann-apodised ramp: |f|·0.5·(1+cos(πf/fmax)) inverse-transformed by
     numeric integration, so the amplitude scale matches the analytic
     Ram-Lak kernel above (both are continuous-band-limited kernels).
     Apodisation trades a little sharpness for much less high-frequency
     noise in the reconstruction — worth a comparison toggle in class. */
  function hannRampKernel(M, dr) {
    var J = 2048;
    var fMax = 1 / (2 * dr);
    var df = 2 * fMax / J;
    var h = new Float32Array(M);
    for (var j = 0; j < J; j++) {
      var f = -fMax + (j + 0.5) * df;
      var W = 0.5 * (1 + Math.cos(Math.PI * Math.abs(f) / fMax));
      var H = Math.abs(f) * W;
      for (var n = 0; n < M; n++) {
        h[n] += H * Math.cos(2 * Math.PI * f * n * dr) * df;
      }
    }
    return h;
  }

  function filterRow(row, h, dr, M, out) {
    for (var m = 0; m < M; m++) {
      var acc = h[0] * row[m];
      for (var k = 1; k < M; k++) {
        var hk = h[k];
        if (hk === 0) continue;
        if (m - k >= 0) acc += hk * row[m - k];
        if (m + k < M) acc += hk * row[m + k];
      }
      out[m] = dr * acc;
    }
    return out;
  }

  function backprojectAdd(acc, q, theta, N, fov, M) {
    var half = fov / 2;
    var pc = fov / N;
    var step = fov / M;
    var cth = Math.cos(theta);
    var sth = Math.sin(theta);
    for (var row = 0; row < N; row++) {
      var y = half - (row + 0.5) * pc;
      var base = row * N;
      for (var col = 0; col < N; col++) {
        var x = -half + (col + 0.5) * pc;
        var s = x * cth + y * sth;
        var mf = (s + half) / step - 0.5;
        var m0 = mf | 0;
        var v;
        if (m0 < 0) v = q[0];
        else if (m0 >= M - 1) v = q[M - 1];
        else { var w = mf - m0; v = q[m0] * (1 - w) + q[m0 + 1] * w; }
        acc[base + col] += v;
      }
    }
  }

  /* =======================================================================
     3 · SHARED STATE
     ======================================================================= */

  var tube = new InsertTube({
    kVp: 120, mA: 250, exposureTime: 1.5, material: "W", anodeAngle: 12,
    focalSpot: 0.7, inherentFiltration: 2.5, addedFiltration: 1.0,
    sid: 100, oid: 0, generator: "constant"
  });

  var mode = "ct";
  var lastFrame = performance.now();

  /* ---------------- CT ---------------- */
  var CT = {
    N: 176,            /* reconstruction grid */
    M: 181,            /* detector channels per view */
    fov: 36,           /* cm */
    P: 180,            /* projections per rotation */
    p: 0,              /* projections processed */
    frac: 0,           /* fractional projection carry between frames */
    running: false,
    theta: 0,
    acc: null,
    hu: null,
    rowBuf: null,
    filtBuf: null,
    kernel: null,
    meanEnergy: 60,
    muWater: 0,
    sinogram: null,    /* P x M display values */
    reagent: 0,
    kvp: 120, ma: 250, rotTime: 1.5, slice: 5, scanLen: 30,
    ww: 400, wl: 40,
    hann: false,       /* Hann apodisation of the reconstruction filter */
    roi: { x: 0.5, y: 0.5 }
  };

  /* ---------------- Fluoro ---------------- */
  var FL = {
    running: false,
    t: 0,
    pulseAcc: 0,
    pulses: 0,
    pulseGlow: 0,      /* 1 right after a pulse, decayed to 0 before the next */
    kermaGy: 0,
    maps: null,
    gray: null,        /* Uint8ClampedArray of the last frame */
    w: 240, h: 288,
    breath: 0,
    kvp: 80, ma: 6, pulseMs: 20, pps: 7.5, bodyCm: 24,
    vesselMask: null
  };

  /* ---------------- OPG (orthopantomogram) ---------------- */
  var OPG = {
    running: false,
    t: 0,
    angle: 0,          /* radians swept so far */
    progress: 0,       /* 0..1 of the panoramic arc */
    sweepRad: 200 * DEG,
    reveal: 0,         /* panorama columns already exposed */
    pw: 560, ph: 210,
    dens: null,        /* ideal attenuation field of the panorama */
    gray: null,        /* rendered 8-bit panorama */
    img: null,         /* reusable ImageData */
    dirty: true,
    modelKey: "",
    kermaGy: 0,
    kvp: 75, ma: 8, rotTime: 9, arch: 0, focus: 0, sliceCm: 15
  };

  /* =======================================================================
     4 · CANVAS HELPERS
     ======================================================================= */

  var sino, sctx, sW, sH;
  var recon, rctx, rW, rH;
  var reconOff, reconCtx, reconImg;
  var fluoro, fctx, fW, fH, fImg, vesselOff;
  var pano, pctx, pW, pH;

  /* 3D rooms (js/scene3d.js); built lazily once their canvas has a box. */
  var ctScene = null, flScene = null, opgScene = null;

  function fit(canvas, cssH) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = canvas.clientWidth || canvas.parentElement.clientWidth || 480;
    var h = cssH || canvas.clientHeight || 360;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* Fluoro frames are produced with putImageData, which ignores the canvas
     transform — so the buffer is kept at the phantom's native pixel size and
     only the CSS box is allowed to scale it. */
  function fitNative(canvas, w, h) {
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* =======================================================================
     5 · CT RECONSTRUCTION
     ======================================================================= */

  function resetScan() {
    CT.p = 0;
    CT.frac = 0;
    CT.theta = 0;
    CT.acc = new Float32Array(CT.N * CT.N);
    CT.hu = new Float32Array(CT.N * CT.N);
    CT.rowBuf = new Float32Array(CT.M);
    CT.filtBuf = new Float32Array(CT.M);
    CT.sinogram = [];
    var dr = CT.fov / CT.M;
    CT.kernel = CT.hann ? hannRampKernel(CT.M, dr) : rampKernel(CT.M, dr);
  }

  function currentSigma() {
    var mAsPerProj = (CT.ma * CT.rotTime) / Math.max(1, CT.P);
    return 0.03 / Math.sqrt(Math.max(1e-3, mAsPerProj));
  }

  function processProjection() {
    var E = CT.ellipses;
    if (!E) return false;
    if (CT.p >= CT.P) return false;
    var theta = Math.PI * CT.p / CT.P;
    radonRow(E, theta, CT.M, CT.fov, currentSigma(), CT.rowBuf);
    CT.sinogram.push(Float32Array.from(CT.rowBuf));
    filterRow(CT.rowBuf, CT.kernel, CT.fov / CT.M, CT.M, CT.filtBuf);
    backprojectAdd(CT.acc, CT.filtBuf, theta, CT.N, CT.fov, CT.M);
    CT.p++;
    CT.theta = theta;
    return true;
  }

  function finaliseRecon() {
    var scale = Math.PI / CT.P;
    for (var i = 0; i < CT.acc.length; i++) {
      var mu = CT.acc[i] * scale;
      CT.hu[i] = 1000 * (mu - CT.muWater) / (CT.muWater || 1);
    }
  }

  /* Re-run only the filtering + back-projection from the stored sinogram:
     lets the Hann/ Ram-Lak toggle swap kernels instantly without a rescan. */
  function refilterRecon() {
    var dr = CT.fov / CT.M;
    CT.kernel = CT.hann ? hannRampKernel(CT.M, dr) : rampKernel(CT.M, dr);
    CT.acc = new Float32Array(CT.N * CT.N);
    for (var p = 0; p < CT.p; p++) {
      filterRow(CT.sinogram[p], CT.kernel, dr, CT.M, CT.filtBuf);
      backprojectAdd(CT.acc, CT.filtBuf, Math.PI * p / CT.P, CT.N, CT.fov, CT.M);
    }
    finaliseRecon();
    renderRecon();
    updateCTStats();
  }

  function huToGray(hu) {
    var lo = CT.wl - CT.ww / 2;
    var v = clamp((hu - lo) / CT.ww, 0, 1);
    return Math.round(Math.pow(v, 0.95) * 255);
  }

  function renderRecon() {
    if (!rctx) return;
    var N = CT.N;
    var has = CT.p > 0;
    if (!reconOff) {
      reconOff = document.createElement("canvas");
      reconOff.width = N; reconOff.height = N;
      reconCtx = reconOff.getContext("2d");
      reconImg = reconCtx.createImageData(N, N);
    }
    var d = reconImg.data;
    for (var i = 0; i < N * N; i++) {
      var g = has ? huToGray(CT.hu[i]) : 9;
      d[i * 4] = g; d[i * 4 + 1] = g; d[i * 4 + 2] = has ? g : 13; d[i * 4 + 3] = 255;
    }
    reconCtx.putImageData(reconImg, 0, 0);

    var side = Math.min(rW, rH);
    var ox = (rW - side) / 2, oy = (rH - side) / 2;
    rctx.clearRect(0, 0, rW, rH);
    rctx.imageSmoothingEnabled = true;
    rctx.drawImage(reconOff, ox, oy, side, side);
    if (!has) {
      rctx.fillStyle = "rgba(142,166,184,0.85)";
      rctx.font = "12px system-ui, sans-serif";
      rctx.textAlign = "center";
      rctx.fillText("no data — start a scan", rW / 2, rH / 2);
    }
  }

  function drawSinogram() {
    var rows = CT.sinogram.length;
    var w = CT.M, h = CT.P;
    if (!sino.__buf || sino.__buf.width !== w || sino.__buf.height !== h) {
      sino.__buf = document.createElement("canvas");
      sino.__buf.width = w; sino.__buf.height = h;
      sino.__bctx = sino.__buf.getContext("2d");
      sino.__img = sino.__bctx.createImageData(w, h);
    }
    var img = sino.__img;
    var d = img.data;
    var max = 0.0001;
    for (var r = 0; r < rows; r++) {
      var row = CT.sinogram[r];
      for (var c = 0; c < w; c++) max = Math.max(max, row[c]);
    }
    for (var rr = 0; rr < h; rr++) {
      for (var cc = 0; cc < w; cc++) {
        var idx = (rr * w + cc) * 4;
        var val = rr < rows ? CT.sinogram[rr][cc] / max : 0;
        var g = Math.round(clamp(val, 0, 1) * 255);
        d[idx] = g; d[idx + 1] = g; d[idx + 2] = g; d[idx + 3] = 255;
      }
    }
    sino.__bctx.putImageData(img, 0, 0);
    sctx.clearRect(0, 0, sW, sH);
    sctx.imageSmoothingEnabled = true;
    var scale = Math.min(sW / w, sH / h);
    var dw = w * scale, dh = h * scale;
    sctx.drawImage(sino.__buf, (sW - dw) / 2, (sH - dh) / 2, dw, dh);
    sctx.strokeStyle = "rgba(70,217,255,0.5)";
    sctx.lineWidth = 1;
    sctx.strokeRect((sW - dw) / 2, (sH - dh) / 2, dw, dh);
  }

  /* =======================================================================
     6 · FLUOROSCOPY
     ======================================================================= */

  function syncFluoroTube() {
    tube.set({
      kVp: FL.kvp, mA: FL.ma, exposureTime: FL.pulseMs / 1000,
      material: "W", anodeAngle: 10, focalSpot: 0.6,
      inherentFiltration: 3.0, addedFiltration: 0.5, sid: 100, oid: 0,
      generator: "constant"
    });
  }

  function buildVessel() {
    /* a dim static vessel/catheter path drawn once into an offscreen canvas */
    vesselOff = document.createElement("canvas");
    vesselOff.width = FL.w; vesselOff.height = FL.h;
    var c = vesselOff.getContext("2d");
    var pts = vesselPath(FL.w, FL.h);
    c.lineCap = "round";
    c.lineJoin = "round";
    for (var pass = 0; pass < 2; pass++) {
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.strokeStyle = pass === 0 ? "rgba(210,230,255,0.10)" : "rgba(230,245,255,0.22)";
      c.lineWidth = pass === 0 ? 5 : 2;
      c.stroke();
    }
  }

  function vesselPath(w, h) {
    var raw = [
      [0.20, 0.24], [0.30, 0.30], [0.40, 0.38], [0.47, 0.50],
      [0.53, 0.60], [0.62, 0.70], [0.74, 0.78]
    ];
    return raw.map(function (p) { return { x: p[0] * w, y: p[1] * h }; });
  }

  function firePulse() {
    syncFluoroTube();
    var res = ChestPhantom.capture(tube, FL.maps);
    FL.gray = res.gray;
    FL.pulses++;
    FL.kermaGy += tube.compute().kerma1mGy / 1000;
    FL.pulseGlow = 1;   /* light the tube head and intensifier for this pulse */
  }

  function drawFluoro() {
    if (!FL.maps) return;
    var w = FL.w, h = FL.h;
    if (!fImg) fImg = fctx.createImageData(w, h);
    var d = fImg.data;
    var pts = vesselPath(w, h);
    var phase = (FL.t * 0.35) % 1.25;
    var breath = Math.round(Math.sin(FL.t * 0.9) * 2.5);

    for (var row = 0; row < h; row++) {
      var srcRow = clamp(row - breath, 0, h - 1);
      for (var col = 0; col < w; col++) {
        var idx = (row * w + col) * 4;
        var g = FL.gray ? FL.gray[srcRow * w + col] : 14;
        d[idx] = g; d[idx + 1] = g; d[idx + 2] = g; d[idx + 3] = 255;
      }
    }
    fctx.putImageData(fImg, 0, 0);

    /* dim static vessel */
    fctx.save();
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = "source-over";
    fctx.drawImage(vesselOff, 0, 0);
    fctx.restore();

    /* moving contrast bolus along the path */
    fctx.save();
    fctx.globalCompositeOperation = "lighter";
    fctx.lineCap = "round";
    var seg = 16;
    for (var k = 0; k < seg; k++) {
      var f = phase - k / 90;
      if (f < 0 || f > 1) continue;
      var pos = f * (pts.length - 1);
      var i0 = Math.floor(pos);
      var fr = pos - i0;
      var p0 = pts[Math.min(i0, pts.length - 1)];
      var p1 = pts[Math.min(i0 + 1, pts.length - 1)];
      var x = p0.x + (p1.x - p0.x) * fr;
      var y = p0.y + (p1.y - p0.y) * fr + Math.sin(FL.t * 0.9) * 2.5;
      var a = (1 - k / seg) * 0.5;
      fctx.beginPath();
      fctx.arc(x, y, 5.5 - k * 0.12, 0, TAU);
      fctx.fillStyle = "rgba(210,240,255," + a.toFixed(3) + ")";
      fctx.fill();
    }
    /* catheter tip */
    var tipF = phase + 0.10;
    if (tipF <= 1) {
      var tp = tipF * (pts.length - 1);
      var ti = Math.floor(tp);
      var tf = tp - ti;
      var q0 = pts[Math.min(ti, pts.length - 1)];
      var q1 = pts[Math.min(ti + 1, pts.length - 1)];
      fctx.beginPath();
      fctx.arc(q0.x + (q1.x - q0.x) * tf, q0.y + (q1.y - q0.y) * tf, 2.4, 0, TAU);
      fctx.fillStyle = "rgba(255,214,140,0.9)";
      fctx.fill();
    }
    fctx.restore();

    /* collimation edges + label */
    fctx.strokeStyle = "rgba(70,217,255,0.25)";
    fctx.lineWidth = 1;
    fctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  /* =======================================================================
     6b · OPG  (orthopantomogram — dental panoramic)
     A slit beam sweeps once around the jaw.  The image plane is the dental
     arch "unrolled" left-to-right, so the anatomy is modelled directly in
     those flattened coordinates and revealed column by column as the arm
     turns.
     ======================================================================= */

  function opgSmooth(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function opgBand(x, lo, hi, soft) {
    return opgSmooth(lo - soft, lo + soft, x) * opgSmooth(hi + soft, hi - soft, x);
  }

  function opgModelKey() {
    return OPG.kvp + "|" + OPG.ma + "|" + OPG.arch + "|" + OPG.focus;
  }

  function syncOPGTube() {
    tube.set({
      kVp: OPG.kvp, mA: OPG.ma, exposureTime: OPG.rotTime,
      material: "W", anodeAngle: 10, focalSpot: 0.6,
      inherentFiltration: 2.5, addedFiltration: 0.4, sid: 55, oid: 6,
      generator: "constant"
    });
  }

  function buildOPGPano() {
    var pw = OPG.pw, ph = OPG.ph;
    if (!OPG.dens) OPG.dens = new Float32Array(pw * ph);
    if (!OPG.gray) OPG.gray = new Uint8ClampedArray(pw * ph);

    var key = opgModelKey();
    if (OPG.modelKey === key) return;
    OPG.modelKey = key;

    var dens = OPG.dens;
    var archAmp = [0.050, 0.080, 0.030][OPG.arch] || 0.050;
    var focusShift = OPG.focus * 0.011;
    /* lower kVp raises bone/enamel contrast, as it does on a real unit */
    var boneGain = clamp(1.32 - (OPG.kvp - 60) * 0.0055, 0.82, 1.32);

    for (var j = 0; j < ph; j++) {
      var v = (j + 0.5) / ph;
      for (var i = 0; i < pw; i++) {
        var u = (i + 0.5) / pw;
        var idx = j * pw + i;
        var su = (u - 0.5) * 2;
        /* occlusal plane: dips in the front, rises at the ramus */
        var occl = 0.52 + archAmp * (1 - su * su) + focusShift;
        var d = 0.015;

        /* --- soft-tissue envelope: head block + neck --- */
        var hx = (u - 0.5) / 0.50, hy = (v - 0.34) / 0.33;
        var qh = 1 - hx * hx - hy * hy;
        if (qh > 0) d += 0.20 * Math.sqrt(qh);
        var nx = (u - 0.5) / 0.17, ny = (v - 0.92) / 0.34;
        var qn = 1 - nx * nx - ny * ny;
        if (qn > 0) d += 0.17 * Math.sqrt(qn);

        /* --- maxillary / alveolar bone above the occlusal line --- */
        d += 0.30 * boneGain *
             opgBand(v, occl - 0.30, occl - 0.02, 0.05) *
             opgSmooth(1.00, 0.88, Math.abs(su));

        /* --- mandible body below the occlusal line --- */
        d += 0.34 * boneGain *
             opgBand(v, occl + 0.02, occl + 0.22, 0.05) *
             opgSmooth(1.02, 0.90, Math.abs(su));

        /* --- ramus rising into the condyle at both ends --- */
        var ram = opgSmooth(0.80, 0.94, Math.abs(su));
        if (ram > 0) {
          d += 0.36 * boneGain * ram *
               opgBand(v, occl - 0.26, occl + 0.30, 0.05);
        }

        /* --- teeth: individual crowns and roots on both arches --- */
        var tf = (u * 16) % 1;
        var tm = opgSmooth(0.10, 0.20, tf) * opgSmooth(0.90, 0.80, tf) *
                 opgSmooth(0.02, 0.10, u) * opgSmooth(0.98, 0.90, u);
        d += (0.70 * opgBand(v, occl - 0.062, occl - 0.012, 0.012) +
              0.40 * opgBand(v, occl - 0.135, occl - 0.055, 0.014)) * tm * boneGain;
        d += (0.66 * opgBand(v, occl + 0.010, occl + 0.062, 0.012) +
              0.40 * opgBand(v, occl + 0.058, occl + 0.140, 0.014)) * tm * boneGain;

        /* --- air cavities (less attenuation → darker) --- */
        for (var s = -1; s <= 1; s += 2) {
          var ax = (su - s * 0.42) / 0.24;
          var ay = (v - (occl - 0.22)) / 0.075;
          var qs = 1 - ax * ax - ay * ay;
          if (qs > 0) d -= 0.26 * Math.sqrt(qs);
        }
        var mx = (u - 0.5) / 0.055, my = (v - (occl - 0.24)) / 0.085;
        var qm = 1 - mx * mx - my * my;
        if (qm > 0) d -= 0.22 * Math.sqrt(qm);
        if (Math.abs(u - 0.5) < 0.006 && v < occl - 0.14) d += 0.16;   /* nasal septum */
        d -= 0.20 * opgBand(v, occl - 0.006, occl + 0.006, 0.009) *
             opgSmooth(0.94, 0.86, Math.abs(su));                       /* oral air gap */

        /* --- cervical spine below the mandible --- */
        var sx = (u - 0.5) / 0.085;
        var qsp = 1 - sx * sx;
        if (qsp > 0 && v > occl + 0.15) {
          var seg = (v - (occl + 0.15)) / 0.085;
          var sf = seg - Math.floor(seg);
          d += 0.34 * boneGain * Math.sqrt(qsp) *
               opgSmooth(0.12, 0.28, sf) * opgSmooth(0.88, 0.72, sf);
        }

        /* --- mandibular canal: a thin dark line inside the jaw --- */
        d -= 0.14 * opgBand(v, occl + 0.105, occl + 0.120, 0.006) *
             opgSmooth(0.95, 0.86, Math.abs(su));

        /* --- tight collimation: fade to air at the borders --- */
        d *= opgSmooth(0.01, 0.06, v) * opgSmooth(0.99, 0.94, v) *
             opgSmooth(0.004, 0.03, u) * opgSmooth(0.996, 0.97, u);

        dens[idx] = d;
      }
    }

    /* deposit quantum noise, then map the attenuation to 8-bit grey */
    var lo = 0.06, hi = 1.02;
    var noiseAmp = clamp(34 - OPG.ma * 1.6, 6, 40);
    var gray = OPG.gray;
    for (var p = 0; p < dens.length; p++) {
      var val = clamp((dens[p] - lo) / (hi - lo), 0, 1);
      gray[p] = clamp(Math.pow(val, 0.9) * 255 + gauss() * noiseAmp, 0, 255);
    }
  }

  function renderOPG() {
    if (!pctx) return;
    var pw = OPG.pw, ph = OPG.ph;
    buildOPGPano();
    if (!OPG.img || OPG.img.width !== pw || OPG.img.height !== ph) {
      OPG.img = pctx.createImageData(pw, ph);
    }
    var src = OPG.gray, d = OPG.img.data;
    var reveal = Math.round(OPG.reveal);
    for (var p = 0; p < pw * ph; p++) {
      var on = (p % pw) < reveal;
      var g = on ? src[p] : 10;
      d[p * 4] = g;
      d[p * 4 + 1] = on ? g : 14;
      d[p * 4 + 2] = on ? g : 18;
      d[p * 4 + 3] = 255;
    }
    pctx.putImageData(OPG.img, 0, 0);

    /* leading edge of the exposure */
    if (OPG.running && reveal > 2 && reveal < pw) {
      var grad = pctx.createLinearGradient(reveal - 12, 0, reveal + 2, 0);
      grad.addColorStop(0, "rgba(90,220,255,0)");
      grad.addColorStop(1, "rgba(150,235,255,0.55)");
      pctx.fillStyle = grad;
      pctx.fillRect(reveal - 12, 0, 14, ph);
    }
    pctx.strokeStyle = "rgba(70,217,255,0.20)";
    pctx.lineWidth = 1;
    pctx.strokeRect(0.5, 0.5, pw - 1, ph - 1);
    OPG.dirty = false;
  }

  function stepOPG(dt) {
    OPG.t += dt;
    if (OPG.running) {
      var prev = OPG.progress;
      OPG.progress = Math.min(1, OPG.progress + dt / Math.max(1, OPG.rotTime));
      OPG.angle = OPG.progress * OPG.sweepRad;
      OPG.reveal = OPG.progress * OPG.pw;
      OPG.kermaGy += tube.compute().kerma1mGy / 1000 * (OPG.progress - prev);
      OPG.dirty = true;
      if (OPG.progress >= 1) {
        OPG.running = false;
        $("scanBtn").textContent = "Re-scan";
      }
    }
    if (OPG.running || OPG.dirty) renderOPG();
    updateOPGStats();
  }

  function updateOPGStats() {
    var deg = OPG.angle / DEG;
    $("opgAngle").innerHTML = "<b>" + fmt(deg, 0) + "</b><em>°</em>";
    $("opgProgress").innerHTML = "<b>" + fmt(OPG.progress * 100, 0) + "</b><em>%</em>";
    $("opgSlice").innerHTML = "<b>" + fmt(OPG.sliceCm, 1) + "</b><em>cm</em>";
    $("opgKerma").innerHTML = "<b>" + fmt(OPG.kermaGy * 1000, 2) + "</b><em>mGy</em>";
    $("opgState").textContent = OPG.running
      ? (OPG.progress < 0.02 ? "Starting sweep" : "Exposing " + Math.round(OPG.progress * 100) + "%")
      : (OPG.progress >= 1 ? "Panorama ready" : "Standby");
    $("tagOpgAngle").textContent = fmt(deg, 0) + "°";
  }

  function bindOPGControls() {
    bindRange("opgkVp", "opgkVpOut", function (v) {
      OPG.kvp = v; syncOPGTube(); OPG.dirty = true;
    }, function (v) { return v + " kVp"; });
    bindRange("opgmA", "opgmAOut", function (v) {
      OPG.ma = v; syncOPGTube(); OPG.dirty = true;
    }, function (v) { return v.toFixed(1) + " mA"; });
    bindRange("opgRotTime", "opgRotTimeOut", function (v) { OPG.rotTime = v; },
      function (v) { return v.toFixed(1) + " s"; });
    bindRange("opgArch", "opgArchOut", function (v) {
      OPG.arch = Math.round(v); OPG.dirty = true;
    }, function (v) { return ["U-arch", "Parabolic", "Hyperbolic"][Math.round(v)]; });
    bindRange("opgFocus", "opgFocusOut", function (v) {
      OPG.focus = Math.round(v); OPG.dirty = true;
    }, function (v) {
      var n = Math.round(v);
      return (n < 0 ? "Anterior" : n > 0 ? "Posterior" : "Centred") +
        " · layer " + (n > 0 ? "+" : "") + n;
    });
  }

  /* =======================================================================
     7 · STATS
     ======================================================================= */

  function roiStats() {
    if (CT.p === 0) return null;
    var N = CT.N;
    var cx = N * 0.32, cy = N * 0.5;
    var r = 6;
    var sum = 0, sum2 = 0, n = 0;
    for (var y = cy - r; y <= cy + r; y++) {
      for (var x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        var hu = CT.hu[(y | 0) * N + (x | 0)];
        sum += hu; sum2 += hu * hu; n++;
      }
    }
    if (!n) return null;
    var mean = sum / n;
    var sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    return { mean: mean, sd: sd };
  }

  function updateCTStats() {
    var mAs = CT.ma * CT.rotTime;
    var kp = CT.p;
    var ctdi = 0.9 * mAs / 100 * (CT.kvp / 120) * 2.0;   /* illustrative CTDIvol */
    var dlp = ctdi * CT.scanLen;
    $("ctMAs").innerHTML = "<b>" + fmt(mAs, 0) + "</b><em>mAs</em>";
    $("ctProj").innerHTML = "<b>" + kp + "</b><em>/ " + CT.P + "</em>";
    $("ctCTDI").innerHTML = "<b>" + fmt(ctdi, 1) + "</b><em>mGy</em>";
    $("ctDLP").innerHTML = "<b>" + fmt(dlp, 0) + "</b><em>mGy·cm</em>";
    var roi = roiStats();
    $("ctROI").innerHTML = roi ? "<b>" + fmt(roi.mean, 0) + "</b><em>HU</em>" : "<b>—</b>";
    $("ctNoise").innerHTML = roi ? "<b>" + fmt(roi.sd, 0) + "</b><em>HU</em>" : "<b>—</b>";
    $("ctState").textContent = kp === 0 ? "Idle" : (kp < CT.P ? "Acquiring " + Math.round(kp / CT.P * 100) + "%" : "Reconstruction ready");
    $("tagViews").textContent = CT.P + " views";
  }

  function updateFLStats() {
    var rate = FL.kermaGy * FL.pps * 60 * 1000;
    $("flState").textContent = FL.running ? (FL.pulses < 2 ? "Arming…" : "Imaging") : "Standby";
    $("flPulses").innerHTML = "<b>" + FL.pulses + "</b><em>pulses</em>";
    $("flKerma").innerHTML = "<b>" + fmt(FL.kermaGy * 1000, 2) + "</b><em>mGy</em>";
    $("flRate").innerHTML = "<b>" + fmt(rate, 1) + "</b><em>mGy/min</em>";
    $("flLast").innerHTML = "<b>" + fmt(FL.ma * FL.pulseMs, 2) + "</b><em>mAs</em>";
    $("tagFlRate").textContent = FL.pps.toFixed(1) + " pps";
  }

  /* =======================================================================
     8 · MODE + CONTROLS
     ======================================================================= */

  function setMode(next) {
    mode = next;
    $("modeCT").classList.toggle("is-active", next === "ct");
    $("modeFluoro").classList.toggle("is-active", next === "fluoro");
    $("modeOPG").classList.toggle("is-active", next === "opg");
    $("ctControls").hidden = next !== "ct";
    $("flControls").hidden = next !== "fluoro";
    $("opgControls").hidden = next !== "opg";
    $("ctStage").hidden = next !== "ct";
    $("flStage").hidden = next !== "fluoro";
    $("opgStage").hidden = next !== "opg";
    $("ctStats").hidden = next !== "ct";
    $("flStats").hidden = next !== "fluoro";
    $("opgStats").hidden = next !== "opg";
    $("scanBtn").textContent =
      next === "ct" ? (CT.p < CT.P && CT.p > 0 ? "Rescan" : "Start scan")
        : next === "opg" ? (OPG.running ? "Exposing…" : OPG.progress >= 1 ? "Re-scan" : "Start panoramic")
          : (FL.running ? "Stop fluoroscopy" : "Start fluoroscopy");
    onResize();
  }

  function bindRange(id, outId, apply, fmtFn) {
    var input = $(id);
    var out = $(outId);
    function sync() {
      var v = parseFloat(input.value);
      var lo = parseFloat(input.min), hi = parseFloat(input.max);
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        input.style.setProperty("--fill", ((v - lo) / (hi - lo) * 100).toFixed(1) + "%");
      }
      out.textContent = fmtFn(v);
      apply(v);
    }
    input.addEventListener("input", sync);
    sync();
  }

  function bindCTControls() {
    bindRange("kVp", "kVpOut", function (v) {
      CT.kvp = v;
      tube.set({ kVp: v });
      CT.ellipses = buildAxialPhantom(tube.compute().meanEnergy);
      CT.meanEnergy = tube.compute().meanEnergy;
      CT.muWater = InsertTube.linearMu("soft", CT.meanEnergy);
    }, function (v) { return v + " kVp"; });

    bindRange("mA", "mAOut", function (v) {
      CT.ma = v; tube.set({ mA: v, exposureTime: CT.rotTime });
    }, function (v) { return v + " mA"; });

    bindRange("rotTime", "rotTimeOut", function (v) {
      CT.rotTime = v; tube.set({ exposureTime: v });
    }, function (v) { return v.toFixed(1) + " s"; });

    bindRange("projCount", "projOut", function (v) {
      CT.P = Math.round(v);
      resetScan();
    }, function (v) { return Math.round(v) + " views"; });

    bindRange("sliceThk", "sliceOut", function (v) { CT.slice = v; },
      function (v) { return v.toFixed(1) + " mm"; });

    bindRange("scanLen", "scanLenOut", function (v) { CT.scanLen = v; },
      function (v) { return Math.round(v) + " cm"; });

    bindRange("winW", "winWOut", function (v) { CT.ww = v; renderRecon(); },
      function (v) { return Math.round(v) + " HU"; });

    bindRange("winL", "winLOut", function (v) { CT.wl = v; renderRecon(); },
      function (v) { return Math.round(v) + " HU"; });

    var hannBox = $("hannWindow");
    if (hannBox) {
      hannBox.addEventListener("change", function () {
        CT.hann = this.checked;
        $("hannOut").textContent = this.checked ? "Hann" : "Ram-Lak";
        refilterRecon();
      });
    }
  }

  function bindFLControls() {
    bindRange("flkVp", "flkVpOut", function (v) { FL.kvp = v; },
      function (v) { return v + " kVp"; });
    bindRange("flmA", "flmAOut", function (v) { FL.ma = v; },
      function (v) { return v + " mA"; });
    bindRange("pulseWidth", "pulseWidthOut", function (v) { FL.pulseMs = v; },
      function (v) { return v + " ms"; });
    bindRange("pulseRate", "pulseRateOut", function (v) { FL.pps = v; },
      function (v) { return v.toFixed(1) + " pps"; });
  }

  /* =======================================================================
     9 · FRAME LOOP
     ======================================================================= */

  function stepCT(dt) {
    if (!CT.running) return;
    /* a carry lets the rotation time govern the scan duration even when it is
       long enough that fewer than one projection lands in a frame */
    CT.frac += CT.P * dt / Math.max(0.15, CT.rotTime);
    var perFrame = Math.floor(CT.frac);
    CT.frac -= perFrame;
    for (var i = 0; i < perFrame && CT.p < CT.P; i++) processProjection();
    CT.disp = (CT.theta / Math.PI) * TAU;
    if (CT.p >= CT.P) {
      CT.running = false;
      finaliseRecon();
      $("scanBtn").textContent = "Rescan";
    }
    renderRecon();
    drawSinogram();
    updateCTStats();
  }

  function stepFluoro(dt) {
    if (!FL.maps) {
      FL.maps = ChestPhantom.buildMaps(FL.bodyCm);
      FL.w = ChestPhantom.WIDTH; FL.h = ChestPhantom.HEIGHT;
      buildVessel();
      if (!fluoro || fluoro.width !== FL.w || fluoro.height !== FL.h) {
        var ff = fitNative(fluoro || $("fluoroCanvas"), FL.w, FL.h);
        fluoro = $("fluoroCanvas"); fctx = ff.ctx; fW = ff.w; fH = ff.h; fImg = null;
      }
    }
    FL.t += dt;
    if (FL.running) {
      FL.pulseAcc += dt;
      var period = 1 / FL.pps;
      if (FL.pulseAcc >= period) {
        FL.pulseAcc -= period;
        if (FL.pulseAcc > period) FL.pulseAcc = 0;
        firePulse();
      }
    }
    /* the pulse afterglow fades well before the next one, so the 3D beam
       visibly flickers at the set pulse rate */
    FL.pulseGlow = Math.max(0, FL.pulseGlow - dt * 12);
    drawFluoro();
    updateFLStats();
  }

  function loop(now) {
    var dt = Math.min(0.06, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (mode === "ct") {
      stepCT(dt);
      if (ctScene) {
        ctScene.setMachine({
          beam: CT.running,
          text: CT.p >= CT.P ? "scan complete" : CT.p > 0 ? "view " + CT.p + " / " + CT.P : "ready"
        });
        ctScene.rotTarget = CT.disp || 0;
        ctScene.draw(dt);
      }
    } else if (mode === "opg") {
      stepOPG(dt);
      if (opgScene) {
        opgScene.setMachine({
          beam: OPG.running,
          text: OPG.running
            ? Math.round(OPG.progress * 100) + "% · " + fmt(OPG.angle / DEG, 0) + "°"
            : OPG.progress >= 1 ? "sweep complete" : "standby"
        });
        opgScene.rotTarget = OPG.angle;
        opgScene.draw(dt);
      }
    } else {
      stepFluoro(dt);
      if (flScene) {
        flScene.setMachine({
          beam: FL.running,
          active: FL.running,
          pulse: FL.pulseGlow,
          text: FL.running
            ? FL.pulses + " pulses · " + FL.pps.toFixed(1) + " pps"
            : "standby"
        });
        flScene.draw(dt);
      }
    }
    requestAnimationFrame(loop);
  }

  /* =======================================================================
     10 · RESIZE + INIT
     ======================================================================= */

  /* the 3D rooms own their canvas sizing (they read getBoundingClientRect on
     every frame), so they are only constructed — never run through fit(). */
  function ensureScenes() {
    if (!ctScene && window.CTScene) ctScene = new window.CTScene($("gantryCanvas"));
    if (!flScene && window.FluoroScene) flScene = new window.FluoroScene($("carmCanvas"));
    if (!opgScene && window.OPGScene) opgScene = new window.OPGScene($("opgCanvas"));
  }

  function onResize() {
    ensureScenes();
    var s = fit($("sinoCanvas"), 220);
    sino = $("sinoCanvas"); sctx = s.ctx; sW = s.w; sH = s.h;
    var r = fit($("reconCanvas"), 220);
    recon = $("reconCanvas"); rctx = r.ctx; rW = r.w; rH = r.h;
    var f = fitNative($("fluoroCanvas"), FL.w, FL.h);
    fluoro = $("fluoroCanvas"); fctx = f.ctx; fW = f.w; fH = f.h; fImg = null;
    var pn = fitNative($("panoCanvas"), OPG.pw, OPG.ph);
    pano = $("panoCanvas"); pctx = pn.ctx; pW = pn.w; pH = pn.h; OPG.img = null;
    OPG.dirty = true;
    if (mode === "ct" && CT.hu) renderRecon();
    if (mode === "fluoro") drawFluoro();
    if (mode === "opg") renderOPG();
  }

  function startScan() {
    if (mode === "ct") {
      resetScan();
      CT.running = true;
      CT.disp = 0;
      renderRecon();
      drawSinogram();
      $("scanBtn").textContent = "Scanning…";
    } else if (mode === "opg") {
      if (OPG.running) {
        OPG.running = false;
        $("scanBtn").textContent = "Start panoramic";
        return;
      }
      OPG.progress = 0;
      OPG.angle = 0;
      OPG.reveal = 0;
      OPG.kermaGy = 0;
      syncOPGTube();
      buildOPGPano();
      if (opgScene) opgScene.rotTarget = 0;
      OPG.running = true;
      OPG.dirty = true;
      $("scanBtn").textContent = "Exposing…";
      renderOPG();
      updateOPGStats();
    } else {
      FL.running = !FL.running;
      FL.pulseAcc = 1;   /* fire immediately */
      $("scanBtn").textContent = FL.running ? "Stop fluoroscopy" : "Start fluoroscopy";
    }
  }

  function init() {
    CT.meanEnergy = tube.compute().meanEnergy;
    CT.muWater = InsertTube.linearMu("soft", CT.meanEnergy);
    CT.ellipses = buildAxialPhantom(CT.meanEnergy);
    resetScan();

    onResize();
    bindCTControls();
    bindFLControls();
    bindOPGControls();

    $("modeCT").addEventListener("click", function () { setMode("ct"); });
    $("modeFluoro").addEventListener("click", function () { setMode("fluoro"); });
    $("modeOPG").addEventListener("click", function () { setMode("opg"); });
    $("scanBtn").addEventListener("click", startScan);
    window.addEventListener("resize", function () {
      clearTimeout(window.__ctResize);
      window.__ctResize = setTimeout(onResize, 120);
    });

    /* HU read-out under the cursor */
    $("reconCanvas").addEventListener("mousemove", function (ev) {
      if (CT.p === 0) return;
      var rect = recon.getBoundingClientRect();
      var side = Math.min(rect.width, rect.height);
      var ox = (rect.width - side) / 2, oy = (rect.height - side) / 2;
      var fx = (ev.clientX - rect.left - ox) / side;
      var fy = (ev.clientY - rect.top - oy) / side;
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return;
      var col = clamp(Math.floor(fx * CT.N), 0, CT.N - 1);
      var row = clamp(Math.floor(fy * CT.N), 0, CT.N - 1);
      var hu = CT.hu[row * CT.N + col];
      $("ctHover").innerHTML = "<b>" + fmt(hu, 0) + "</b><em>HU</em>";
    });

    setMode("ct");
    renderRecon();
    drawSinogram();
    updateCTStats();
    updateFLStats();
    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
