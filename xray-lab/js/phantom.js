/* ============================================================================
   Chest phantom + physically based radiograph capture
   ----------------------------------------------------------------------------
   A projected material-thickness model of a PA chest (soft tissue, cortical
   bone, lung, liver).  Every detector pixel integrates transmission over the
   filtered X-ray spectrum; scatter, heel effect, geometric unsharpness,
   magnification and Poisson noise are then applied.

   Exposes: window.ChestPhantom
   ========================================================================== */
(function (global) {
  "use strict";

  var WIDTH = 240;
  var HEIGHT = 288;
  var FIELD_W = 36; // cm
  var FIELD_H = 43.2; // cm

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    var qx = x1 + t * dx;
    var qy = y1 + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  /* Build material-thickness maps, all values in centimetres. */
  function buildMaps(bodyCm) {
    var soft = new Float32Array(WIDTH * HEIGHT);
    var bone = new Float32Array(WIDTH * HEIGHT);
    var lung = new Float32Array(WIDTH * HEIGHT);
    var halfDepth = Math.max(7, bodyCm / 2);

    for (var row = 0; row < HEIGHT; row++) {
      var y = FIELD_H / 2 - (row + 0.5) * (FIELD_H / HEIGHT);
      for (var col = 0; col < WIDTH; col++) {
        var x = (col + 0.5) * (FIELD_W / WIDTH) - FIELD_W / 2;
        var idx = row * WIDTH + col;

        /* --- body contour: thorax with wider shoulders + abdomen -------- */
        var rxBody = 16.2 + 2.1 * smoothstep(6, 17, y) - 1.1 * smoothstep(9, 19, -y);
        var qThorax = 1 - (x * x) / (rxBody * rxBody) - ((y - 0.6) * (y - 0.6)) / (19.0 * 19.0);
        var tThorax = qThorax > 0 ? 2 * halfDepth * Math.sqrt(qThorax) : 0;

        var qAbdomen = 1 - (x * x) / (14.2 * 14.2) - ((y + 16.5) * (y + 16.5)) / (8.5 * 8.5);
        var tAbdomen = qAbdomen > 0 ? 2 * 11.5 * Math.sqrt(qAbdomen) : 0;

        var tSoft = Math.max(tThorax, tAbdomen);

        /* Neck soft tissue at the very top of the field. */
        if (Math.abs(x) < 4.6 && y > 16.2) {
          var neck = 13 * smoothstep(16.2, 21.2, y) * (1 - (x * x) / (4.6 * 4.6));
          tSoft = Math.max(tSoft, neck);
        }

        if (tSoft <= 0.05) continue;

        var inThorax = qThorax > 0;

        /* --- lungs ------------------------------------------------------- */
        if (inThorax) {
          for (var s = -1; s <= 1; s += 2) {
            var lx = x - s * 7.6;
            var ly = y - 3.4;
            var ca = Math.cos(s * 0.07);
            var sa = Math.sin(s * 0.07);
            var rx = lx * ca + ly * sa;
            var ry = -lx * sa + ly * ca;
            var ql = 1 - (rx * rx) / (6.7 * 6.7) - (ry * ry) / (14.4 * 14.4);
            if (ql > 0) {
              /* diaphragm: lungs end on a curved dome */
              var dome = -12.0 + 2.1 * Math.cos(x / 8.5);
              var lungFactor = smoothstep(dome - 0.4, dome + 1.6, y);
              if (lungFactor > 0) {
                var lungPath = 2 * 7.4 * Math.sqrt(ql) * lungFactor;
                var take = Math.min(tSoft * 0.84, lungPath);
                tSoft -= take;
                lung[idx] += take;
              }
            }
          }
        }

        /* --- heart / mediastinum ---------------------------------------- */
        var hx = x - 3.6;
        var hy = y + 4.6;
        var hc = Math.cos(0.16);
        var hs = Math.sin(0.16);
        var hrx = hx * hc + hy * hs;
        var hry = -hx * hs + hy * hc;
        var qHeart = 1 - (hrx * hrx) / (5.9 * 5.9) - (hry * hry) / (7.6 * 7.6);
        if (qHeart > 0) {
          var add = 6.6 * qHeart;
          tSoft += add;
          lung[idx] = Math.max(0, lung[idx] - add);
        }

        /* --- liver under the right hemidiaphragm ------------------------ */
        if (x > 0.5 && y < -9.2 + 0.04 * x * x) {
          var liverQ = smoothstep(-10.5, -15, y);
          tSoft += 3.8 * liverQ;
          lung[idx] = Math.max(0, lung[idx] - 3.8 * liverQ);
        }

        /* --- stomach air bubble ----------------------------------------- */
        if ((x + 6.5) * (x + 6.5) / (2.7 * 2.7) + (y + 13.0) * (y + 13.0) / (2.0 * 2.0) < 1) {
          var air = Math.min(tSoft, 2.4);
          tSoft -= air;
          lung[idx] += air;
        }

        /* --- trachea ----------------------------------------------------- */
        if (Math.abs(x) < 1.1 && y > 8 && y < 19.5) {
          var trach = Math.min(tSoft, 2.4);
          tSoft -= trach;
          lung[idx] += trach;
        }

        /* --- spine with vertebral bodies + transverse processes ---------- */
        if (Math.abs(x) < 2.0 && y > -20 && y < 14.5) {
          var vert = 0.70 + 0.30 * Math.cos((y + 2) * 2 * Math.PI / 2.35);
          var widthF = 1 - Math.pow(Math.abs(x) / 2.0, 4);
          var ends = Math.min(1, (14.5 - y) / 2.2) * Math.min(1, (y + 20) / 2.2);
          bone[idx] += 4.0 * vert * widthF * clamp(ends, 0, 1);
        }
        for (var tv = -7; tv <= 5; tv++) {
          var ty = tv * 2.35 - 1.5;
          if (Math.abs(y - ty) < 0.42 && Math.abs(x) > 1.7 && Math.abs(x) < 4.0) {
            bone[idx] += 0.75 * (1 - Math.abs(y - ty) / 0.42);
          }
        }

        /* --- posterior ribs (steep, thin) -------------------------------- */
        for (var r = 0; r < 10; r++) {
          var baseY = -13.6 + r * 2.65;
          var ax = Math.abs(x);
          if (ax < 2.0) continue;
          var yRib = baseY - 0.036 * Math.pow(ax - 2.0, 1.72);
          var d = Math.abs(y - yRib);
          if (d < 0.42) bone[idx] += 0.92 * (1 - d / 0.42);
        }

        /* --- anterior ribs (shallower, fainter) -------------------------- */
        for (var a = 0; a < 6; a++) {
          var aBase = -15.2 + a * 2.9;
          var ax2 = Math.abs(x);
          if (ax2 > 15 || ax2 < 1.5) continue;
          var aY = aBase - 0.016 * Math.pow(ax2 - 1.5, 1.45);
          var ad = Math.abs(y - aY);
          if (ad < 0.34) bone[idx] += 0.48 * (1 - ad / 0.34);
        }

        /* --- clavicles --------------------------------------------------- */
        var cd = Math.min(
          distToSegment(x, y, -1.2, 13.4, -12.8, 16.4),
          distToSegment(x, y, 1.2, 13.4, 12.8, 16.4)
        );
        if (cd < 0.55) bone[idx] += 1.15 * (1 - cd / 0.55);

        /* --- rounded lesion in the left lung ----------------------------- */
        var nx = x + 7.2;
        var ny = y + 1.2;
        if (nx * nx + ny * ny < 1.45 * 1.45) {
          var lesion = 2.1 * (1 - (nx * nx + ny * ny) / 2.1);
          tSoft += lesion;
          lung[idx] = Math.max(0, lung[idx] - lesion);
        }

        soft[idx] = Math.max(0, tSoft);
      }
    }

    return {
      width: WIDTH,
      height: HEIGHT,
      fieldW: FIELD_W,
      fieldH: FIELD_H,
      soft: soft,
      bone: bone,
      lung: lung,
      bodyCm: bodyCm
    };
  }

  /* Approximate the filtered spectrum with 16 energy groups. */
  function spectrumGroups(tube) {
    var spec = tube.spectra();
    var bins = spec.filtered;
    var groups = 16;
    var minE = Math.max(8, Math.min(15, tube.p.kVp * 0.4));
    var maxE = tube.p.kVp;
    var span = Math.max(1, maxE - minE);
    var acc = [];
    for (var g = 0; g < groups; g++) {
      acc.push({ area: 0, weightedE: 0, e: minE + (g + 0.5) * span / groups });
    }
    var total = 0;
    for (var i = 0; i < bins.length; i++) {
      var b = bins[i];
      if (b.e < minE) continue;
      var gi = Math.min(groups - 1, Math.floor((b.e - minE) / span * groups));
      var weight = (b.brem + b.char) * b.e * spec.step;
      acc[gi].area += weight;
      acc[gi].weightedE += b.e * weight;
      total += weight;
    }
    var out = [];
    for (var k = 0; k < acc.length; k++) {
      if (acc[k].area > 0) {
        out.push({ energy: acc[k].weightedE / acc[k].area, weight: acc[k].area / total });
      }
    }
    return out;
  }

  function boxBlur(src, w, h, radius, passes) {
    var a = new Float32Array(src);
    var b = new Float32Array(src.length);
    var r = Math.max(1, Math.round(radius));
    for (var p = 0; p < passes; p++) {
      for (var y = 0; y < h; y++) {
        var row = y * w;
        var sum = 0;
        for (var x = -r; x <= r; x++) sum += a[row + clamp(x, 0, w - 1)];
        for (var x2 = 0; x2 < w; x2++) {
          b[row + x2] = sum / (2 * r + 1);
          sum -= a[row + clamp(x2 - r, 0, w - 1)];
          sum += a[row + clamp(x2 + r + 1, 0, w - 1)];
        }
      }
      for (var x3 = 0; x3 < w; x3++) {
        var sum2 = 0;
        for (var y1 = -r; y1 <= r; y1++) sum2 += b[clamp(y1, 0, h - 1) * w + x3];
        for (var y2 = 0; y2 < h; y2++) {
          a[y2 * w + x3] = sum2 / (2 * r + 1);
          sum2 -= b[clamp(y2 - r, 0, h - 1) * w + x3];
          sum2 += b[clamp(y2 + r + 1, 0, h - 1) * w + x3];
        }
      }
    }
    return a;
  }

  function gaussian() {
    var u = 0;
    var v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function poisson(lambda, gaussTable) {
    if (lambda <= 0) return 0;
    if (lambda > 40) {
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussTable[(Math.random() * gaussTable.length) | 0]));
    }
    var L = Math.exp(-lambda);
    var k = 0;
    var p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }

  /* Capture one radiograph. Returns grayscale pixels plus exposure metadata. */
  function capture(tube, maps) {
    var m = tube.compute();
    var groups = spectrumGroups(tube);
    var nGroups = groups.length;

    /* Quantised exponential LUTs: 0.25 cm steps, 0–50 cm. */
    var STEP_CM = 0.25;
    var LUT_N = 201;
    var lutSoft = [];
    var lutBone = [];
    var lutLung = [];
    for (var g = 0; g < nGroups; g++) {
      var e = groups[g].energy;
      var muS = InsertTube.linearMu("soft", e);
      var muB = InsertTube.linearMu("bone", e);
      var muL = InsertTube.linearMu("lung", e);
      var aS = new Float32Array(LUT_N);
      var aB = new Float32Array(LUT_N);
      var aL = new Float32Array(LUT_N);
      for (var i = 0; i < LUT_N; i++) {
        var t = i * STEP_CM;
        aS[i] = Math.exp(-muS * t);
        aB[i] = Math.exp(-muB * t);
        aL[i] = Math.exp(-muL * t);
      }
      lutSoft.push(aS);
      lutBone.push(aB);
      lutLung.push(aL);
    }

    var width = maps.width;
    var height = maps.height;
    var fieldHalf = maps.fieldW / 2;
    var mag = m.sid / Math.max(1, m.sid - m.oid);
    var heelDrop = clamp((12 / Math.max(6, m.anodeAngle) - 0.55) * 0.22, 0.04, 0.42);
    var spr = clamp(0.12 + m.kVp / 420 + (maps.bodyCm - 20) * 0.008, 0.12, 0.65);

    var primary = new Float32Array(width * height);
    for (var row = 0; row < height; row++) {
      var y = maps.fieldH / 2 - (row + 0.5) * (maps.fieldH / height);
      for (var col = 0; col < width; col++) {
        var x = (col + 0.5) * (maps.fieldW / width) - fieldHalf;
        var sc = clamp(Math.round((x / mag + fieldHalf) / maps.fieldW * width - 0.5), 0, width - 1);
        var sr = clamp(Math.round((maps.fieldH / 2 - y / mag) / maps.fieldH * height - 0.5), 0, height - 1);
        var idx = sr * width + sc;
        var is = Math.min(LUT_N - 1, Math.round(maps.soft[idx] / STEP_CM));
        var ib = Math.min(LUT_N - 1, Math.round(maps.bone[idx] / STEP_CM));
        var il = Math.min(LUT_N - 1, Math.round(maps.lung[idx] / STEP_CM));
        var sum = 0;
        for (var e2 = 0; e2 < nGroups; e2++) {
          sum += groups[e2].weight * lutSoft[e2][is] * lutBone[e2][ib] * lutLung[e2][il];
        }
        primary[row * width + col] = sum;
      }
    }

    /* Scatter veiling glare. */
    var scattered = boxBlur(primary, width, height, Math.round(width * 0.05), 2);
    var total = new Float32Array(width * height);
    for (var p = 0; p < total.length; p++) {
      total[p] = (primary[p] + spr * scattered[p]) / (1 + spr);
    }

    /* Heel effect across the anode-cathode direction. */
    for (var row2 = 0; row2 < height; row2++) {
      for (var col2 = 0; col2 < width; col2++) {
        var xx = (col2 + 0.5) * (maps.fieldW / width) - fieldHalf;
        total[row2 * width + col2] *= 1 - heelDrop * ((xx / fieldHalf) + 1) * 0.5;
      }
    }

    /* Geometric unsharpness from the focal-spot penumbra. */
    var pixelCm = maps.fieldW / width;
    var sigmaPx = (m.unsharpness / pixelCm) * 1.35;
    if (sigmaPx > 0.35) {
      total = boxBlur(total, width, height, Math.max(1, Math.round(sigmaPx * 0.9)), 2);
    }

    /* Photon statistics. */
    var detectorKerma = m.kerma1mGy * Math.pow(100 / m.sid, 2);
    var photonsPerMm2 = detectorKerma * 1.1e5 * (50 / Math.max(15, m.meanEnergy));
    var pixelAreaMm2 = Math.pow(pixelCm * 10, 2);
    var qe = 0.62;
    var n0 = Math.max(0.05, photonsPerMm2 * pixelAreaMm2 * qe);

    var gaussTable = new Float32Array(2048);
    for (var gt = 0; gt < gaussTable.length; gt++) gaussTable[gt] = gaussian();

    var gray = new Uint8ClampedArray(width * height);
    var density = new Float32Array(width * height);
    var bodyValues = [];
    var sumDensity = 0;
    var bodyCount = 0;

    for (var q = 0; q < total.length; q++) {
      var lambda = n0 * total[q];
      var counts = poisson(lambda, gaussTable);
      var signal = counts / n0;
      var d = -Math.log(Math.max(signal, 1e-5));
      density[q] = d;
      if (maps.soft[q] > 2) {
        bodyValues.push(d);
        sumDensity += d;
        bodyCount++;
      }
    }

    bodyValues.sort(function (a, b) { return a - b; });
    var lo = bodyValues.length ? bodyValues[Math.floor(bodyValues.length * 0.02)] : 0;
    var hi = bodyValues.length ? bodyValues[Math.floor(bodyValues.length * 0.995)] : 4;
    if (hi - lo < 1.0) hi = lo + 1.0;

    for (var q2 = 0; q2 < density.length; q2++) {
      var v = clamp((density[q2] - lo) / (hi - lo), 0, 1);
      gray[q2] = Math.round(Math.pow(v, 0.9) * 255);
    }

    /* Soft vignette. */
    for (var row3 = 0; row3 < height; row3++) {
      for (var col3 = 0; col3 < width; col3++) {
        var nx = (col3 / width - 0.5) * 2;
        var ny = (row3 / height - 0.5) * 2;
        var gi = row3 * width + col3;
        gray[gi] = Math.round(gray[gi] * (1 - 0.1 * clamp(nx * nx + ny * ny, 0, 1)));
      }
    }

    return {
      gray: gray,
      width: width,
      height: height,
      stats: {
        meanDensity: bodyCount ? sumDensity / bodyCount : 0,
        windowLo: lo,
        windowHi: hi,
        detectorKerma: detectorKerma,
        photonsPerMm2: photonsPerMm2,
        n0: n0,
        spr: spr,
        heelDrop: heelDrop,
        magnification: mag,
        blurMm: m.unsharpness,
        pixelMm: pixelCm * 10
      }
    };
  }

  global.ChestPhantom = {
    buildMaps: buildMaps,
    capture: capture,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    FIELD_W: FIELD_W,
    FIELD_H: FIELD_H
  };
})(window);
