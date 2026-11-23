/* ============================================================================
   INSERT TUBE — physics engine for a diagnostic X-ray tube
   ----------------------------------------------------------------------------
   A dependency-free, browser-loadable class that models the chain:
     thermionic emission -> electrostatic acceleration -> target interaction
     -> filtration -> geometric image formation.

   The model is intentionally transparent and educational, not clinical:
     * Bremsstrahlung uses a Kramers-style shape, N(E) ∝ Z·(Emax − E)/E.
     * Characteristic lines are Gaussians above the target K-edge.
     * Attenuation uses log-log interpolation of tabulated coefficients.
     * Absolute output is calibrated so 80 kVp, 10 mAs, 2.5 mm Al at 1 m
       produces 0.45 mGy air kerma.
   ========================================================================== */
(function (global) {
  "use strict";

  var STEP = 0.5; // keV bin width
  var ANODE_CAPACITY_J = 300000; // illustrative rotating-anode heat capacity
  var SELF_FILTRATION_MM = 1.2; // crude target self-absorption, Al-equivalent

  /* Mass attenuation coefficients, cm²/g (log-log interpolated). */
  var AL_MU_RHO = [
    [3, 320], [4, 190], [5, 128], [6, 78], [8, 34], [10, 26.2], [15, 8.99],
    [20, 3.44], [30, 1.128], [40, 0.5444], [50, 0.3246], [60, 0.2273],
    [80, 0.1471], [100, 0.1095], [120, 0.0915], [150, 0.0753], [200, 0.0566]
  ];

  /* Air mass energy-absorption coefficients, cm²/g (relative shape). */
  var AIR_MUEN_RHO = [
    [5, 30.4], [8, 10.9], [10, 4.74], [15, 1.29], [20, 0.538], [30, 0.154],
    [40, 0.0683], [50, 0.0403], [60, 0.0277], [80, 0.0158], [100, 0.0108],
    [120, 0.0082], [150, 0.0061]
  ];

  /* Air mass attenuation coefficients, cm²/g. */
  var AIR_MU_RHO = [
    [4, 190], [5, 128], [6, 78], [8, 34], [10, 5.12], [15, 1.56], [20, 0.777],
    [30, 0.3537], [40, 0.2485], [50, 0.208], [60, 0.1878], [80, 0.1662],
    [100, 0.1541], [120, 0.146], [150, 0.1388], [200, 0.127]
  ];

  /* Soft tissue and cortical bone, cm²/g. */
  var WATER_MU_RHO = [
    [10, 5.329], [15, 1.673], [20, 0.8096], [30, 0.3756], [40, 0.2683],
    [50, 0.2269], [60, 0.2059], [80, 0.1837], [100, 0.1707], [120, 0.1613],
    [150, 0.1505]
  ];
  var BONE_MU_RHO = [
    [10, 123.0], [15, 33.4], [20, 12.1], [30, 3.42], [40, 1.52],
    [50, 0.879], [60, 0.586], [80, 0.355], [100, 0.271], [120, 0.229],
    [150, 0.196]
  ];

  var MATERIALS = {
    W: {
      key: "W", name: "Tungsten", symbol: "W", z: 74, kEdge: 69.5,
      melting: 3422, color: "#a9bccd",
      blurb: "High Z and a very high melting point: the standard for general radiography.",
      lines: [
        { name: "Kα₁", energy: 59.32, weight: 0.55 },
        { name: "Kα₂", energy: 57.98, weight: 0.27 },
        { name: "Kβ₁", energy: 67.24, weight: 0.18 }
      ]
    },
    Mo: {
      key: "Mo", name: "Molybdenum", symbol: "Mo", z: 42, kEdge: 20.0,
      melting: 2623, color: "#9fb2c8",
      blurb: "Low-energy K-lines suit mammography, where soft-tissue contrast matters.",
      lines: [
        { name: "Kα", energy: 17.48, weight: 0.75 },
        { name: "Kβ", energy: 19.61, weight: 0.25 }
      ]
    },
    Rh: {
      key: "Rh", name: "Rhodium", symbol: "Rh", z: 45, kEdge: 23.22,
      melting: 1964, color: "#b4c2d2",
      blurb: "Slightly harder K-lines than Mo for denser breast tissue.",
      lines: [
        { name: "Kα", energy: 20.22, weight: 0.75 },
        { name: "Kβ", energy: 22.72, weight: 0.25 }
      ]
    },
    Cu: {
      key: "Cu", name: "Copper", symbol: "Cu", z: 29, kEdge: 8.98,
      melting: 1085, color: "#c99a7a",
      blurb: "Low-Z target with soft characteristic lines; rarely used for imaging.",
      lines: [
        { name: "Kα", energy: 8.05, weight: 0.75 },
        { name: "Kβ", energy: 8.90, weight: 0.25 }
      ]
    }
  };

  var GENERATORS = {
    constant: {
      key: "constant", name: "Constant potential", ripple: "≈ 0%",
      note: "Nearly ripple-free kV; the cleanest spectrum and output."
    },
    highFrequency: {
      key: "highFrequency", name: "High frequency", ripple: "< 4%",
      note: "Compact generator; output close to constant potential."
    },
    singlePhase: {
      key: "singlePhase", name: "Single phase", ripple: "100%",
      note: "Voltage swings to zero each half-cycle: softer beam, lower output."
    }
  };

  var DEFAULTS = {
    kVp: 80,
    mA: 100,
    exposureTime: 0.1,
    material: "W",
    anodeAngle: 12,
    focalSpot: 0.6,
    addedFiltration: 0,
    inherentFiltration: 2.5,
    minSampleEnergy: 10,
    sid: 100,
    oid: 0,
    bodyThickness: 24,
    generator: "constant"
  };

  /* ------------------------------------------------------------------ utils */
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function logInterp(table, x) {
    if (x <= table[0][0]) return table[0][1];
    var last = table[table.length - 1];
    if (x >= last[0]) return last[1];
    for (var i = 0; i < table.length - 1; i++) {
      var a = table[i];
      var b = table[i + 1];
      if (x >= a[0] && x <= b[0]) {
        var t = (Math.log(x) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
        return Math.exp(Math.log(a[1]) + t * (Math.log(b[1]) - Math.log(a[1])));
      }
    }
    return 0;
  }

  function roundTo(v, digits) {
    var f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  }

  /* ------------------------------------------------------------------ class */
  function InsertTube(config) {
    this.p = Object.assign({}, DEFAULTS, config || {});
    this.anodeHeatJ = 0;
    this.anodeCapacityJ = ANODE_CAPACITY_J;
    this.exposureCount = 0;
    this.sessionKermaGy = 0;
    this._cache = Object.create(null);
    this._calibrate();
  }

  InsertTube.prototype = {
    constructor: InsertTube,

    /* Parameter handling ---------------------------------------------------- */

    set: function (partial) {
      var changed = false;
      for (var key in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, key) && this.p[key] !== partial[key]) {
          this.p[key] = partial[key];
          changed = true;
        }
      }
      if (changed) this._cache = Object.create(null);
      return this;
    },

    get: function (key) {
      return this.p[key];
    },

    resetHeat: function () {
      this.anodeHeatJ = 0;
      this.exposureCount = 0;
      this.sessionKermaGy = 0;
      return this;
    },

    get totalFiltration() {
      return this.p.inherentFiltration + this.p.addedFiltration;
    },

    /* Spectrum -------------------------------------------------------------- */

    _rawSpectrum: function (kVp, materialKey) {
      var mat = MATERIALS[materialKey] || MATERIALS.W;
      var bins = [];
      var e;
      for (e = 3; e < kVp; e += STEP) {
        bins.push({
          e: e,
          brem: mat.z * (kVp / e - 1),
          char: 0
        });
      }
      if (!bins.length) {
        bins.push({ e: Math.max(3, kVp / 2), brem: 1, char: 0 });
      }

      var over = (kVp - mat.kEdge) / mat.kEdge;
      if (over > 0.001) {
        var boost = Math.pow(over, 0.8);
        for (var li = 0; li < mat.lines.length; li++) {
          var line = mat.lines[li];
          if (line.energy >= kVp) continue;
          var continuum = mat.z * (kVp / line.energy - 1);
          var amp = 2.5 * continuum * boost * line.weight * 3;
          var center = Math.round((line.energy - 3) / STEP);
          for (var i = Math.max(0, center - 3); i < Math.min(bins.length, center + 4); i++) {
            var d = bins[i].e - line.energy;
            bins[i].char += amp * Math.exp(-(d * d) / (2 * 0.45 * 0.45));
          }
        }
      }

      /* Thick-target self-absorption: crude Al-equivalent slab at the focal
         track. It suppresses the very soft tail that a real target reabsorbs. */
      var selfT = SELF_FILTRATION_MM / 10;
      for (var j = 0; j < bins.length; j++) {
        var t = Math.exp(-logInterp(AL_MU_RHO, bins[j].e) * 2.7 * selfT);
        bins[j].brem *= t;
        bins[j].char *= t;
      }
      return bins;
    },

    _shapeSpectrum: function (kVp, materialKey) {
      var primary = this._rawSpectrum(kVp, materialKey);
      if (this.p.generator !== "singlePhase") return primary;

      /* 100% ripple: blend the peak-kV spectrum with a softened one so the
         mean energy and output both fall, while the endpoint stays at kVp. */
      var secondary = this._rawSpectrum(Math.max(12, kVp * 0.8), materialKey);
      return primary.map(function (bin, i) {
        var low = secondary[i] || { brem: 0, char: 0 };
        return {
          e: bin.e,
          brem: bin.brem * 0.62 + low.brem * 0.38,
          char: bin.char * 0.62 + low.char * 0.38
        };
      });
    },

    _filterBins: function (bins, mmAl) {
      var rho = 2.7;
      var t = mmAl / 10;
      return bins.map(function (bin) {
        var mu = logInterp(AL_MU_RHO, bin.e) * rho * t;
        var transmission = Math.exp(-mu);
        return {
          e: bin.e,
          brem: bin.brem * transmission,
          char: bin.char * transmission,
          transmission: transmission
        };
      });
    },

    _kermaSum: function (bins) {
      var sum = 0;
      for (var i = 0; i < bins.length; i++) {
        var b = bins[i];
        sum += (b.brem + b.char) * b.e * logInterp(AIR_MUEN_RHO, b.e) * STEP;
      }
      return sum;
    },

    _area: function (bins, key) {
      var sum = 0;
      for (var i = 0; i < bins.length; i++) sum += bins[i][key] * STEP;
      return sum;
    },

    _calibrate: function () {
      /* 0.45 mGy for 80 kVp / 10 mAs / 2.5 mm Al at 1 m. */
      var ref = this._filterBins(this._rawSpectrum(80, "W"), 2.5);
      this._kermaCal = 0.00045 / (10 * this._kermaSum(ref));
    },

    /* Full spectrum bundle, cached. */
    spectra: function () {
      if (this._cache.spectra) return this._cache.spectra;
      var p = this.p;
      var raw = this._shapeSpectrum(p.kVp, p.material);
      var total = this.totalFiltration;
      var filtered = this._filterBins(raw, total);
      var bundle = {
        raw: raw,
        filtered: filtered,
        step: STEP,
        kVp: p.kVp,
        totalFiltration: total,
        lines: MATERIALS[p.material].lines
      };
      bundle.maxFiltered = 0;
      for (var i = 0; i < filtered.length; i++) {
        bundle.maxFiltered = Math.max(bundle.maxFiltered, filtered[i].brem + filtered[i].char);
      }
      this._cache.spectra = bundle;
      return bundle;
    },

    /* Metrics --------------------------------------------------------------- */

    compute: function () {
      if (this._cache.metrics) return this._cache.metrics;
      var p = this.p;
      var mat = MATERIALS[p.material] || MATERIALS.W;
      var mAs = p.mA * p.exposureTime;
      var spec = this.spectra();
      var filtered = spec.filtered;

      var totalArea = this._area(filtered, "brem") + this._area(filtered, "char");
      var charArea = this._area(filtered, "char");
      var charFraction = totalArea > 0 ? charArea / totalArea : 0;

      var kermaSum = this._kermaSum(filtered);
      var kerma1mGy = this._kermaCal * kermaSum * mAs * Math.pow(100 / p.sid, 2) * 1000;

      /* Fluence-weighted mean energy of the filtered beam. */
      var eNum = 0;
      var eDen = 0;
      var peakE = 0;
      var peakVal = -1;
      for (var i = 0; i < filtered.length; i++) {
        var b = filtered[i];
        var v = b.brem + b.char;
        eNum += v * b.e;
        eDen += v;
        if (v > peakVal) { peakVal = v; peakE = b.e; }
      }
      var meanEnergy = eDen > 0 ? eNum / eDen : 0;

      /* Half-value layer of the filtered beam. */
      var k0 = this._kermaSum(filtered);
      var lo = 0;
      var hi = 15;
      for (var it = 0; it < 32; it++) {
        var mid = (lo + hi) / 2;
        var test = this._kermaSum(this._filterBins(spec.raw, spec.totalFiltration + mid));
        if (test > k0 / 2) lo = mid; else hi = mid;
      }
      var hvl = (lo + hi) / 2;

      var efficiency = clamp(1.1e-6 * mat.z * p.kVp, 0, 0.08);
      var electrons = 6.2415e15 * mAs;
      /* Photon count from energy balance: each electron deposits kVp keV in
         the target; the `efficiency` fraction leaves as radiation, split into
         photons of meanEnergy each. Using the raw efficiency fraction as a
         count ratio would mix an energy fraction with a population fraction. */
      var photons = electrons * efficiency * p.kVp / Math.max(5, meanEnergy);
      var heatJ = p.kVp * mAs * (1 - efficiency);
      var hu = 1.4 * p.kVp * mAs;

      var focalNominal = p.focalSpot;
      var effectiveFocal = focalNominal * Math.sin(p.anodeAngle * Math.PI / 180) /
        Math.sin(12 * Math.PI / 180);
      /* Field coverage on the anode–cathode axis is limited by the target
         angle, but can never exceed the usable detector plate (43 cm). */
      var coverageCm = Math.min(43, 2 * p.sid * Math.tan(p.anodeAngle * Math.PI / 180));
      var magnification = p.sid / Math.max(1, p.sid - p.oid);
      var unsharpness = effectiveFocal * p.oid / Math.max(1, p.sid - p.oid);

      var muWater = logInterp(WATER_MU_RHO, meanEnergy);
      var muBone = logInterp(BONE_MU_RHO, meanEnergy);
      var contrast = muBone > 0 ? (muBone - muWater) / muWater : 0;
      var contrastRatio = muWater > 0 ? muBone / muWater : 1;

      var refKerma = 0.00045; // 80 kVp / 10 mAs / 1 m at 1 m
      var relOutput = kerma1mGy / 1000 / refKerma;
      var noiseSigma = 0.018 / Math.sqrt(Math.max(0.01, (mAs * relOutput) / 10));

      var filamentTempC = 2150 + 420 * Math.pow(clamp(p.mA, 1, 1000) / 500, 0.25);
      var electronSpeedC = Math.sqrt(1 - 1 / Math.pow(1 + p.kVp / 511, 2));

      var metrics = {
        kVp: p.kVp,
        mA: p.mA,
        time: p.exposureTime,
        mAs: mAs,
        powerKW: (p.kVp * p.mA) / 1000,
        material: mat,
        generator: GENERATORS[p.generator] || GENERATORS.constant,
        totalFiltration: this.totalFiltration,
        addedFiltration: p.addedFiltration,
        inherentFiltration: p.inherentFiltration,
        anodeAngle: p.anodeAngle,
        focalSpot: p.focalSpot,
        sid: p.sid,
        oid: p.oid,
        maxEnergy: p.kVp,
        meanEnergy: meanEnergy,
        peakEnergy: peakE,
        charFraction: charFraction,
        bremFraction: 1 - charFraction,
        hvl: hvl,
        kerma1mGy: kerma1mGy,
        kermaDetectorGy: kerma1mGy / 1000,
        electrons: electrons,
        photons: photons,
        efficiency: efficiency,
        heatJ: heatJ,
        hu: hu,
        effectiveFocal: effectiveFocal,
        coverageCm: coverageCm,
        magnification: magnification,
        unsharpness: unsharpness,
        contrast: contrast,
        contrastRatio: contrastRatio,
        muWater: muWater,
        muBone: muBone,
        noiseSigma: noiseSigma,
        relOutput: relOutput,
        filamentTempC: filamentTempC,
        electronSpeedC: electronSpeedC,
        anodeHeatPct: this.anodeHeatJ / this.anodeCapacityJ,
        exposureCount: this.exposureCount,
        sessionKermaGy: this.sessionKermaGy
      };

      this._cache.metrics = metrics;
      return metrics;
    },

    /* Anode thermal state --------------------------------------------------- */

    addExposure: function () {
      if (this._cache.metrics) {
        this.anodeHeatJ += this._cache.metrics.heatJ;
        this.sessionKermaGy += this._cache.metrics.kerma1mGy / 1000;
      } else {
        this.anodeHeatJ += this.compute().heatJ;
        this.sessionKermaGy += this.compute().kerma1mGy / 1000;
      }
      this.exposureCount += 1;
      this._cache.metrics = null;
      return this;
    },

    cool: function (dtSeconds) {
      if (dtSeconds <= 0) return;
      this.anodeHeatJ *= Math.exp(-dtSeconds / 240);
      if (this.anodeHeatJ < 1) this.anodeHeatJ = 0;
      /* Heat state feeds anodeHeatPct in the cached metrics — keep it fresh. */
      this._cache.metrics = null;
    },

    anodeHeatFraction: function () {
      return clamp(this.anodeHeatJ / this.anodeCapacityJ, 0, 1);
    },

    /* Photon sampling for the animation ------------------------------------- */

    _ensureCdf: function () {
      if (this._cache.cdf) return this._cache.cdf;
      var raw = this._shapeSpectrum(this.p.kVp, this.p.material);
      var minE = Math.min(this.p.minSampleEnergy, Math.max(4, this.p.kVp - 2));
      var totalB = 0;
      var totalC = 0;
      var cB = [];
      var cC = [];
      var kept = [];
      for (var i = 0; i < raw.length; i++) {
        if (raw[i].e < minE) continue;
        kept.push(raw[i]);
        totalB += raw[i].brem * STEP;
        totalC += raw[i].char * STEP;
        cB.push(totalB);
        cC.push(totalC);
      }
      this._cache.cdf = {
        bins: kept,
        cB: cB,
        cC: cC,
        totalB: totalB,
        totalC: totalC,
        charProb: (totalB + totalC) > 0 ? totalC / (totalB + totalC) : 0
      };
      return this._cache.cdf;
    },

    samplePhoton: function () {
      var cdf = this._ensureCdf();
      var wantChar = Math.random() < cdf.charProb;
      var total = wantChar ? cdf.totalC : cdf.totalB;
      var arr = wantChar ? cdf.cC : cdf.cB;
      if (total <= 0) {
        return { energy: this.p.kVp * 0.6, characteristic: false };
      }
      var target = Math.random() * total;
      var lo = 0;
      var hi = arr.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (arr[mid] < target) lo = mid + 1; else hi = mid;
      }
      return {
        energy: cdf.bins[lo].e,
        characteristic: wantChar
      };
    },

    /* Transmission of one photon through the filtration (for the animation). */
    transmissionAt: function (energyKeV) {
      var rho = 2.7;
      return Math.exp(-logInterp(AL_MU_RHO, energyKeV) * rho * (this.totalFiltration / 10));
    }
  };

  InsertTube.MATERIALS = MATERIALS;
  InsertTube.GENERATORS = GENERATORS;
  InsertTube.DEFAULTS = DEFAULTS;
  InsertTube.ANODE_CAPACITY_J = ANODE_CAPACITY_J;

  /* Mass attenuation coefficient, cm²/g, for patient-tissue modelling. */
  InsertTube.muRho = function (kind, energy) {
    switch (kind) {
      case "bone": return logInterp(BONE_MU_RHO, energy);
      case "air": return logInterp(AIR_MU_RHO, energy);
      case "lung":
      case "fat":
      case "soft":
      default: return logInterp(WATER_MU_RHO, energy);
    }
  };

  /* Linear attenuation coefficient, cm⁻¹. */
  InsertTube.linearMu = function (kind, energy) {
    var density = { soft: 1.0, bone: 1.85, lung: 0.26, fat: 0.92, air: 0.0012 }[kind];
    if (density == null) density = 1.0;
    return InsertTube.muRho(kind, energy) * density;
  };

  global.InsertTube = InsertTube;
})(window);
