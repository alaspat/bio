/* ============================================================================
   TubeScene — a small software 3D renderer + interactive X-ray tube
   ----------------------------------------------------------------------------
   No WebGL and no external libraries: the scene is built from shaded polygon
   meshes, depth-sorted with a painter's algorithm, and projected through an
   orbit camera.  The anode disc carries a real conical target bevel whose
   slope is the selected anode angle; the disc spins around the tube axis.

   Exposes: window.TubeScene
   ========================================================================== */
(function (global) {
  "use strict";

  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  var LIGHT = vnorm([-0.45, 0.72, 0.55]);

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vmul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vnorm(a) { var l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vlerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rotX(p, center, angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var y = p[1] - center[1];
    var z = p[2] - center[2];
    return [p[0], center[1] + y * c - z * s, center[2] + y * s + z * c];
  }
  function rotXn(n, angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    return [n[0], n[1] * c - n[2] * s, n[1] * s + n[2] * c];
  }
  /* rotation about the vertical (Y) axis — used by the C-arm scene, whose
     arc pivots on a mast that sits on the axis itself. */
  function rotY(p, center, angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var x = p[0] - center[0];
    var z = p[2] - center[2];
    return [center[0] + x * c + z * s, p[1], center[2] - x * s + z * c];
  }
  function rotYn(n, angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    return [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c];
  }
  function mixColor(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function css(c, alpha) {
    return "rgba(" + Math.round(clamp(c[0], 0, 255)) + "," + Math.round(clamp(c[1], 0, 255)) + "," +
      Math.round(clamp(c[2], 0, 255)) + "," + alpha.toFixed(3) + ")";
  }

  function faceNormal(pts) {
    var a = vsub(pts[1], pts[0]);
    var b = vsub(pts[2], pts[0]);
    return vnorm(vcross(a, b));
  }

  function addFace(list, pts, color, alpha, opts) {
    opts = opts || {};
    var n = opts.normal || faceNormal(pts);
    if (opts.flip) n = vmul(n, -1);
    list.push({
      pts: pts,
      n: n,
      color: color,
      alpha: alpha,
      cull: opts.cull !== false,
      flat: !!opts.flat,
      depthBias: opts.depthBias || 0
    });
  }

  function addQuad(list, p0, p1, p2, p3, color, alpha, opts) {
    addFace(list, [p0, p1, p2, p3], color, alpha, opts);
  }

  function addCylinderX(list, x0, x1, cy, cz, r, seg, color, alpha, opts) {
    opts = opts || {};
    var a0 = opts.a0 == null ? 0 : opts.a0;
    var a1 = opts.a1 == null ? TAU : opts.a1;
    var full = Math.abs(a1 - a0 - TAU) < 0.001;
    for (var i = 0; i < seg; i++) {
      var t0 = a0 + (a1 - a0) * i / seg;
      var t1 = a0 + (a1 - a0) * (i + 1) / seg;
      var n0 = [0, Math.cos((t0 + t1) / 2), Math.sin((t0 + t1) / 2)];
      addQuad(list,
        [x0, cy + r * Math.cos(t0), cz + r * Math.sin(t0)],
        [x0, cy + r * Math.cos(t1), cz + r * Math.sin(t1)],
        [x1, cy + r * Math.cos(t1), cz + r * Math.sin(t1)],
        [x1, cy + r * Math.cos(t0), cz + r * Math.sin(t0)],
        color, alpha, { normal: n0, cull: opts.cull !== false });
    }
    if (opts.caps !== false) {
      addDiscCapX(list, x0, cy, cz, r, seg, color, alpha, -1, opts.cull !== false);
      addDiscCapX(list, x1, cy, cz, r, seg, color, alpha, 1, opts.cull !== false);
    }
    /* Rim outlines: previously pushed into a throwaway array (dead code).
       Callers that want rim outlines draw them explicitly with addLineLoop. */
  }

  function addDiscCapX(list, x, cy, cz, r, seg, color, alpha, dir, cull) {
    var n = [dir, 0, 0];
    for (var i = 0; i < seg; i++) {
      var t0 = i / seg * TAU;
      var t1 = (i + 1) / seg * TAU;
      addFace(list, [
        [x, cy, cz],
        [x, cy + r * Math.cos(t0), cz + r * Math.sin(t0)],
        [x, cy + r * Math.cos(t1), cz + r * Math.sin(t1)]
      ], color, alpha, { normal: n, cull: cull });
    }
  }

  function addCylinderY(list, y0, y1, cx, cz, r, seg, color, alpha, opts) {
    opts = opts || {};
    for (var i = 0; i < seg; i++) {
      var t0 = i / seg * TAU;
      var t1 = (i + 1) / seg * TAU;
      var n0 = [Math.cos((t0 + t1) / 2), 0, Math.sin((t0 + t1) / 2)];
      addQuad(list,
        [cx + r * Math.cos(t0), y0, cz + r * Math.sin(t0)],
        [cx + r * Math.cos(t1), y0, cz + r * Math.sin(t1)],
        [cx + r * Math.cos(t1), y1, cz + r * Math.sin(t1)],
        [cx + r * Math.cos(t0), y1, cz + r * Math.sin(t0)],
        color, alpha, { normal: n0, cull: opts.cull !== false });
    }
  }

  function addEllipsoid(list, cx, cy, cz, rx, ry, rz, segU, segV, color, alpha, opts) {
    opts = opts || {};
    for (var i = 0; i < segV; i++) {
      var v0 = -Math.PI / 2 + Math.PI * i / segV;
      var v1 = -Math.PI / 2 + Math.PI * (i + 1) / segV;
      for (var j = 0; j < segU; j++) {
        var u0 = TAU * j / segU;
        var u1 = TAU * (j + 1) / segU;
        var p0 = [cx + rx * Math.cos(v0) * Math.cos(u0), cy + ry * Math.sin(v0), cz + rz * Math.cos(v0) * Math.sin(u0)];
        var p1 = [cx + rx * Math.cos(v0) * Math.cos(u1), cy + ry * Math.sin(v0), cz + rz * Math.cos(v0) * Math.sin(u1)];
        var p2 = [cx + rx * Math.cos(v1) * Math.cos(u1), cy + ry * Math.sin(v1), cz + rz * Math.cos(v1) * Math.sin(u1)];
        var p3 = [cx + rx * Math.cos(v1) * Math.cos(u0), cy + ry * Math.sin(v1), cz + rz * Math.cos(v1) * Math.sin(u0)];
        var mx = (p0[0] + p2[0]) / 2 - cx;
        var my = (p0[1] + p2[1]) / 2 - cy;
        var mz = (p0[2] + p2[2]) / 2 - cz;
        var n = vnorm([mx / (rx * rx), my / (ry * ry), mz / (rz * rz)]);
        addFace(list, [p0, p1, p2, p3], color, alpha, { normal: n, cull: opts.cull !== false });
      }
    }
  }

  function addBox(list, cx, cy, cz, sx, sy, sz, color, alpha, opts) {
    var x0 = cx - sx / 2, x1 = cx + sx / 2;
    var y0 = cy - sy / 2, y1 = cy + sy / 2;
    var z0 = cz - sz / 2, z1 = cz + sz / 2;
    addFace(list, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], color, alpha, { normal: [-1, 0, 0], cull: opts && opts.cull !== false });
    addFace(list, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], color, alpha, { normal: [1, 0, 0], cull: opts && opts.cull !== false });
    addFace(list, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], color, alpha, { normal: [0, 1, 0], cull: opts && opts.cull !== false });
    addFace(list, [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], color, alpha, { normal: [0, -1, 0], cull: opts && opts.cull !== false });
    addFace(list, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], color, alpha, { normal: [0, 0, 1], cull: opts && opts.cull !== false });
    addFace(list, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], color, alpha, { normal: [0, 0, -1], cull: opts && opts.cull !== false });
  }

  function addLine(list, a, b, color, width, alpha) {
    list.push({ a: a, b: b, color: color, width: width, alpha: alpha });
  }

  function addLineLoop(list, pts, color, width, alpha) {
    for (var i = 0; i < pts.length; i++) {
      addLine(list, pts[i], pts[(i + 1) % pts.length], color, width, alpha);
    }
  }

  /* elliptical cap (used to close lofted bodies) */
  function addEllipticalCapX(list, x, cy, cz, ry, rz, seg, color, alpha, dir, cull) {
    var n = [dir, 0, 0];
    for (var i = 0; i < seg; i++) {
      var t0 = i / seg * TAU;
      var t1 = (i + 1) / seg * TAU;
      addFace(list, [
        [x, cy, cz],
        [x, cy + ry * Math.cos(t0), cz + rz * Math.sin(t0)],
        [x, cy + ry * Math.cos(t1), cz + rz * Math.sin(t1)]
      ], color, alpha, { normal: n, cull: cull });
    }
  }

  /* loft a body from a list of elliptical cross-sections stacked along x */
  function addLoftX(list, sections, seg, color, alpha, opts) {
    opts = opts || {};
    var cull = opts.cull !== false;
    for (var s = 0; s < sections.length - 1; s++) {
      var A = sections[s];
      var B = sections[s + 1];
      for (var i = 0; i < seg; i++) {
        var t0 = i / seg * TAU;
        var t1 = (i + 1) / seg * TAU;
        var mid = (t0 + t1) / 2;
        var n = vnorm([0, Math.cos(mid) / (B.ry || 1), Math.sin(mid) / (B.rz || 1)]);
        addQuad(list,
          [A.x, A.cy + A.ry * Math.cos(t0), A.cz + A.rz * Math.sin(t0)],
          [A.x, A.cy + A.ry * Math.cos(t1), A.cz + A.rz * Math.sin(t1)],
          [B.x, B.cy + B.ry * Math.cos(t1), B.cz + B.rz * Math.sin(t1)],
          [B.x, B.cy + B.ry * Math.cos(t0), B.cz + B.rz * Math.sin(t0)],
          color, alpha, { normal: n, cull: cull });
      }
    }
    if (opts.caps !== false) {
      var first = sections[0];
      var last = sections[sections.length - 1];
      var capCol = opts.capColor || color;
      var capA = opts.capAlpha == null ? alpha : opts.capAlpha;
      addEllipticalCapX(list, first.x, first.cy, first.cz, first.ry, first.rz, seg, capCol, capA, -1, cull);
      addEllipticalCapX(list, last.x, last.cy, last.cz, last.ry, last.rz, seg, capCol, capA, 1, cull);
    }
  }

  /* interpolate the cross-section of a lofted body at a given x */
  function bodySectionAt(sections, x) {
    var last = sections[sections.length - 1];
    if (x <= sections[0].x) return sections[0];
    if (x >= last.x) return last;
    for (var i = 0; i < sections.length - 1; i++) {
      var A = sections[i];
      var B = sections[i + 1];
      if (x >= A.x && x <= B.x) {
        var t = (x - A.x) / (B.x - A.x);
        return { x: x, ry: A.ry + (B.ry - A.ry) * t, rz: A.rz + (B.rz - A.rz) * t };
      }
    }
    return last;
  }

  /* circle of points in the y-z plane at a given x (for ring outlines) */
  function circlePts(x, r, seg, cy, cz) {
    var out = [];
    var y0 = cy || 0, z0 = cz || 0;
    for (var i = 0; i < seg; i++) {
      var t = i / seg * TAU;
      out.push([x, y0 + r * Math.cos(t), z0 + r * Math.sin(t)]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ scene */
  function TubeScene(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.yaw = -38 * DEG;
    this.pitch = 18 * DEG;
    this.dist = 148;
    this.target = [0, -23, 0];
    this.spin = 0;
    this.tube = null;
    this.machine = { rpm: 0, beam: false, filamentGlow: 0, prep: 0, exposure: 0 };
    this.staticFaces = [];
    this.staticLines = [];
    this.anodeFaces = [];
    this.anodeLines = [];
    this.beamFaces = [];
    this.beamLines = [];
    this.patientFaces = [];
    this.patientLines = [];
    this.detectorFaces = [];
    this.particles = [];
    this.sparks = [];
    this.anchors = {};
    this.angle = 12;
    this.bodyCm = 24;
    this.captured = false;
    this.orbitActive = false;
    this.hoverPart = null;
    /* depth-fog ramp, tuned per scene (the room scenes are far larger) */
    this.fogNear = 210;
    this.fogRange = 340;
    this.fogMax = 0.26;
    this._buildScene();
    this._bindOrbit();
  }

  TubeScene.prototype = {
    constructor: TubeScene,

    /* Scenes that subclass TubeScene (CT room, C-arm room) replace this with
       their own geometry builders; the tube lab keeps its four default parts. */
    _buildScene: function () {
      this._buildStatic();
      this._buildAnode(this.angle);
      this._buildPatient(this.bodyCm);
      this._buildDetector();
    },

    setTube: function (tube) {
      this.tube = tube;
      if (this.angle !== tube.p.anodeAngle) {
        this.angle = tube.p.anodeAngle;
        this._buildAnode(this.angle);
      }
      if (this.bodyCm !== tube.p.bodyThickness) {
        this.bodyCm = tube.p.bodyThickness;
        this._buildPatient(this.bodyCm);
      }
    },

    setMachine: function (machine) {
      this.machine = machine;
    },

    setImage: function (shot) {
      this.captured = !!shot;
      this.detectorFaces = [];
      this._buildDetector();
      if (!shot) return;
      var cols = 14, rows = 17;
      var plate = { x0: -17, x1: 17, z0: -20.6, z1: 20.6, y: -52.0 };
      var iw = shot.width, ih = shot.height;
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var sum = 0, n = 0;
          var x0 = Math.floor(c / cols * iw), x1 = Math.floor((c + 1) / cols * iw);
          var y0 = Math.floor(r / rows * ih), y1 = Math.floor((r + 1) / rows * ih);
          for (var y = y0; y < y1; y += 2) {
            for (var x = x0; x < x1; x += 2) { sum += shot.gray[y * iw + x]; n++; }
          }
          var g = n ? sum / n : 0;
          var px0 = plate.x0 + c / cols * (plate.x1 - plate.x0);
          var px1 = plate.x0 + (c + 1) / cols * (plate.x1 - plate.x0);
          var pz0 = plate.z0 + r / rows * (plate.z1 - plate.z0);
          var pz1 = plate.z0 + (r + 1) / rows * (plate.z1 - plate.z0);
          addQuad(this.detectorFaces,
            [px0, plate.y, pz0], [px1, plate.y, pz0], [px1, plate.y, pz1], [px0, plate.y, pz1],
            [g, g, g], 1, { flat: true, cull: false, normal: [0, 1, 0] });
        }
      }
    },

    resetView: function () {
      this.yaw = -38 * DEG;
      this.pitch = 18 * DEG;
      this.dist = 148;
      this.target = [0, -23, 0];
    },

    /* ------------------------------------------------------------- geometry */
    _buildStatic: function () {
      var f = this.staticFaces;
      var l = this.staticLines;
      var steelDark = [66, 72, 82];
      var glass = [126, 198, 238];
      var ceramic = [232, 228, 216];      /* white HV insulator */
      var ceramicDark = [198, 192, 178];
      var dark = [26, 32, 40];
      var i, k, t;

      /* ==================================================================
         INSERT — the evacuated glass envelope. The space between the
         cathode and the anode holds nothing but vacuum and the thin glass
         wall, so only the two electrodes read as solid parts.
         ================================================================== */

      /* --- glass neck joining the cathode end to the anode end --- */
      addCylinderX(f, -24, -5, 0, 0, 9.2, 40, glass, 0.075, { cull: false, caps: false });
      addLineLoop(l, circlePts(-24, 9.22, 40), [128, 200, 238], 1, 0.3);
      addLineLoop(l, circlePts(-5, 9.22, 40), [128, 200, 238], 1, 0.3);
      addLine(l, [-24, 9.2, 0], [-5, 9.2, 0], [128, 200, 238], 1, 0.3);

      /* --- anode-end glass bulb (encloses the anode and the rotor) --- */
      var bulb = [
        { x: -5, cy: 0, cz: 0, ry: 9.2, rz: 9.2 },
        { x: -1, cy: 0, cz: 0, ry: 11.4, rz: 11.4 },
        { x: 3, cy: 0, cz: 0, ry: 12.4, rz: 12.4 },
        { x: 7, cy: 0, cz: 0, ry: 12.0, rz: 12.0 },
        { x: 11, cy: 0, cz: 0, ry: 8.6, rz: 8.6 },
        { x: 13.5, cy: 0, cz: 0, ry: 4.6, rz: 4.6 }
      ];
      addLoftX(f, bulb, 36, glass, 0.075, { cull: false, capColor: glass, capAlpha: 0.05 });
      [-5, -1, 3, 7, 11].forEach(function (xx) {
        addLineLoop(l, circlePts(xx, bodySectionAt(bulb, xx).ry, 36), [128, 200, 238], 1, 0.3);
      });

      /* --- cathode-end glass cone and dome --- */
      var cbulb = [
        { x: -37, cy: 0, cz: 0, ry: 3.8, rz: 3.8 },
        { x: -34, cy: 0, cz: 0, ry: 6.6, rz: 6.6 },
        { x: -30, cy: 0, cz: 0, ry: 8.0, rz: 8.0 },
        { x: -24, cy: 0, cz: 0, ry: 9.2, rz: 9.2 }
      ];
      addLoftX(f, cbulb, 32, glass, 0.075, { cull: false, capColor: glass, capAlpha: 0.05 });
      [-24, -30, -34].forEach(function (xx) {
        addLineLoop(l, circlePts(xx, bodySectionAt(cbulb, xx).ry, 32), [128, 200, 238], 1, 0.3);
      });

      /* --- cathode assembly, seen through the glass --- */
      var a0 = 115 * DEG, a1 = 425 * DEG;
      addCylinderX(f, -33.5, -27.5, 0, 0, 6.0, 24, steelDark, 0.95, { a0: a0, a1: a1, caps: false });
      addCylinderX(f, -33.1, -27.5, 0, 0, 4.8, 24, [18, 22, 28], 0.92, { a0: a0, a1: a1, caps: false });
      addDiscCapX(f, -33.5, 0, 0, 6.0, 24, steelDark, 0.95, -1, true);
      addDiscCapX(f, -33.1, 0, 0, 4.8, 24, [18, 22, 28], 0.92, 1, true);
      var rimPts = [];
      for (k = 0; k < 24; k++) {
        var ta = a0 + (a1 - a0) * k / 24;
        rimPts.push([-27.5, 6.0 * Math.cos(ta), 6.0 * Math.sin(ta)]);
      }
      addLineLoop(l, rimPts, [152, 186, 212], 1.5, 0.6);

      /* filament helix + leads */
      var coil = [];
      for (k = 0; k <= 60; k++) {
        t = k / 60;
        var ang = t * TAU * 5;
        coil.push([-31.6 + t * 3.2, 2.2 * Math.cos(ang), 2.2 * Math.sin(ang)]);
      }
      for (k = 0; k < coil.length - 1; k++) addLine(l, coil[k], coil[k + 1], [255, 190, 110], 1.5, 0.45);
      addLine(l, [-36, 2.2, 0], [-31.6, 2.2, 0], [122, 142, 158], 1.2, 0.55);
      addLine(l, [-36, -2.2, 0], [-31.6, -2.2, 0], [122, 142, 158], 1.2, 0.55);

      /* --- ceramic high-voltage insulator and cable (cathode end) --- */
      addCylinderX(f, -42.5, -37, 0, 0, 3.5, 22, ceramic, 1, { caps: true });
      for (i = 0; i < 3; i++) {
        var chx = -41.2 + i * 1.9;
        addCylinderX(f, chx - 0.26, chx + 0.26, 0, 0, 4.05, 22, ceramicDark, 1, { cull: false, caps: false });
        addLineLoop(l, circlePts(chx + 0.26, 4.07, 22), [216, 208, 190], 1, 0.4);
      }
      addCylinderX(f, -44.6, -42.5, 0, 0, 3.7, 22, steelDark, 1, { caps: true });
      addCylinderX(f, -51, -44.6, 0, 0, 1.5, 14, [34, 38, 46], 1, { caps: true });

      /* --- stator coils wrapped around the rotor --- */
      for (i = 0; i < 8; i++) {
        var sa = i / 8 * TAU;
        addCylinderX(f, 7.4, 12.2, 9.4 * Math.cos(sa), 9.4 * Math.sin(sa), 1.25, 10,
          [124, 82, 54], 0.9, { caps: true });
      }
      var statorPts = [];
      for (k = 0; k < 28; k++) {
        var st = k / 28 * TAU;
        statorPts.push([9.8, 10.6 * Math.cos(st), 10.6 * Math.sin(st)]);
      }
      addLineLoop(l, statorPts, [154, 104, 68], 1.1, 0.45);

      /* --- beryllium window facing the patient --- */
      addQuad(f, [-2, -11.5, -5], [5, -11.5, -5], [5, -11.5, 5], [-2, -11.5, 5],
        [92, 214, 245], 0.28, { flat: true, cull: false, normal: [0, -1, 0] });
      addLineLoop(l, [[-2, -11.5, -5], [5, -11.5, -5], [5, -11.5, 5], [-2, -11.5, 5]],
        [132, 235, 255], 1.5, 0.7);

      /* --- protective housing: faint translucent shell with end rings --- */
      addCylinderX(f, -44, 16, 0, 0, 15.5, 32, [54, 76, 92], 0.055,
        { cull: false, caps: false });
      for (i = 0; i < 6; i++) {
        var ha = i / 6 * TAU;
        addLine(l, [-44, 15.5 * Math.cos(ha), 15.5 * Math.sin(ha)],
          [16, 15.5 * Math.cos(ha), 15.5 * Math.sin(ha)], [82, 118, 142], 1, 0.16);
      }
      addLineLoop(l, circlePts(-44, 15.7, 32), [92, 132, 158], 1.1, 0.22);
      addLineLoop(l, circlePts(16, 15.7, 32), [92, 132, 158], 1.1, 0.22);
      addDiscCapX(f, -44, 0, 0, 15.5, 32, dark, 0.16, -1, false);
      addDiscCapX(f, 16, 0, 0, 15.5, 32, dark, 0.16, 1, false);

      /* --- collimator leaves --- */
      addBox(f, -9.5, -22.5, 0, 3, 4.5, 16, [100, 112, 124], 0.9);
      addBox(f, 9.5, -22.5, 0, 3, 4.5, 16, [100, 112, 124], 0.9);
      addBox(f, 0, -22.5, -9, 16, 4.5, 3, [92, 104, 116], 0.9);
      addBox(f, 0, -22.5, 9, 16, 4.5, 3, [92, 104, 116], 0.9);

      /* --- table --- */
      addBox(f, 0, -54.5, 0, 70, 4, 50, [28, 40, 50], 0.95);
      addBox(f, 0, -57.5, 0, 20, 3, 20, [22, 32, 42], 0.9);

      this.anchors.filament = [-31.4, 0, 0];
      this.anchors.cup = [-30.5, 6.4, 2];
      this.anchors.envelope = [-16, 9.4, 3];
      this.anchors.window = [1, -11.7, 5];
      this.anchors.collimator = [10, -22.5, 6];
    },

    _buildAnode: function (angleDeg) {
      var f = [];
      var l = [];
      var beam = [];
      var beamLines = [];
      var moly = [152, 158, 168];        /* molybdenum target body */
      var molyDark = [104, 110, 122];
      var tungsten = [242, 246, 252];    /* tungsten-rhenium focal track */
      var trackHot = [255, 172, 98];
      var graphite = [44, 46, 52];       /* graphite heat-sink backing */
      var graphiteRing = [74, 78, 86];
      var rotor = [124, 122, 128];
      var rotorDark = [72, 72, 78];

      /* a CT target: 135 mm class disc, 7-12 deg bevel, tungsten-rhenium face
         on molybdenum with a thick graphite backing and a rotor behind it */
      var tanA = Math.tan(angleDeg * DEG);
      var rInner = 1.6;      /* hub front, at the axis */
      var rTrackIn = 5.4;    /* focal-track inner radius */
      var rTrackOut = 7.8;   /* focal-track outer radius */
      var rOuter = 9.0;      /* target outer radius */
      var xFace = -1.0;      /* front plane of the target (faces the cathode) */
      var seg = 48;
      var i, k;

      function xAt(r) { return xFace + (r - rInner) * tanA; }
      var bevelX = xAt(rOuter);
      var bodyX = bevelX + 1.9;     /* end of the molybdenum body */
      var backX = bodyX + 4.0;      /* end of the graphite heat sink */
      var hubX = backX + 1.5;       /* end of the bearing hub */
      var rotorX = hubX + 3.6;      /* end of the rotor drum */

      /* hub front plate facing the cathode */
      addDiscCapX(f, xFace, 0, 0, rInner, seg, molyDark, 1, -1, true);

      /* beveled target face, split into three concentric zones so the narrow
         focal track reads clearly against the rest of the disc */
      function bevelRing(rA, rB, color, alpha) {
        var xA = xAt(rA);
        var xB = xAt(rB);
        for (var q = 0; q < seg; q++) {
          var u0 = q / seg * TAU;
          var u1 = (q + 1) / seg * TAU;
          addQuad(f,
            [xA, rA * Math.cos(u0), rA * Math.sin(u0)],
            [xA, rA * Math.cos(u1), rA * Math.sin(u1)],
            [xB, rB * Math.cos(u1), rB * Math.sin(u1)],
            [xB, rB * Math.cos(u0), rB * Math.sin(u0)],
            color, alpha, { cull: false });
        }
      }
      bevelRing(rInner, rTrackIn, moly, 1);
      bevelRing(rTrackIn, rTrackOut, tungsten, 1);
      bevelRing(rTrackOut, rOuter, moly, 1);

      /* rim edge highlights */
      [rInner, rTrackIn, rTrackOut, rOuter].forEach(function (rr) {
        addLineLoop(l, circlePts(xAt(rr), rr, seg), [214, 226, 238], rr === rOuter ? 1.5 : 1, 0.42);
      });

      /* molybdenum target body */
      addCylinderX(f, bevelX, bodyX, 0, 0, rOuter, seg, moly, 1, { caps: false });

      /* graphite heat-sink backing */
      addCylinderX(f, bodyX, backX, 0, 0, rOuter, seg, graphite, 1, { caps: false });
      addDiscCapX(f, backX, 0, 0, rOuter, seg, graphite, 1, 1, true);
      for (k = 1; k <= 2; k++) {
        addLineLoop(l, circlePts(backX + 0.03, rOuter * (0.5 + k * 0.17), seg), graphiteRing, 1, 0.5);
      }

      /* bearing hub and rotor drum (the squirrel-cage rotor) */
      addCylinderX(f, backX, hubX, 0, 0, 2.6, 20, [162, 166, 174], 1, { caps: true });
      addCylinderX(f, hubX, rotorX, 0, 0, 3.6, 20, rotor, 1, { caps: true });
      for (k = 0; k < 10; k++) {
        var ra = k / 10 * TAU;
        addLine(l, [hubX, 3.55 * Math.cos(ra), 3.55 * Math.sin(ra)],
          [rotorX, 3.55 * Math.cos(ra), 3.55 * Math.sin(ra)], rotorDark, 1.2, 0.6);
      }
      addLineLoop(l, circlePts(rotorX, 3.6, 20), [152, 152, 158], 1.1, 0.5);

      /* the bright focal track that spins with the disc */
      var rTrackMid = (rTrackIn + rTrackOut) / 2;
      var track = [];
      for (i = 0; i < seg; i++) {
        var tt = i / seg * TAU;
        track.push([xAt(rTrackMid) - 0.04, rTrackMid * Math.cos(tt), rTrackMid * Math.sin(tt)]);
      }
      addLineLoop(l, track, trackHot, 2.4, 0.5);
      this.trackRadius = rTrackMid;
      this.trackX = xAt(rTrackMid);

      /* focal spot sits on the track, on the side facing the window */
      this.focal = [Math.max(0.02, xAt(rTrackMid)), -rTrackMid, 0];
      this.bevelX = bevelX;

      /* electron path from the cathode */
      addLine(l, [-30, 0, 0], this.focal, [110, 225, 255], 1, 0.18);

      /* X-ray cone: focal spot -> detector field */
      var detY = -52.0;
      var corners = [[-17, detY, -20.6], [17, detY, -20.6], [17, detY, 20.6], [-17, detY, 20.6]];
      for (var q2 = 0; q2 < 4; q2++) {
        addFace(beam, [this.focal, corners[q2], corners[(q2 + 1) % 4]], [80, 220, 255], 0.045,
          { flat: true, cull: false });
        addLine(beamLines, this.focal, corners[q2], [110, 225, 255], 1, 0.16);
      }

      this.anodeFaces = f;
      this.anodeLines = l;
      this.beamFaces = beam;
      this.beamLines = beamLines;
      this.anchors.anode = [3.4, -9.2, 5];
    },

    _buildPatient: function (bodyCm) {
      var f = [];
      var l = [];
      var bone = [236, 227, 209];
      var skin = [206, 160, 130];
      var lungC = [86, 148, 188];
      var heartC = [184, 90, 90];
      var liverC = [152, 106, 90];
      var AP_Y = -42;      /* patient lies supine: x = head-feet, y = AP, z = left-right */

      /* torso built by lofting elliptical cross-sections: narrow neck, broad
         shoulders, tapering chest and a wider pelvis, so the silhouette reads
         as a real supine body rather than a single ellipsoid */
      var torso = [
        { x: -33, ry: 4.6, rz: 5.6, cy: AP_Y, cz: 0 },
        { x: -29, ry: 5.4, rz: 7.4, cy: AP_Y, cz: 0 },
        { x: -25, ry: 7.4, rz: 11.8, cy: AP_Y, cz: 0 },
        { x: -21, ry: 8.6, rz: 14.6, cy: AP_Y, cz: 0 },
        { x: -16, ry: 9.6, rz: 13.2, cy: AP_Y, cz: 0 },
        { x: -9, ry: 10.2, rz: 12.2, cy: AP_Y, cz: 0 },
        { x: -1, ry: 10.0, rz: 11.6, cy: AP_Y, cz: 0 },
        { x: 7, ry: 9.2, rz: 10.6, cy: AP_Y, cz: 0 },
        { x: 14, ry: 8.6, rz: 9.6, cy: AP_Y, cz: 0 },
        { x: 20, ry: 8.4, rz: 10.4, cy: AP_Y, cz: 0 },
        { x: 25, ry: 7.4, rz: 9.6, cy: AP_Y, cz: 0 }
      ];
      addLoftX(f, torso, 24, skin, 0.15, { cull: false, capColor: skin, capAlpha: 0.11 });

      /* neck and head */
      addCylinderX(f, -36, -30.5, AP_Y + 1, 0, 4.2, 16, skin, 0.15, { cull: false });
      addEllipsoid(f, -39, AP_Y + 1.5, 0, 5.2, 6.4, 6.2, 16, 12, skin, 0.14, { cull: false });

      /* arms resting along the sides */
      addCylinderX(f, -23, 9, AP_Y + 0.5, -16.4, 3.0, 14, skin, 0.13, { cull: false });
      addCylinderX(f, -23, 9, AP_Y + 0.5, 16.4, 3.0, 14, skin, 0.13, { cull: false });

      /* lungs, mediastinum / heart and the liver shadow */
      addEllipsoid(f, -6, AP_Y + 1, -5.6, 10.5, 6.6, 4.8, 16, 12, lungC, 0.13, { cull: false });
      addEllipsoid(f, -6, AP_Y + 1, 5.6, 10.5, 6.6, 4.8, 16, 12, lungC, 0.13, { cull: false });
      addEllipsoid(f, 5, AP_Y + 0.5, 2.2, 6.6, 6.0, 4.0, 14, 10, heartC, 0.14, { cull: false });
      addEllipsoid(f, 15, AP_Y + 0.5, 5.5, 5.5, 6.5, 5.5, 14, 10, liverC, 0.12, { cull: false });

      /* rib cage: elliptical rings that follow the torso silhouette */
      for (var i = 0; i < 11; i++) {
        var rx = -20 + i * 3.6;
        var sec = bodySectionAt(torso, rx);
        var ry = sec.ry * 0.93;
        var rz = sec.rz * 0.93;
        var pts = [];
        for (var k = 0; k < 26; k++) {
          var t = k / 26 * TAU;
          pts.push([rx, AP_Y + ry * Math.cos(t), rz * Math.sin(t)]);
        }
        addLineLoop(l, pts, bone, 1.7, 0.42);
      }

      /* spine: stacked vertebral bodies down the posterior side */
      for (var v = 0; v < 13; v++) {
        var sx = -20 + v * 3.4;
        var ssec = bodySectionAt(torso, sx);
        var sy = AP_Y - ssec.ry * 0.62;
        addCylinderX(f, sx - 1.0, sx + 1.0, sy, 0, 1.9, 12, bone, 0.85, { cull: false });
        addLine(l, [sx, sy - 1.6, 0], [sx, sy - 3.4, 0], bone, 1.6, 0.45);
      }

      /* sternum and clavicles running out to the shoulders */
      addBox(f, -13, AP_Y + 8.6, 0, 11, 1.4, 3.4, bone, 0.55, { cull: false });
      addLine(l, [-19.5, AP_Y + 7.4, 1.5], [-22, AP_Y + 7.0, 11.5], bone, 2.2, 0.5);
      addLine(l, [-19.5, AP_Y + 7.4, -1.5], [-22, AP_Y + 7.0, -11.5], bone, 2.2, 0.5);

      this.patientFaces = f;
      this.patientLines = l;
      this.anchors.patient = [10, AP_Y + 8, 9];
      this.anchors.spine = [-2, AP_Y - 6, -6];
      this.bodyCm = bodyCm;
      this.patientTop = -36;
      this.patientBottom = -52;
    },

    _buildDetector: function () {
      var f = this.detectorFaces;
      addBox(f, 0, -53.7, 0, 46, 2.2, 50, [24, 38, 48], 1);
      addQuad(f, [-17, -52.5, -20.6], [17, -52.5, -20.6], [17, -52.5, 20.6], [-17, -52.5, 20.6],
        [10, 19, 25], 1, { flat: true, cull: false, normal: [0, 1, 0] });
      var frame = [];
      for (var k = 0; k < 4; k++) {
        var pts = [[-17.5, -52.4, -21.1], [17.5, -52.4, -21.1], [17.5, -52.4, 21.1], [-17.5, -52.4, 21.1]];
        frame.push(pts[k]);
      }
      addLineLoop(this.staticLines, frame, [70, 200, 235], 1.4, 0.5);
      this.anchors.detector = [14, -52, 12];
    },

    /* ------------------------------------------------------------- camera */
    _updateCamera: function (W, H) {
      var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      this.f = Math.min(W, H) * 1.5;
      this.pos = [
        this.target[0] + this.dist * sy * cp,
        this.target[1] + this.dist * sp,
        this.target[2] + this.dist * cy * cp
      ];
      this.forward = vnorm(vsub(this.target, this.pos));
      this.right = vnorm(vcross(this.forward, [0, 1, 0]));
      this.up = vnorm(vcross(this.right, this.forward));
      this.W = W;
      this.H = H;
    },

    _project: function (p) {
      var v = vsub(p, this.pos);
      var cz = vdot(v, this.forward);
      if (cz < 3) return null;
      var sx = this.W / 2 + vdot(v, this.right) * this.f / cz;
      var sy = this.H / 2 - vdot(v, this.up) * this.f / cz;
      return [sx, sy, cz];
    },

    /* ---------------------------------------------------------- interaction */
    _bindOrbit: function () {
      var self = this;
      var pointers = new Map();
      var lastX = 0, lastY = 0, pinch = 0, dragging = false;

      function down(e) {
        self.canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 1) {
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
          self.orbitActive = true;
          self.canvas.style.cursor = "grabbing";
        } else if (pointers.size === 2) {
          var pts = Array.from(pointers.values());
          pinch = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        }
      }

      function move(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 2) {
          var pts = Array.from(pointers.values());
          var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
          if (pinch > 0) self.dist = clamp(self.dist * (pinch / d), self.minDist || 105, self.maxDist || 300);
          pinch = d;
          return;
        }
        if (!dragging) return;
        var dx = e.clientX - lastX;
        var dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        self.yaw -= dx * 0.008;
        self.pitch = clamp(self.pitch + dy * 0.006, -12 * DEG, 62 * DEG);
      }

      function up(e) {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) {
          dragging = false;
          self.canvas.style.cursor = "grab";
        }
        pinch = 0;
      }

      this.canvas.style.cursor = "grab";
      this.canvas.addEventListener("pointerdown", down);
      this.canvas.addEventListener("pointermove", move);
      this.canvas.addEventListener("pointerup", up);
      this.canvas.addEventListener("pointercancel", up);
      this.canvas.addEventListener("pointerleave", up);
      this.canvas.addEventListener("wheel", function (e) {
        e.preventDefault();
        self.dist = clamp(self.dist * (1 + Math.sign(e.deltaY) * 0.07), self.minDist || 105, self.maxDist || 300);
      }, { passive: false });
      this.canvas.addEventListener("dblclick", function () { self.resetView(); });
    },

    /* -------------------------------------------------------------- update */
    _spinStep: function (dt) {
      var rpm = this.machine.rpm || 0;
      this.spin += dt * (rpm / 9000) * 20;
      if (this.spin > TAU * 1000) this.spin -= TAU * 1000;
      this._updateParticles(dt);
    },

    _updateParticles: function (dt) {
      var m = this.machine;
      var self = this;
      if (!this.tube) return;
      var mA = this.tube.p.mA;
      var beam = !!m.beam;
      var rate = beam ? clamp(mA * 0.9, 8, 220) : 0;
      this._spawnAcc = (this._spawnAcc || 0) + rate * dt;
      var n = Math.min(8, Math.floor(this._spawnAcc));
      this._spawnAcc -= n;
      for (var i = 0; i < n; i++) {
        this.particles.push({
          type: "e",
          p: [-27 + Math.random() * 2, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4],
          target: [this.focal[0], this.focal[1], this.focal[2]],
          t: 0,
          dur: 0.35 + Math.random() * 0.3
        });
      }

      for (var k = this.particles.length - 1; k >= 0; k--) {
        var part = this.particles[k];
        if (part.type === "e") {
          part.t += dt / part.dur;
          if (part.t >= 1) {
            this._spawnPhoton();
            this.sparks.push({ p: this.focal.slice(), r: 1, life: 1, c: [255, 220, 160] });
            this.particles.splice(k, 1);
          }
        } else {
          part.p = vadd(part.p, vmul(part.v, dt));
          if (!part.checked && part.p[1] < -32) {
            part.checked = true;
            if (Math.random() > this.tube.transmissionAt(part.e)) {
              this.sparks.push({ p: part.p.slice(), r: 1.2, life: 1, c: part.c });
              this.particles.splice(k, 1);
              continue;
            }
          }
          if (part.p[1] < -52.5) {
            this.sparks.push({ p: part.p.slice(), r: 1.4, life: 1, c: part.c });
            this.particles.splice(k, 1);
          }
        }
      }
      for (var s = this.sparks.length - 1; s >= 0; s--) {
        var sp = this.sparks[s];
        sp.life -= dt * 2.4;
        sp.r += dt * 2.2;
        if (sp.life <= 0) this.sparks.splice(s, 1);
      }
    },

    _spawnPhoton: function () {
      var det = [
        (Math.random() - 0.5) * 34,
        -52,
        (Math.random() - 0.5) * 41
      ];
      var dir = vnorm(vsub(det, this.focal));
      var ph = this.tube.samplePhoton();
      var color = ph.characteristic ? [201, 166, 255] :
        ph.energy < 25 ? [255, 122, 92] :
        ph.energy < 45 ? [255, 176, 102] :
        ph.energy < 70 ? [255, 224, 138] : [200, 244, 255];
      this.particles.push({
        type: "x",
        p: this.focal.slice(),
        v: vmul(dir, 70),
        e: ph.energy,
        c: color,
        checked: false
      });
      if (this.particles.length > 380) this.particles.shift();
    },

    /* ---------------------------------------------------------------- draw */
    draw: function (dt) {
      var canvas = this.canvas;
      var rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      var cw = Math.round(rect.width * dpr);
      var ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      var ctx = this.ctx;
      var W = rect.width;
      var H = rect.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      this._drawBackground(ctx, W, H);
      this._updateCamera(W, H);
      this._drawBackdrop(ctx, W, H);
      this._update(dt);

      var items = [];
      this._collectScene(items);
      items.sort(function (a, b) { return b.depth - a.depth; });

      for (var i = 0; i < items.length; i++) this._drawItem(ctx, items[i]);

      this._drawSceneOverlay(ctx, W, H);

      /* vignette */
      var vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.8);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    },

    /* --------------------------------------------------------------- hooks
       The four methods below are the override points for derived scenes
       (CTScene / FluoroScene).  Their defaults reproduce the tube lab. */

    _drawBackground: function (ctx, W, H) {
      var bg = ctx.createRadialGradient(W * 0.5, H * 0.2, 20, W * 0.5, H * 0.6, Math.max(W, H) * 0.9);
      bg.addColorStop(0, "#0a1722");
      bg.addColorStop(1, "#05090d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    },

    _drawBackdrop: function (ctx, W, H) {
      this._drawFloor(ctx);
    },

    _update: function (dt) {
      this._spinStep(dt);
    },

    _collectScene: function (items) {
      this._collectFaces(items, this.staticFaces, null);
      this._collectFaces(items, this.patientFaces, null);
      this._collectFaces(items, this.detectorFaces, null);
      if (this.machine.beam) this._collectFaces(items, this.beamFaces, null);
      this._collectFaces(items, this.anodeFaces, { center: [2, 0, 0], angle: this.spin });
      this._collectLines(items, this.staticLines, null);
      this._collectLines(items, this.patientLines, null);
      if (this.machine.beam) this._collectLines(items, this.beamLines, null);
      this._collectLines(items, this.anodeLines, { center: [2, 0, 0], angle: this.spin });
    },

    _drawSceneOverlay: function (ctx, W, H) {
      this._drawParticles(ctx);
      this._drawGlows(ctx);
      this._drawMarkers(ctx);
      this._drawInset(ctx, W, H);
    },

    _collectFaces: function (items, faces, rot) {
      var rotFn = rot && rot.axis === "y" ? rotY : rotX;
      var rotFnN = rot && rot.axis === "y" ? rotYn : rotXn;
      for (var i = 0; i < faces.length; i++) {
        var face = faces[i];
        var pts = face.pts;
        var projected = [];
        var depth = 0;
        var cx = 0, cy = 0, cz = 0;
        var n = face.n;
        var behind = false;
        for (var j = 0; j < pts.length; j++) {
          var p = rot ? rotFn(pts[j], rot.center, rot.angle) : pts[j];
          var pr = this._project(p);
          if (!pr) { behind = true; break; }
          projected.push(pr);
          depth += pr[2];
          cx += p[0]; cy += p[1]; cz += p[2];
        }
        if (behind) continue;
        depth /= pts.length;
        cx /= pts.length; cy /= pts.length; cz /= pts.length;
        if (rot) n = rotFnN(n, rot.angle);
        var toCam = vsub(this.pos, [cx, cy, cz]);
        if (face.cull && vdot(n, toCam) <= 0) continue;

        var color = face.color;
        var spec = 0;
        if (!face.flat) {
          var diff = Math.max(0, vdot(n, LIGHT));
          var shade = 0.52 + 0.52 * diff;
          var h = vnorm(vadd(LIGHT, vnorm(toCam)));
          spec = Math.pow(Math.max(0, vdot(n, h)), 26) * 0.6;
          color = [color[0] * shade + 255 * spec, color[1] * shade + 255 * spec, color[2] * shade + 255 * spec];
        }
        var fog = clamp((depth - this.fogNear) / this.fogRange, 0, this.fogMax);
        color = mixColor(color, [7, 12, 17], fog);
        items.push({
          type: "face",
          depth: depth + (face.depthBias || 0),
          pts: projected,
          color: color,
          alpha: face.alpha,
          flat: face.flat
        });
      }
    },

    _collectLines: function (items, lines, rot) {
      var rotFn = rot && rot.axis === "y" ? rotY : rotX;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var a = rot ? rotFn(line.a, rot.center, rot.angle) : line.a;
        var b = rot ? rotFn(line.b, rot.center, rot.angle) : line.b;
        var pa = this._project(a);
        var pb = this._project(b);
        if (!pa || !pb) continue;
        var depth = (pa[2] + pb[2]) / 2;
        items.push({
          type: "line",
          depth: depth,
          a: pa,
          b: pb,
          color: line.color,
          alpha: line.alpha,
          width: line.width * clamp(200 / depth, 0.55, 1.3)
        });
      }
    },

    _drawItem: function (ctx, item) {
      if (item.type === "face") {
        ctx.beginPath();
        ctx.moveTo(item.pts[0][0], item.pts[0][1]);
        for (var i = 1; i < item.pts.length; i++) ctx.lineTo(item.pts[i][0], item.pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = css(item.color, item.alpha);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(item.a[0], item.a[1]);
        ctx.lineTo(item.b[0], item.b[1]);
        ctx.strokeStyle = css(item.color, item.alpha);
        ctx.lineWidth = item.width;
        ctx.stroke();
      }
    },

    _drawFloor: function (ctx) {
      var y = -59.5;
      ctx.lineWidth = 1;
      for (var i = -5; i <= 5; i++) {
        var a = this._project([i * 12, y, -60]);
        var b = this._project([i * 12, y, 60]);
        var c = this._project([-60, y, i * 12]);
        var d = this._project([60, y, i * 12]);
        if (a && b) {
          ctx.strokeStyle = "rgba(55,110,135,0.12)";
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
        if (c && d) {
          ctx.strokeStyle = "rgba(55,110,135,0.12)";
          ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
        }
      }
    },

    _drawParticles: function (ctx) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (var i = 0; i < this.particles.length; i++) {
        var p = this.particles[i];
        var pos = p.type === "e"
          ? vlerp(p.p, p.target, p.t * p.t)
          : p.p;
        var pr = this._project(pos);
        if (!pr) continue;
        var size = p.type === "e" ? 1.6 : 1.9;
        var c = p.type === "e" ? [130, 235, 255] : p.c;
        ctx.fillStyle = css(c, 0.9);
        ctx.beginPath();
        ctx.arc(pr[0], pr[1], size * clamp(220 / pr[2], 0.6, 1.5), 0, TAU);
        ctx.fill();
      }
      for (var s = 0; s < this.sparks.length; s++) {
        var sp = this.sparks[s];
        var spr = this._project(sp.p);
        if (!spr) continue;
        ctx.strokeStyle = css(sp.c, clamp(sp.life, 0, 1) * 0.8);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(spr[0], spr[1], sp.r * 2.4, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawGlows: function (ctx) {
      var self = this;
      var m = this.machine;
      function glow(p, radius, color, alpha) {
        var pr = self._project(p);
        if (!pr || alpha <= 0.01) return;
        var r = radius * self.f / pr[2];
        var g = ctx.createRadialGradient(pr[0], pr[1], 1, pr[0], pr[1], r);
        g.addColorStop(0, css(color, alpha));
        g.addColorStop(0.35, css(color, alpha * 0.35));
        g.addColorStop(1, css(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pr[0], pr[1], r, 0, TAU);
        ctx.fill();
      }

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      /* filament */
      var fg = m.filamentGlow || 0;
      if (fg > 0.02) {
        glow([-28.5, 0, 0], 10, [255, 170, 80], 0.10 + fg * 0.5);
        var coilP = this._project([-28.5, 0, 0]);
        if (coilP) {
          ctx.strokeStyle = "rgba(255,190,110," + (0.15 + fg * 0.6) + ")";
          ctx.lineWidth = 1.5;
        }
      }

      /* focal spot and heat */
      if (this.focal) {
        var beam = !!m.beam;
        glow(this.focal, 5.5, [180, 245, 255], beam ? 0.85 : 0.15);
        var heat = this.tube ? this.tube.anodeHeatFraction() : 0;
        glow([this.focal[0], this.focal[1], 0], 13, [255, 120, 50], 0.12 + heat * 0.8);
        var trackPts = [];
        var tr = this.trackRadius || 7.75;
        var tx = this.trackX || 0.4;
        for (var k = 0; k < 32; k++) {
          var t = k / 32 * TAU;
          trackPts.push([tx - 0.05, tr * Math.cos(t), tr * Math.sin(t)]);
        }
        ctx.strokeStyle = "rgba(255,150,70," + (0.15 + heat * 0.8) + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var q = 0; q < trackPts.length; q++) {
          var pr = this._project(trackPts[q]);
          if (!pr) continue;
          if (q === 0) ctx.moveTo(pr[0], pr[1]); else ctx.lineTo(pr[0], pr[1]);
        }
        ctx.closePath();
        ctx.stroke();
      }

      /* detector glow when an image has been captured */
      if (this.captured) {
        glow([0, -52.3, 0], 18, [80, 220, 255], 0.14);
      }
      ctx.restore();
    },

    _drawMarkers: function (ctx) {
      var defs = [
        ["filament", 1], ["cup", 2], ["envelope", 3], ["anode", 4],
        ["window", 5], ["collimator", 6], ["patient", 7], ["detector", 8]
      ];
      for (var i = 0; i < defs.length; i++) {
        var p = this.anchors[defs[i][0]];
        if (!p) continue;
        var pr = this._project(p);
        if (!pr) continue;
        var active = this.hoverPart === defs[i][0];
        ctx.beginPath();
        ctx.arc(pr[0], pr[1], active ? 11 : 9, 0, TAU);
        ctx.fillStyle = active ? "rgba(70,217,255,0.25)" : "rgba(5,14,20,0.82)";
        ctx.fill();
        ctx.strokeStyle = active ? "#bdf7ff" : "rgba(70,217,255,0.55)";
        ctx.lineWidth = active ? 2 : 1;
        if (active) { ctx.shadowColor = "#46d9ff"; ctx.shadowBlur = 10; }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = active ? "#eafcff" : "#9fe6fb";
        ctx.font = "600 9.5px 'Cascadia Mono', Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(defs[i][1]), pr[0], pr[1] + 0.5);
      }
    },

    _drawInset: function (ctx, W, H) {
      var angle = this.angle || 12;
      var w = 190, h = 92;
      var x = 12, y = H - h - 12;
      ctx.save();
      ctx.fillStyle = "rgba(5,13,19,0.82)";
      ctx.strokeStyle = "rgba(70,217,255,0.22)";
      ctx.lineWidth = 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 8);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
      ctx.fillStyle = "#6f879a";
      ctx.font = "8px 'Cascadia Mono', Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("ANODE BEVEL", x + 9, y + 7);

      var ox = x + 28;
      var oy = y + h - 22;
      var len = 74;
      /* disc plane / electron beam */
      ctx.strokeStyle = "rgba(120,180,220,0.25)";
      ctx.beginPath();
      ctx.moveTo(ox - 8, oy - 30);
      ctx.lineTo(ox - 8, oy + 6);
      ctx.stroke();
      /* target surface */
      var t = Math.tan(angle * DEG) * 0.9;
      ctx.strokeStyle = "#d8e3ec";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ox, oy - 6);
      ctx.lineTo(ox + len, oy - 6 - len * t);
      ctx.stroke();
      /* electron arrow */
      ctx.strokeStyle = "#7fe6ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ox - 24, oy + 2);
      ctx.lineTo(ox + 18, oy - 22);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox + 18, oy - 22);
      ctx.lineTo(ox + 12, oy - 14);
      ctx.lineTo(ox + 22, oy - 15);
      ctx.closePath();
      ctx.fillStyle = "#7fe6ff";
      ctx.fill();
      /* exit beam */
      ctx.strokeStyle = "rgba(255,190,90,0.9)";
      ctx.beginPath();
      ctx.moveTo(ox + 34, oy - 20);
      ctx.lineTo(ox + 34, oy - 0);
      ctx.stroke();
      /* angle arc */
      ctx.strokeStyle = "rgba(255,178,87,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ox + 4, oy - 6, 28, -angle * DEG, 0);
      ctx.stroke();
      ctx.fillStyle = "#ffcf93";
      ctx.font = "9px 'Cascadia Mono', Consolas, monospace";
      ctx.fillText("α = " + angle + "°", x + 9, y + h - 16);
      ctx.fillStyle = "#8fb3c8";
      ctx.font = "8px 'Cascadia Mono', Consolas, monospace";
      ctx.textAlign = "right";
      ctx.fillText(this.tube ? this.tube.compute().effectiveFocal.toFixed(2) + " mm focus" : "", x + w - 9, y + h - 16);
      ctx.restore();
    }
  };

  /* Expose the geometry + math helpers so other scenes (CT, C-arm) can reuse
     the same software renderer primitives without duplicating them. */
  TubeScene.geom = {
    DEG: DEG, TAU: TAU, LIGHT: LIGHT,
    clamp: clamp, vsub: vsub, vadd: vadd, vmul: vmul, vdot: vdot, vcross: vcross,
    vlen: vlen, vnorm: vnorm, vlerp: vlerp, rotX: rotX, rotXn: rotXn, rotY: rotY, rotYn: rotYn,
    mixColor: mixColor, css: css, faceNormal: faceNormal,
    addFace: addFace, addQuad: addQuad, addCylinderX: addCylinderX, addDiscCapX: addDiscCapX,
    addCylinderY: addCylinderY, addEllipsoid: addEllipsoid, addBox: addBox,
    addLine: addLine, addLineLoop: addLineLoop, addEllipticalCapX: addEllipticalCapX,
    addLoftX: addLoftX, bodySectionAt: bodySectionAt, circlePts: circlePts
  };

  global.TubeScene = TubeScene;
})(window);
