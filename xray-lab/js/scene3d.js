/* ============================================================================
   scene3d.js — two 3D rooms built on the shared TubeScene software renderer
   ----------------------------------------------------------------------------
   CTScene     : a third-generation CT room — gantry ring with a rotating
                 source/detector pair, cantilevered patient couch and a supine
                 torso threaded through the bore.
   FluoroScene : a mobile C-arm room — the arc, its column and its base orbit the
                 isocentre while the image intensifier sits above the couch.

   Both inherit shading, the orbit camera and the painter's-algorithm renderer
   from js/tube3d.js and only override the scene hooks: _buildScene, _update,
   _collectScene, _drawBackground, _drawBackdrop and _drawSceneOverlay.

   Exposes: window.CTScene, window.FluoroScene
   ========================================================================== */
(function (global) {
  "use strict";

  var TubeScene = global.TubeScene;
  if (!TubeScene) return;
  var G = TubeScene.geom;

  var DEG = G.DEG, TAU = G.TAU;
  var clamp = G.clamp, css = G.css, vsub = G.vsub, vadd = G.vadd, vmul = G.vmul;
  var vcross = G.vcross, vnorm = G.vnorm, vlen = G.vlen, vlerp = G.vlerp;
  var addFace = G.addFace, addQuad = G.addQuad, addCylinderX = G.addCylinderX;
  var addCylinderY = G.addCylinderY, addEllipsoid = G.addEllipsoid, addBox = G.addBox;
  var addLine = G.addLine, addLineLoop = G.addLineLoop, addDiscCapX = G.addDiscCapX;
  var addLoftX = G.addLoftX, bodySectionAt = G.bodySectionAt, circlePts = G.circlePts;
  var rotX = G.rotX, rotY = G.rotY;

  /* ------------------------------------------------------------------ extra
     primitives the rooms need on top of the tube lab's set. */

  /* flat annulus (a disc with a hole) in a plane x = const */
  function addRingX(list, x, rIn, rOut, seg, color, alpha, dir, cull) {
    var n = [dir, 0, 0];
    for (var i = 0; i < seg; i++) {
      var t0 = i / seg * TAU;
      var t1 = (i + 1) / seg * TAU;
      addFace(list, [
        [x, rIn * Math.cos(t0), rIn * Math.sin(t0)],
        [x, rOut * Math.cos(t0), rOut * Math.sin(t0)],
        [x, rOut * Math.cos(t1), rOut * Math.sin(t1)],
        [x, rIn * Math.cos(t1), rIn * Math.sin(t1)]
      ], color, alpha, { normal: n, cull: cull !== false });
    }
  }

  /* swept tube through a polyline of centres.  `hint` is a vector that stays
     perpendicular to the path (X for the C-arm arc, whose path is in Y-Z). */
  function addTube(list, centers, radius, seg, color, alpha, opts) {
    opts = opts || {};
    var cull = opts.cull !== false;
    var hint = vnorm(opts.hint || [0, 0, 1]);
    var rings = [];
    for (var i = 0; i < centers.length; i++) {
      var a = centers[Math.max(0, i - 1)];
      var b = centers[Math.min(centers.length - 1, i + 1)];
      var t = vnorm(vsub(b, a));
      var u = vnorm(vcross(t, hint));
      var ring = [];
      for (var j = 0; j < seg; j++) {
        var ang = j / seg * TAU;
        ring.push(vadd(centers[i], vadd(vmul(u, radius * Math.cos(ang)), vmul(hint, radius * Math.sin(ang)))));
      }
      rings.push({ pts: ring, u: u });
    }
    for (var k = 0; k < rings.length - 1; k++) {
      var A = rings[k], B = rings[k + 1];
      for (var q = 0; q < seg; q++) {
        var mid = (q + 0.5) / seg * TAU;
        var n = vadd(vmul(A.u, Math.cos(mid)), vmul(hint, Math.sin(mid)));
        addQuad(list, A.pts[q], A.pts[(q + 1) % seg], B.pts[(q + 1) % seg], B.pts[q],
          color, alpha, { normal: n, cull: cull });
      }
    }
    if (opts.caps !== false) {
      var ends = [rings[0], rings[rings.length - 1]];
      var epts = [centers[0], centers[centers.length - 1]];
      for (var e = 0; e < 2; e++) {
        for (var q2 = 0; q2 < seg; q2++) {
          addFace(list, [epts[e], ends[e].pts[q2], ends[e].pts[(q2 + 1) % seg]],
            color, alpha, { cull: false });
        }
      }
    }
  }

  /* a supine torso lying along X, AP = Y.  Shared by both rooms so the patient
     reads the same whichever modality is on screen.  `backY` is the y of the
     patient's back — the couch top — so every cross-section rests on the table
     instead of floating above it or sinking through it. */
  function buildSupineBody(f, l, backY, k) {
    k = k || 1;
    var skin = [204, 158, 128], bone = [236, 227, 209];
    var lungC = [86, 146, 188], heartC = [182, 88, 88], liverC = [150, 104, 88];

    var torso = [
      { x: -46, ry: 4.4, rz: 5.4 }, { x: -41, ry: 5.2, rz: 7.2 },
      { x: -35, ry: 7.0, rz: 11.0 }, { x: -28, ry: 8.4, rz: 13.0 },
      { x: -20, ry: 9.2, rz: 12.8 }, { x: -12, ry: 9.6, rz: 12.2 },
      { x: -3, ry: 9.5, rz: 11.6 }, { x: 6, ry: 9.0, rz: 10.6 },
      { x: 15, ry: 8.7, rz: 9.8 }, { x: 24, ry: 8.4, rz: 9.6 },
      { x: 31, ry: 7.6, rz: 9.4 }
    ].map(function (s) {
      return { x: s.x * k, cy: backY + s.ry * k, cz: 0, ry: s.ry * k, rz: s.rz * k };
    });

    /* axis (centre) of the body at an already-scaled x */
    function axial(x) { return backY + bodySectionAt(torso, x).ry; }

    addLoftX(f, torso, 28, skin, 0.22, { cull: false, capColor: skin, capAlpha: 0.14 });

    /* neck and head, riding on the shoulder section */
    var neckY = axial(-43.5 * k);
    addCylinderX(f, -46 * k, -41 * k, neckY, 0, 4.2 * k, 18, skin, 0.22, { cull: false, caps: false });
    addEllipsoid(f, -49 * k, neckY + 1.0 * k, 0, 5.4 * k, 6.3 * k, 6.0 * k, 18, 12, skin, 0.2, { cull: false });

    /* lungs */
    var lungY = axial(-20 * k);
    addEllipsoid(f, -20 * k, lungY + 0.6 * k, -6.2 * k, 11 * k, 6.6 * k, 4.6 * k, 16, 12, lungC, 0.15, { cull: false });
    addEllipsoid(f, -20 * k, lungY + 0.6 * k, 6.2 * k, 11 * k, 6.6 * k, 4.6 * k, 16, 12, lungC, 0.15, { cull: false });
    /* cardiac silhouette */
    var heartY = axial(-6 * k);
    addEllipsoid(f, -6 * k, heartY + 0.2 * k, 2.4 * k, 6.8 * k, 6.0 * k, 4.2 * k, 16, 12, heartC, 0.16, { cull: false });
    /* liver under the right hemithorax */
    var liverY = axial(8 * k);
    addEllipsoid(f, 8 * k, liverY + 0.2 * k, 6.2 * k, 5.8 * k, 6.4 * k, 5.4 * k, 16, 12, liverC, 0.14, { cull: false });

    /* rib cage: rings that follow every cross-section of the loft */
    for (var i = 0; i < 11; i++) {
      var rx = (-33 + i * 4.0) * k;
      var sec = bodySectionAt(torso, rx);
      var rc = backY + sec.ry;
      var pts = [];
      for (var q = 0; q < 28; q++) {
        var t = q / 28 * TAU;
        pts.push([rx, rc + sec.ry * 0.94 * Math.cos(t), sec.rz * 0.94 * Math.sin(t)]);
      }
      addLineLoop(l, pts, bone, 1.6, 0.38);
    }

    /* vertebral bodies down the posterior wall */
    for (var v = 0; v < 15; v++) {
      var sx = (-36 + v * 4.4) * k;
      var ssec = bodySectionAt(torso, sx);
      var sy = backY + ssec.ry * 0.38;
      addCylinderX(f, sx - 1.2 * k, sx + 1.2 * k, sy, 0, 1.9 * k, 12, bone, 0.85, { cull: false });
      addLine(l, [sx, sy - 1.4 * k, 0], [sx, sy - 3.2 * k, 0], bone, 1.6, 0.4);
    }

    /* sternum, just under the anterior skin */
    addBox(f, -12 * k, axial(-12 * k) + 8.4 * k, 0, 12 * k, 1.4 * k, 3.4 * k, bone, 0.5, { cull: false });
  }

  /* =======================================================================
     Scene3D — shared behaviour for the two rooms
     ======================================================================= */

  function Scene3D(canvas) {
    /* These must exist before TubeScene.call, because its constructor calls
       this._buildScene() synchronously and the derived scene writes into them. */
    this.roomFaces = []; this.roomLines = [];
    this.tableFaces = []; this.tableLines = [];
    this.rotorFaces = []; this.rotorLines = [];
    this.beamFaces = []; this.beamLines = [];
    this.rotCenter = [0, 0, 0];
    this.rotAxis = "x";
    this.rotAngle = 0;
    this.floorY = -58;
    this.roomHalf = 100;
    this.labels = [];
    TubeScene.call(this, canvas);   /* dispatches to the derived _buildScene */
  }
  Scene3D.prototype = Object.create(TubeScene.prototype);
  Scene3D.prototype.constructor = Scene3D;

  Scene3D.prototype.setTube = function (tube) { this.tube = tube; };
  Scene3D.prototype.setMachine = function (m) { this.machine = m; };

  Scene3D.prototype.resetView = function () {
    var h = this.home;
    if (!h) return;
    this.yaw = h.yaw; this.pitch = h.pitch; this.dist = h.dist;
    this.target = h.target.slice();
  };

  Scene3D.prototype._rotFn = function () { return this.rotAxis === "y" ? rotY : rotX; };
  Scene3D.prototype._rotObj = function () {
    return { center: this.rotCenter, angle: this.rotAngle, axis: this.rotAxis };
  };
  Scene3D.prototype._rotP = function (p) {
    return this._rotFn()(p, this.rotCenter, this.rotAngle);
  };

  Scene3D.prototype._advanceRotor = function () {};

  Scene3D.prototype._update = function (dt) { this._advanceRotor(dt || 0); };

  Scene3D.prototype._collectScene = function (items) {
    var rot = this._rotObj();
    this._collectFaces(items, this.roomFaces, null);
    this._collectFaces(items, this.tableFaces, null);
    this._collectFaces(items, this.patientFaces, null);
    this._collectFaces(items, this.rotorFaces, rot);
    this._collectLines(items, this.roomLines, null);
    this._collectLines(items, this.tableLines, null);
    this._collectLines(items, this.patientLines, null);
    this._collectLines(items, this.rotorLines, rot);
    if (this._beamVisible()) {
      this._collectFaces(items, this.beamFaces, rot);
      this._collectLines(items, this.beamLines, rot);
    }
  };

  /* The CT fan stays on for the whole scan; the pulsed C-arm overrides this so
     its beam only shows while a pulse is actually being emitted. */
  Scene3D.prototype._beamVisible = function () {
    return !!(this.machine && this.machine.beam);
  };

  Scene3D.prototype._drawBackground = function (ctx, W, H) {
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b141d");
    bg.addColorStop(0.55, "#070d13");
    bg.addColorStop(1, "#04070a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    var g = ctx.createRadialGradient(W * 0.5, -H * 0.15, 10, W * 0.5, H * 0.12, H * 1.15);
    g.addColorStop(0, "rgba(58,120,160,0.16)");
    g.addColorStop(1, "rgba(58,120,160,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };

  Scene3D.prototype._drawFloorGrid = function (ctx, y, half) {
    var step = half / 5;
    ctx.lineWidth = 1;
    for (var i = -5; i <= 5; i++) {
      var a = this._project([i * step, y, -half]);
      var b = this._project([i * step, y, half]);
      var c = this._project([-half, y, i * step]);
      var d = this._project([half, y, i * step]);
      ctx.strokeStyle = "rgba(52,102,128,0.15)";
      if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
      if (c && d) { ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke(); }
    }
  };

  Scene3D.prototype._drawBackdrop = function (ctx) {
    this._drawFloorGrid(ctx, this.floorY, this.roomHalf);
  };

  Scene3D.prototype._drawSceneOverlay = function (ctx, W, H) {
    var self = this;
    function glow(p, radius, color, alpha) {
      if (!p || alpha <= 0.012) return;
      var pr = self._project(p);
      if (!pr) return;
      var r = radius * self.f / pr[2];
      if (r < 0.6) return;
      var g = ctx.createRadialGradient(pr[0], pr[1], 1, pr[0], pr[1], r);
      g.addColorStop(0, css(color, alpha));
      g.addColorStop(0.4, css(color, alpha * 0.30));
      g.addColorStop(1, css(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pr[0], pr[1], r, 0, TAU);
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    this._drawSceneGlows(ctx, glow);
    ctx.restore();

    this._drawSceneLabels(ctx, W, H);
    this._drawSceneHud(ctx, W, H);
  };

  Scene3D.prototype._drawSceneGlows = function () {};

  /* English call-outs pinned to the parts of the room.  Each scene fills
     `this.labels` with { p, text, color, offset, rot } entries; `rot` keeps a
     label glued to the rotating group (tube, detector) instead of the room. */
  Scene3D.prototype._drawSceneLabels = function (ctx, W, H) {
    var labels = this.labels;
    if (!labels || !labels.length) return;
    ctx.save();
    ctx.font = "600 10px 'Cascadia Mono', Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      var world = L.rot ? this._rotP(L.p) : L.p;
      var pr = this._project(world);
      if (!pr) continue;
      var ax = pr[0], ay = pr[1];
      var off = L.offset || [34, -18];
      var bx = ax + off[0], by = ay + off[1];
      var col = L.color || [120, 220, 255];
      var tw = ctx.measureText(L.text).width;

      /* leader from the part to its tag */
      ctx.strokeStyle = css(col, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      /* anchor dot on the part itself */
      ctx.beginPath();
      ctx.arc(ax, ay, 2.6, 0, TAU);
      ctx.fillStyle = css(col, 0.95);
      ctx.fill();
      ctx.strokeStyle = "rgba(4,10,15,0.9)";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      /* readable tag */
      var pad = 6, th = 15;
      var left = off[0] < 0 ? bx - tw - pad * 2 : bx;
      var top = by - th / 2;
      ctx.fillStyle = "rgba(5,13,19,0.82)";
      ctx.strokeStyle = css(col, 0.45);
      ctx.lineWidth = 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(left, top, tw + pad * 2, th, 5);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(left, top, tw + pad * 2, th);
        ctx.strokeRect(left, top, tw + pad * 2, th);
      }
      ctx.fillStyle = "#dbeef8";
      ctx.fillText(L.text, left + pad, by + 0.5);
    }
    ctx.restore();
  };

  Scene3D.prototype._drawSceneHud = function (ctx, W, H) {
    var data = this._hudData();
    var w = 232, h = 42, x = 12, y = H - h - 12;
    ctx.save();
    ctx.fillStyle = "rgba(5,13,19,0.8)";
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
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#7f9ab0";
    ctx.font = "8px 'Cascadia Mono', Consolas, monospace";
    ctx.fillText(data[0], x + 11, y + 8);
    ctx.fillStyle = "#d8ecf6";
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    ctx.fillText(data[1], x + 11, y + 22);
    ctx.restore();
  };

  Scene3D.prototype._hudData = function () {
    return ["SCENE", "3D room"];
  };

  /* =======================================================================
     CTScene — a third-generation CT scanner room
     ======================================================================= */

  function CTScene(canvas) {
    Scene3D.call(this, canvas);
    this.fogNear = 250;
    this.fogRange = 440;
    this.fogMax = 0.30;
    this.yaw = -66 * DEG;
    this.pitch = 20 * DEG;
    this.dist = 200;
    this.minDist = 120;
    this.maxDist = 430;
    this.target = [0, -6, 0];
    this.home = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
    this.floorY = -58;
    this.roomHalf = 110;
    this.rotAxis = "x";
    this.rotCenter = [0, 0, 0];
    this.rotTarget = 0;
    this.text = "";
  }
  CTScene.prototype = Object.create(Scene3D.prototype);
  CTScene.prototype.constructor = CTScene;

  CTScene.prototype._buildScene = function () {
    this.roomFaces = []; this.roomLines = [];
    this.tableFaces = []; this.tableLines = [];
    this.rotorFaces = []; this.rotorLines = [];
    this.beamFaces = []; this.beamLines = [];
    this.patientFaces = []; this.patientLines = [];
    this._buildRoom();
    this._buildGantry();
    this._buildRotor();
    this._buildCouch();
    buildSupineBody(this.patientFaces, this.patientLines, -18.0, 1);

    /* English call-outs for the CT room parts */
    this.labels = [
      { p: [0, 52, 0], text: "Gantry ring", color: [142, 166, 184], offset: [30, -18] },
      { p: [0, 30.5, 0], text: "X-ray tube", color: [255, 178, 87], offset: [42, -26], rot: true },
      { p: [0, -30.6, 0], text: "Detector array", color: [70, 217, 255], offset: [46, 24], rot: true },
      { p: [-20, -9, 0], text: "Torso phantom", color: [204, 158, 128], offset: [-40, -22] },
      { p: [58, -19, 0], text: "Patient couch", color: [126, 166, 192], offset: [40, 20] },
      { p: [6, -8, 62], text: "Operator console", color: [181, 140, 255], offset: [44, 16] }
    ];
  };

  CTScene.prototype._buildRoom = function () {
    var f = this.roomFaces, l = this.roomLines;
    /* floor slab */
    addFace(f, [[-110, -58, -110], [110, -58, -110], [110, -58, 110], [-110, -58, 110]],
      [11, 18, 24], 1, { flat: true, cull: false, normal: [0, 1, 0] });
    /* a distant back wall to give the room depth */
    addFace(f, [[-110, -58, -108], [110, -58, -108], [110, 42, -108], [-110, 42, -108]],
      [16, 23, 31], 0.85, { flat: true, cull: false, normal: [0, 0, 1] });
    for (var i = -4; i <= 4; i++) {
      addLine(l, [i * 24, -58, -107.5], [i * 24, 42, -107.5], [40, 62, 80], 1, 0.12);
    }
  };

  CTScene.prototype._buildGantry = function () {
    var f = this.roomFaces, l = this.roomLines;
    var shell = [56, 62, 72], shellDark = [38, 44, 54];
    var rim = [118, 132, 148], boreDark = [13, 17, 23];
    var x0 = -12, x1 = 12, rIn = 33, rOut = 52, seg = 56;
    var i, a;

    /* outer drum */
    addCylinderX(f, x0, x1, 0, 0, rOut, seg, shell, 1, { caps: false });
    addRingX(f, x0, rIn, rOut, seg, shellDark, 1, -1, true);
    addRingX(f, x1, rIn, rOut, seg, shellDark, 1, 1, true);
    /* bore wall (visible through the aperture) */
    addCylinderX(f, x0, x1, 0, 0, rIn, seg, boreDark, 1, { caps: false, cull: false });

    /* front bezel ring, a little wider than the drum */
    addCylinderX(f, -14.6, x0, 0, 0, rOut + 3.4, seg, [46, 52, 62], 1, { caps: false });
    addRingX(f, -14.6, rIn + 0.2, rOut + 3.4, seg, [50, 56, 66], 1, -1, true);
    addCylinderX(f, x1, 14.6, 0, 0, rOut + 3.4, seg, [46, 52, 62], 1, { caps: false });
    addRingX(f, 14.6, rIn + 0.2, rOut + 3.4, seg, [50, 56, 66], 1, 1, true);

    /* concentric trim rings + panel seams */
    addLineLoop(l, circlePts(-14.7, rOut + 3.5, seg), rim, 1.4, 0.34);
    addLineLoop(l, circlePts(-14.7, rOut - 6, seg), [86, 96, 110], 1, 0.24);
    addLineLoop(l, circlePts(-14.7, rIn + 3, seg), [78, 150, 180], 1.2, 0.30);
    addLineLoop(l, circlePts(x0, rIn, seg), [84, 158, 188], 1.3, 0.45);
    addLineLoop(l, circlePts(x1, rIn, seg), [84, 158, 188], 1.3, 0.45);
    addLineLoop(l, circlePts(x0, rOut + 0.3, seg), rim, 1.2, 0.28);
    addLineLoop(l, circlePts(x1, rOut + 0.3, seg), rim, 1.2, 0.28);
    for (i = 0; i < 12; i++) {
      a = i / 12 * TAU;
      addLine(l, [x0, (rOut - 8) * Math.cos(a), (rOut - 8) * Math.sin(a)],
        [x1, (rOut - 8) * Math.cos(a), (rOut - 8) * Math.sin(a)], [92, 102, 116], 1, 0.16);
    }

    /* plinth under the gantry */
    addBox(f, 0, -50, 0, 48, 16, 86, [28, 35, 43], 1);
    addBox(f, 0, -41.5, 0, 56, 3, 94, [36, 44, 54], 1);

    /* operator console in front of the gantry */
    addBox(f, 6, -20, 62, 30, 34, 12, [42, 49, 60], 1);
    addBox(f, 6, -8, 62, 22, 10, 2, [12, 22, 30], 1);
    addFace(f, [[-3, -6.4, 63.1], [15, -6.4, 63.1], [15, -10.2, 63.1], [-3, -10.2, 63.1]],
      [46, 176, 214], 0.85, { flat: true, cull: false, normal: [0, 0, 1] });
    addLineLoop(l, [[-3, -6.4, 63.2], [15, -6.4, 63.2], [15, -10.2, 63.2], [-3, -10.2, 63.2]],
      [130, 226, 250], 1.2, 0.6);
    for (i = 0; i < 3; i++) {
      var lx = -6 + i * 5;
      addFace(f, [[lx, -33, 63.1], [lx + 2.4, -33, 63.1], [lx + 2.4, -35.4, 63.1], [lx, -35.4, 63.1]],
        i === 0 ? [90, 226, 140] : i === 1 ? [255, 178, 87] : [70, 200, 245], 0.8,
        { flat: true, cull: false, normal: [0, 0, 1] });
    }

    /* cable tray running from the gantry to the console */
    addBox(f, 6, -30, 40, 9, 5, 40, [24, 30, 38], 0.9);
  };

  CTScene.prototype._buildRotor = function () {
    var f = this.rotorFaces, l = this.rotorLines;
    var bf = this.beamFaces, bl = this.beamLines;
    var R = 30;                     /* rotor drum radius */
    var seg = 40;
    var i;

    /* rotor drum: a thin translucent band the patient is threaded through */
    addCylinderX(f, -5.4, 5.4, 0, 0, R, seg, [80, 88, 100], 0.42, { caps: false, cull: false });
    addCylinderX(f, -5.4, 5.4, 0, 0, R - 1.6, seg, [40, 48, 58], 0.34, { caps: false, cull: false });
    addLineLoop(l, circlePts(-5.4, R + 0.2, seg), [126, 176, 206], 1.1, 0.34);
    addLineLoop(l, circlePts(5.4, R + 0.2, seg), [126, 176, 206], 1.1, 0.34);
    for (i = 0; i < 16; i++) {
      var a = i / 16 * TAU;
      addLine(l, [-5.4, R * Math.cos(a), R * Math.sin(a)], [5.4, R * Math.cos(a), R * Math.sin(a)],
        [96, 122, 144], 1, 0.16);
    }

    /* ---- X-ray tube assembly, mounted at the top of the rotor ---- */
    addBox(f, 0, 30.5, 0, 10, 13, 20, [60, 68, 80], 1);
    addBox(f, 0, 22.6, 0, 8, 5, 14, [48, 54, 66], 1);
    addBox(f, 0, 18.4, 0, 10, 3.4, 7, [40, 46, 58], 1);
    /* collimation blades */
    addBox(f, 0, 15.6, -6.4, 9, 3, 3.2, [34, 40, 50], 1);
    addBox(f, 0, 15.6, 6.4, 9, 3, 3.2, [34, 40, 50], 1);
    /* focal-spot aperture facing the bore */
    addFace(f, [[-2.4, 16.8, -2.4], [2.4, 16.8, -2.4], [2.4, 16.8, 2.4], [-2.4, 16.8, 2.4]],
      [255, 226, 170], 0.9, { flat: true, cull: false, normal: [0, -1, 0] });
    addLineLoop(l, [[-2.4, 16.9, -2.4], [2.4, 16.9, -2.4], [2.4, 16.9, 2.4], [-2.4, 16.9, 2.4]],
      [255, 236, 190], 1.4, 0.75);
    /* high-voltage cable loop */
    var cable = [];
    for (i = 0; i <= 14; i++) {
      var ca = Math.PI * i / 14;
      cable.push([6, 34 + 5 * Math.cos(ca), 22 * Math.sin(ca) - 10]);
    }
    for (i = 0; i < cable.length - 1; i++) addLine(l, cable[i], cable[i + 1], [58, 62, 72], 2, 0.7);

    /* ---- curved detector array, diametrically opposite ---- */
    var nd = 18, pA = 145 * DEG, pB = 215 * DEG, Rd = 30.6;
    var detColor = [30, 46, 60];
    for (i = 0; i < nd; i++) {
      var f0 = pA + (pB - pA) * i / nd;
      var f1 = pA + (pB - pA) * (i + 1) / nd;
      var mid = (f0 + f1) / 2;
      addQuad(f,
        [-4.4, Rd * Math.cos(f0), Rd * Math.sin(f0)],
        [-4.4, Rd * Math.cos(f1), Rd * Math.sin(f1)],
        [4.4, Rd * Math.cos(f1), Rd * Math.sin(f1)],
        [4.4, Rd * Math.cos(f0), Rd * Math.sin(f0)],
        detColor, 1, { normal: [0, -Math.cos(mid), -Math.sin(mid)], cull: true });
    }
    /* detector backing and housing */
    addCylinderX(f, -6, 6, 0, 0, Rd + 3.4, 26, [46, 52, 62], 1,
      { caps: false, cull: false, a0: (pA - 8 * DEG), a1: (pB + 8 * DEG) });
    addLineLoop(l, circlePts(-4.6, Rd - 0.3, 24, 0, 0), [90, 190, 220], 1.2, 0.4);
    /* scintillator highlights along the array */
    for (i = 0; i <= nd; i += 3) {
      var ff = pA + (pB - pA) * i / nd;
      addLine(l, [-4.4, Rd * Math.cos(ff), Rd * Math.sin(ff)], [4.4, Rd * Math.cos(ff), Rd * Math.sin(ff)],
        [120, 210, 236], 1, 0.3);
    }

    /* ---- X-ray fan the rotor projects across the bore ---- */
    var focal = [0, 15.5, 0];
    for (i = 0; i < nd; i++) {
      var q0 = pA + (pB - pA) * i / nd, q1 = pA + (pB - pA) * (i + 1) / nd;
      addFace(bf, [focal, [-4.4, Rd * Math.cos(q0), Rd * Math.sin(q0)], [-4.4, Rd * Math.cos(q1), Rd * Math.sin(q1)]],
        [72, 212, 255], 0.05, { flat: true, cull: false });
      addFace(bf, [focal, [4.4, Rd * Math.cos(q0), Rd * Math.sin(q0)], [4.4, Rd * Math.cos(q1), Rd * Math.sin(q1)]],
        [72, 212, 255], 0.05, { flat: true, cull: false });
    }
    for (i = 0; i <= nd; i += 2) {
      var qq = pA + (pB - pA) * i / nd;
      addLine(bl, focal, [0, Rd * Math.cos(qq), Rd * Math.sin(qq)], [96, 220, 255], 1, 0.14);
    }
    this.focal = focal;
    this.detMid = [0, Rd, 0];
  };

  CTScene.prototype._buildCouch = function () {
    var f = this.tableFaces, l = this.tableLines;
    var top = [34, 46, 56], frame = [24, 32, 42];
    /* couch top with the characteristic carbon-fibre groove */
    addBox(f, 0, -19.3, 0, 150, 2.6, 44, top, 0.97);
    addBox(f, 0, -17.7, 0, 150, 0.8, 3.0, [70, 156, 186], 0.32, { cull: false });
    addBox(f, 0, -19.4, -22.6, 150, 2.2, 2.4, frame, 0.97);
    addBox(f, 0, -19.4, 22.6, 150, 2.2, 2.4, frame, 0.97);
    addLine(l, [-75, -18.0, 0], [75, -18.0, 0], [80, 170, 200], 1, 0.3);
    /* pedestal and floor plate */
    addBox(f, 46, -38, 0, 18, 40, 28, frame, 0.97);
    addBox(f, 46, -56.4, 0, 32, 3.2, 42, [20, 28, 36], 0.97);
    addLineLoop(l, [[30, -18, -14], [62, -18, -14], [62, -18, 14], [30, -18, 14]], [70, 190, 220], 1, 0.28);
    /* head cradle */
    addBox(f, -54, -18.6, 0, 14, 3.4, 22, [72, 82, 94], 0.94);
  };

  CTScene.prototype._advanceRotor = function (dt) {
    var d = (this.rotTarget || 0) - this.rotAngle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    /* While the beam is on the rotor must sit exactly on the acquisition angle
       (a lerp would lag it by tens of degrees); when idle it merely settles. */
    var k = this.machine && this.machine.beam ? 1 : Math.min(1, dt * 6);
    this.rotAngle += d * k;
  };

  CTScene.prototype._drawSceneGlows = function (ctx, glow) {
    var beam = !!(this.machine && this.machine.beam);
    var fp = this._rotP(this.focal || [0, 15.5, 0]);
    var dp = this._rotP(this.detMid || [0, 30, 0]);
    glow(fp, 9, [255, 186, 96], beam ? 0.85 : 0.16);
    glow(this.focal || [0, 15.5, 0], 22, [255, 150, 60], beam ? 0.16 : 0.03);
    glow(dp, 13, [86, 210, 255], beam ? 0.34 : 0.08);
    glow(this._rotP([0, 0, 0]), 30, [70, 200, 250], beam ? 0.10 : 0.03);
    /* a soft wash inside the bore while the beam is on */
    var boreP = this._project([0, 0, 0]);
    if (beam && boreP) {
      var r = 46 * this.f / boreP[2];
      var g = ctx.createRadialGradient(boreP[0], boreP[1], 2, boreP[0], boreP[1], r);
      g.addColorStop(0, "rgba(90,214,255,0.13)");
      g.addColorStop(1, "rgba(90,214,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(boreP[0], boreP[1], r, 0, TAU);
      ctx.fill();
    }
  };

  CTScene.prototype._hudData = function () {
    var deg = ((this.rotAngle / TAU) * 360) % 360;
    return ["CT · ROTATE-ROTATE 3rd GEN",
      "gantry " + deg.toFixed(0) + "° · " + (this.machine && this.machine.text ? this.machine.text : "idle")];
  };

  /* =======================================================================
     FluoroScene — a mobile C-arm room
     ======================================================================= */

  function FluoroScene(canvas) {
    Scene3D.call(this, canvas);
    this.fogNear = 280;
    this.fogRange = 480;
    this.fogMax = 0.32;
    this.yaw = -48 * DEG;
    this.pitch = 15 * DEG;
    this.dist = 235;
    this.minDist = 130;
    this.maxDist = 470;
    this.target = [0, -8, 0];
    this.home = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
    this.floorY = -64;
    this.roomHalf = 120;
    this.rotAxis = "x";
    this.rotCenter = [0, 0, 9.15];
    this._rollT = 0;
    this.text = "";
  }
  FluoroScene.prototype = Object.create(Scene3D.prototype);
  FluoroScene.prototype.constructor = FluoroScene;

  FluoroScene.prototype._buildScene = function () {
    this.roomFaces = []; this.roomLines = [];
    this.tableFaces = []; this.tableLines = [];
    this.rotorFaces = []; this.rotorLines = [];
    this.beamFaces = []; this.beamLines = [];
    this.patientFaces = []; this.patientLines = [];
    this._buildRoom();
    this._buildCarm();
    this._buildBeam();
    this._buildCouch();
    buildSupineBody(this.patientFaces, this.patientLines, -16.0, 1);

    /* English call-outs for the C-arm room parts */
    this.labels = [
      { p: [0, 0, 53.15], text: "C-arm arc", color: [159, 176, 196], offset: [26, -30], rot: true },
      { p: this.focal, text: "X-ray tube head", color: [255, 178, 87], offset: [46, 20], rot: true },
      { p: this.detPt, text: "Image intensifier", color: [70, 217, 255], offset: [46, -26], rot: true },
      { p: [0, 0, 66], text: "Carriage & column", color: [126, 142, 166], offset: [40, 26] },
      { p: [0, -58, 74], text: "Mobile base", color: [120, 138, 158], offset: [16, 32] },
      { p: [52, -17, 0], text: "Patient couch", color: [126, 166, 192], offset: [34, 24] }
    ];
  };

  FluoroScene.prototype._buildRoom = function () {
    var f = this.roomFaces, l = this.roomLines;
    addFace(f, [[-120, -64, -120], [120, -64, -120], [120, -64, 120], [-120, -64, 120]],
      [11, 18, 24], 1, { flat: true, cull: false, normal: [0, 1, 0] });
    addFace(f, [[-120, -64, -118], [120, -64, -118], [120, 46, -118], [-120, 46, -118]],
      [16, 23, 31], 0.8, { flat: true, cull: false, normal: [0, 0, 1] });
    for (var i = -4; i <= 4; i++) {
      addLine(l, [i * 26, -64, -117.5], [i * 26, 46, -117.5], [40, 62, 80], 1, 0.1);
    }
  };

  /* The arc and its two heads sit in the rotating group.  The hoop is a circle
     centred on the isocentre, so angulating it about the patient's long axis is
     exactly the slide a real carriage allows — the arc runs through itself
     while the couch stays centred.  The carriage, column and base are bolted to
     the floor and never move. */
  FluoroScene.prototype._buildCarm = function () {
    var f = this.rotorFaces, l = this.rotorLines;
    var rf = this.roomFaces, rl = this.roomLines;
    var steel = [72, 78, 88], steelDark = [46, 52, 62], rim = [130, 144, 160];
    var R = 44, zc = 9.15;
    var A0 = -12 * DEG, A1 = 192 * DEG, N = 46;

    function arcPt(t) { return [0, -R * Math.cos(t), R * Math.sin(t) + zc]; }

    this.rotCenter = [0, 0, zc];

    var centers = [];
    for (var i = 0; i <= N; i++) centers.push(arcPt(A0 + (A1 - A0) * i / N));

    /* the C hoop itself */
    addTube(f, centers, 4.6, 11, steel, 1, { hint: [1, 0, 0], caps: true });
    addTube(f, centers.slice(2, centers.length - 2), 2.4, 9, steelDark, 0.85,
      { hint: [1, 0, 0], caps: false });
    /* rim highlights down the hoop */
    for (var k = 0; k <= N; k += 4) {
      var p = centers[k];
      addLine(l, [-4.6, p[1], p[2]], [4.6, p[1], p[2]], rim, 1.1, 0.28);
    }

    /* ---- carriage + support column + mobile base (fixed to the floor) ---- */
    var apex = arcPt(Math.PI / 2);      /* the bulge of the C, [0, 0, R + zc] */
    /* the cradle the hoop slides through; it grips the arc wherever it settles */
    addBox(rf, 0, 0, apex[2], 26, 36, 17, [58, 64, 76], 1);
    addBox(rf, 0, 0, apex[2] + 10.5, 20, 30, 5, [44, 50, 62], 1);
    addTube(rf, [[0, 11, 74], [0, 0, apex[2] + 6]], 5.4, 10, steel, 1, { hint: [1, 0, 0], caps: true });
    addCylinderY(rf, -60, 13, 0, 74, 6.5, 14, steel, 1, { cull: false });
    addCylinderY(rf, -60, -46, 0, 74, 8.5, 14, steelDark, 1, { cull: false });
    addBox(rf, 0, -61.4, 74, 56, 5.4, 46, [30, 38, 48], 1);
    /* castors */
    for (var c = 0; c < 4; c++) {
      var cx = (c < 2 ? -22 : 22), cz = 74 + (c % 2 ? 16 : -16);
      addCylinderY(rf, -64, -58.6, cx, cz, 3.4, 10, [22, 26, 32], 1, { cull: false });
    }
    addLineLoop(rl, [[-28, -58.8, 51], [28, -58.8, 51], [28, -58.8, 97], [-28, -58.8, 97]],
      [80, 130, 158], 1, 0.24);

    /* ---- X-ray tube head under the couch ---- */
    var sPt = arcPt(A0);
    addBox(f, 0, sPt[1] - 10, sPt[2], 20, 17, 24, [64, 70, 82], 1);
    addBox(f, 0, sPt[1] - 6, sPt[2], 12, 5, 16, [44, 50, 62], 1);
    addBox(f, 0, sPt[1] - 2.6, sPt[2] - 7.5, 10, 3, 4, [34, 40, 50], 1);
    addBox(f, 0, sPt[1] - 2.6, sPt[2] + 7.5, 10, 3, 4, [34, 40, 50], 1);
    addFace(f, [[-3.6, sPt[1] - 1.2, sPt[2] - 3.6], [3.6, sPt[1] - 1.2, sPt[2] - 3.6],
      [3.6, sPt[1] - 1.2, sPt[2] + 3.6], [-3.6, sPt[1] - 1.2, sPt[2] + 3.6]],
      [255, 226, 170], 0.85, { flat: true, cull: false, normal: [0, 1, 0] });
    /* cooling lines and a status lamp */
    addLine(l, [-10, sPt[1] - 18.6, sPt[2] - 12], [10, sPt[1] - 18.6, sPt[2] - 12],
      [120, 150, 170], 1, 0.3);
    this.focal = [0, sPt[1] - 0.5, sPt[2]];
    this.srcPt = sPt;

    /* ---- image intensifier above the couch ---- */
    var dPt = arcPt(A1);
    this.detPt = dPt;
    addBox(f, 0, dPt[1] + 12.5, dPt[2], 36, 22, 36, [58, 64, 76], 1);
    addBox(f, 0, dPt[1] + 6.4, dPt[2], 40, 4, 40, [46, 52, 64], 1);
    addFace(f, [[-19, dPt[1] + 4.2, dPt[2] - 19], [19, dPt[1] + 4.2, dPt[2] - 19],
      [19, dPt[1] + 4.2, dPt[2] + 19], [-19, dPt[1] + 4.2, dPt[2] + 19]],
      [34, 62, 82], 0.92, { flat: true, cull: false, normal: [0, -1, 0] });
    addLineLoop(l, [[-19, dPt[1] + 4.1, dPt[2] - 19], [19, dPt[1] + 4.1, dPt[2] - 19],
      [19, dPt[1] + 4.1, dPt[2] + 19], [-19, dPt[1] + 4.1, dPt[2] + 19]], [120, 214, 240], 1.5, 0.7);
    addLineLoop(l, [[-21, dPt[1] + 24, dPt[2] - 21], [21, dPt[1] + 24, dPt[2] - 21],
      [21, dPt[1] + 24, dPt[2] + 21], [-21, dPt[1] + 24, dPt[2] + 21]], [110, 124, 140], 1.1, 0.3);
    /* brand strip on the intensifier housing */
    addFace(f, [[-12, dPt[1] + 20, dPt[2] - 18.2], [12, dPt[1] + 20, dPt[2] - 18.2],
      [12, dPt[1] + 16, dPt[2] - 18.2], [-12, dPt[1] + 16, dPt[2] - 18.2]],
      [72, 196, 226], 0.55, { flat: true, cull: false, normal: [0, 0, -1] });
  };

  FluoroScene.prototype._buildBeam = function () {
    var bf = this.beamFaces, bl = this.beamLines;
    var s = this.focal;
    var hw = 19, y = this.detPt[1] + 3.8, z = this.detPt[2];
    var corner = [
      [-hw, y, z - hw], [hw, y, z - hw], [hw, y, z + hw], [-hw, y, z + hw]
    ];
    for (var i = 0; i < 4; i++) {
      addFace(bf, [s, corner[i], corner[(i + 1) % 4]], [80, 214, 255], 0.045,
        { flat: true, cull: false });
    }
    addFace(bf, corner, [80, 214, 255], 0.05, { flat: true, cull: false, normal: [0, -1, 0] });
    for (var j = 0; j < 4; j++) addLine(bl, s, corner[j], [104, 224, 255], 1, 0.18);
    addLineLoop(bl, corner, [120, 232, 255], 1.2, 0.35);
    /* collimation cross-hairs on the detector face */
    addLine(bl, [-hw + 2, y, z], [hw - 2, y, z], [120, 232, 255], 1, 0.22);
    addLine(bl, [0, y, z - hw + 2], [0, y, z + hw - 2], [120, 232, 255], 1, 0.22);
  };

  FluoroScene.prototype._buildCouch = function () {
    var f = this.tableFaces, l = this.tableLines;
    var top = [36, 48, 58], frame = [24, 32, 42];
    addBox(f, 0, -17.3, 0, 150, 2.6, 42, top, 0.5);
    addBox(f, 0, -18.8, -21.6, 150, 2.0, 2.4, frame, 0.9);
    addBox(f, 0, -18.8, 21.6, 150, 2.0, 2.4, frame, 0.9);
    addLine(l, [-75, -15.9, 0], [75, -15.9, 0], [80, 170, 200], 1, 0.24);
    /* cantilever post and floor plate */
    addBox(f, 52, -40, 0, 18, 46, 26, frame, 0.95);
    addBox(f, 52, -62.4, 0, 32, 3.2, 40, [20, 28, 36], 0.95);
    addLineLoop(l, [[34, -16, -13], [68, -16, -13], [68, -16, 13], [34, -16, 13]], [70, 190, 220], 1, 0.24);
  };

  /* The C-arm only shows its beam while a pulse is being emitted, so a live
     fluoroscopy run flickers at the set pulse rate instead of burning steady. */
  FluoroScene.prototype._beamVisible = function () {
    var m = this.machine;
    return !!(m && m.beam && (m.pulse || 0) > 0.03);
  };

  /* Motorised angulation: the arc sweeps to and fro around the isocentre at a
     constant rate while the foot switch is held, then parks back to AP. */
  FluoroScene.prototype._advanceRotor = function (dt) {
    var active = !!(this.machine && this.machine.active);
    var SWEEP = 22 * DEG;      /* peak RAO / LAO angulation */
    var RATE = 0.95;           /* rad/s of the sweep phase */

    if (active) this._rollT += dt * RATE;
    var target = active ? SWEEP * Math.sin(this._rollT) : 0;
    /* snapped to the commanded angle while imaging, eased back when released */
    this.rotAngle += (target - this.rotAngle) * Math.min(1, dt * (active ? 5 : 2.4));
  };

  FluoroScene.prototype._drawSceneGlows = function (ctx, glow) {
    var m = this.machine || {};
    var p = m.beam ? clamp(m.pulse || 0, 0, 1) : 0;
    var fp = this._rotP(this.focal || [0, -44, 0]);
    var dp = this._rotP(this.detPt || [0, 44, 0]);

    /* the tube head and the intensifier phosphor both flare on every pulse */
    glow(fp, 9, [255, 188, 98], 0.16 + 0.74 * p);
    glow(fp, 24, [255, 150, 60], 0.04 + 0.17 * p);
    glow(dp, 15, [86, 212, 255], 0.07 + 0.30 * p);
    glow(dp, 33, [70, 196, 240], 0.03 + 0.13 * p);

    /* a soft wash down the beam axis between the two heads */
    var a = this._project(fp), b = this._project(dp);
    if (p > 0.03 && a && b) {
      var g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      g.addColorStop(0, "rgba(120,226,255," + (0.05 + 0.18 * p).toFixed(3) + ")");
      g.addColorStop(1, "rgba(120,226,255,0.02)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 24 * this.f / ((a[2] + b[2]) / 2) * (0.22 + 0.12 * p);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  };

  FluoroScene.prototype._hudData = function () {
    var m = this.machine || {};
    var deg = this.rotAngle / DEG;
    var ang = (deg >= 0 ? "LAO " : "RAO ") + Math.abs(deg).toFixed(1) + "°";
    return ["C-ARM · MOBILE ARC",
      ang + " · " + (m.text || "standby")];
  };

  /* =======================================================================
     OPGScene — a panoramic (orthopantomogram) dental unit room
     ------------------------------------------------------------------
     A half-ring arm carries the X-ray tube on one side and the slit detector
     on the other; it orbits the patient's head about the vertical axis while
     the chin sits in a fixed positioner.  The whole scene is tagged with its
     component names, like the CT and C-arm rooms.
     ======================================================================= */

  function OPGScene(canvas) {
    Scene3D.call(this, canvas);
    this.fogNear = 250;
    this.fogRange = 470;
    this.fogMax = 0.30;
    this.yaw = -42 * DEG;
    this.pitch = 13 * DEG;
    this.dist = 255;
    this.minDist = 140;
    this.maxDist = 540;
    this.target = [0, -6, 0];
    this.home = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
    this.floorY = -80;
    this.roomHalf = 120;
    this.rotAxis = "y";
    this.rotCenter = [0, 0, 0];
    this.rotTarget = 0;
    this.text = "";
  }
  OPGScene.prototype = Object.create(Scene3D.prototype);
  OPGScene.prototype.constructor = OPGScene;

  OPGScene.prototype._buildScene = function () {
    this.roomFaces = []; this.roomLines = [];
    this.tableFaces = []; this.tableLines = [];
    this.rotorFaces = []; this.rotorLines = [];
    this.beamFaces = []; this.beamLines = [];
    this.patientFaces = []; this.patientLines = [];
    this._buildRoom();
    this._buildColumn();
    this._buildRotor();
    this._buildHead();
    this._buildBeam();

    /* English call-outs for the panoramic room parts */
    this.labels = [
      { p: [0, 0, -46], text: "Rotating arm", color: [159, 176, 196], offset: [22, -30], rot: true },
      { p: [37.5, 0, 0], text: "X-ray tube", color: [255, 178, 87], offset: [40, 22], rot: true },
      { p: [-45.9, 0, 0], text: "Detector sensor", color: [70, 217, 255], offset: [-40, 24], rot: true },
      { p: [0, 20, -72], text: "Column & lift", color: [126, 142, 166], offset: [24, 26] },
      { p: [0, -14, 14], text: "Head positioner", color: [120, 138, 158], offset: [30, 28] },
      { p: [0, 6, 0], text: "Patient head", color: [204, 158, 128], offset: [-42, -26] }
    ];
  };

  OPGScene.prototype._buildRoom = function () {
    var f = this.roomFaces, l = this.roomLines;
    addFace(f, [[-120, -80, -120], [120, -80, -120], [120, -80, 120], [-120, -80, 120]],
      [11, 18, 24], 1, { flat: true, cull: false, normal: [0, 1, 0] });
    addFace(f, [[-120, -80, -118], [120, -80, -118], [120, 62, -118], [-120, 62, -118]],
      [16, 23, 31], 0.8, { flat: true, cull: false, normal: [0, 0, 1] });
    for (var i = -4; i <= 4; i++) {
      addLine(l, [i * 26, -80, -117.5], [i * 26, 62, -117.5], [40, 62, 80], 1, 0.1);
    }
  };

  OPGScene.prototype._buildColumn = function () {
    var f = this.roomFaces, l = this.roomLines;
    var shell = [56, 62, 72], dark = [34, 40, 50];
    /* floor plate and the vertical column standing behind the patient */
    addBox(f, 0, -77, -72, 44, 6, 34, dark, 1);
    addBox(f, 0, -10, -72, 20, 134, 20, shell, 1);
    addLineLoop(l, [[-11, -79.6, -61], [11, -79.6, -61], [11, -79.6, -83], [-11, -79.6, -83]],
      [80, 130, 158], 1, 0.2);
    /* overhead support reaching out to the rotating hub */
    addBox(f, 0, 26, -42, 16, 12, 64, [48, 54, 66], 1);
    addBox(f, 0, 26, -78, 26, 18, 14, [44, 50, 62], 1);
    /* small operator panel on the column */
    addBox(f, 13, -22, -66, 5, 24, 15, [42, 49, 60], 1);
    addFace(f, [[15.6, -16, -61], [15.6, -16, -71], [15.6, -32, -71], [15.6, -32, -61]],
      [46, 176, 214], 0.85, { flat: true, cull: false, normal: [1, 0, 0] });
    addLineLoop(l, [[15.7, -16, -61], [15.7, -16, -71], [15.7, -32, -71], [15.7, -32, -61]],
      [130, 226, 250], 1.1, 0.5);
  };

  OPGScene.prototype._buildRotor = function () {
    var f = this.rotorFaces, l = this.rotorLines;
    var steel = [74, 80, 90], steelDark = [46, 52, 62], rim = [132, 146, 162];
    var R = 46, A0 = 0, A1 = -Math.PI, N = 44;

    this.rotCenter = [0, 0, 0];

    /* the arm hoop arcs behind the head so it never crosses the face */
    var centers = [];
    for (var i = 0; i <= N; i++) {
      var t = A0 + (A1 - A0) * i / N;
      centers.push([R * Math.cos(t), 0, R * Math.sin(t)]);
    }
    addTube(f, centers, 5.0, 11, steel, 1, { hint: [0, 1, 0], caps: true });
    addTube(f, centers.slice(2, centers.length - 2), 2.6, 9, steelDark, 0.8,
      { hint: [0, 1, 0], caps: false });
    for (var k = 0; k <= N; k += 4) {
      var p = centers[k];
      addLine(l, [p[0], -5, p[2]], [p[0], 5, p[2]], rim, 1.1, 0.24);
    }

    /* centre spindle rising to the overhead support */
    addBox(f, 0, 12, 0, 9, 26, 9, steel, 1);
    addBox(f, 0, 26, 0, 18, 10, 18, [58, 64, 76], 1);
    addCylinderY(f, 0, 4, 0, 0, 7.4, 16, steelDark, 1, { cull: false });

    /* ---- X-ray tube head at one end of the arm ---- */
    var sPt = [R, 0, 0];
    addBox(f, 54, 0, 0, 20, 24, 24, [64, 70, 82], 1);
    addBox(f, 42, 0, 0, 8, 15, 18, [44, 50, 62], 1);
    /* slit collimator facing the patient */
    addBox(f, 39, 0, -1.7, 3, 22, 2.2, [34, 40, 50], 1);
    addBox(f, 39, 0, 1.7, 3, 22, 2.2, [34, 40, 50], 1);
    addFace(f, [[37.4, -10, -1.7], [37.4, -10, 1.7], [37.4, 10, 1.7], [37.4, 10, -1.7]],
      [255, 226, 170], 0.9, { flat: true, cull: false, normal: [-1, 0, 0] });
    addLineLoop(l, [[37.3, -10, -1.7], [37.3, -10, 1.7], [37.3, 10, 1.7], [37.3, 10, -1.7]],
      [255, 236, 190], 1.4, 0.75);
    this.focal = [37.4, 0, 0];
    this.srcPt = sPt;

    /* ---- slit detector / sensor at the other end ---- */
    var dPt = [-R, 0, 0];
    addBox(f, -52, 0, 0, 12, 36, 26, [58, 64, 76], 1);
    addBox(f, -46.5, 0, 0, 3, 30, 22, [46, 52, 64], 1);
    addFace(f, [[-45.4, -17, -12], [-45.4, -17, 12], [-45.4, 17, 12], [-45.4, 17, -12]],
      [34, 62, 82], 0.92, { flat: true, cull: false, normal: [1, 0, 0] });
    addLineLoop(l, [[-45.3, -17, -12], [-45.3, -17, 12], [-45.3, 17, 12], [-45.3, 17, -12]],
      [120, 214, 240], 1.5, 0.7);
    this.detPt = [-45.4, 0, 0];
  };

  OPGScene.prototype._buildHead = function () {
    var f = this.patientFaces, l = this.patientLines;
    var rf = this.roomFaces, rl = this.roomLines;
    var skin = [206, 160, 130], bone = [236, 227, 209];

    /* standing patient: torso, shoulders, neck, then the head */
    addEllipsoid(f, 0, -50, 0, 15, 26, 11, 22, 16, skin, 0.14, { cull: false });
    addEllipsoid(f, 0, -24, 0, 19, 7.5, 11, 20, 12, skin, 0.16, { cull: false });
    addCylinderY(f, -20, -7, 0, 0, 5.0, 16, skin, 0.18, { cull: false });
    addEllipsoid(f, 0, 2, 0, 8.8, 9.8, 9.2, 22, 16, skin, 0.16, { cull: false });
    addEllipsoid(f, 0, -1, 3.4, 6.6, 6.4, 5.2, 18, 12, bone, 0.20, { cull: false });
    /* mandible (lower jaw) */
    addEllipsoid(f, 0, -5.4, 2.6, 6.6, 3.0, 6.6, 18, 12, bone, 0.26, { cull: false });
    /* dental arches, upper and lower */
    for (var row = 0; row < 2; row++) {
      var yy = row === 0 ? -1.4 : -3.4;
      var arch = [];
      for (var i = 0; i <= 30; i++) {
        var u = i / 30;
        var x = (u * 2 - 1) * 6.0;
        var z = 3.2 + 3.0 * (1 - (x * x) / 36);
        arch.push([x, yy, z]);
      }
      addLineLoop(l, arch, bone, 1.6, row === 0 ? 0.55 : 0.5);
    }
    addLine(l, [0, 9, 3], [0, 2, 6], bone, 1.4, 0.35);

    /* chin rest and bite block on a pedestal fixed to the floor */
    addBox(rf, 0, -70, 16, 24, 6, 24, [30, 38, 48], 1);
    addCylinderY(rf, -67, -20, 0, 16, 3.6, 14, [58, 64, 76], 1, { cull: false });
    addBox(rf, 0, -18, 14, 18, 5, 12, [48, 54, 66], 1);
    addBox(rf, 0, -8.5, 10, 11, 2.4, 7, [44, 50, 62], 1);
    addLineLoop(rl, [[-9, -20.2, 20], [9, -20.2, 20], [9, -20.2, 8], [-9, -20.2, 8]],
      [80, 130, 158], 1, 0.2);
  };

  OPGScene.prototype._buildBeam = function () {
    var bf = this.beamFaces, bl = this.beamLines;
    var s = this.focal;
    var x2 = this.detPt[0];
    var hh = 16, hz = 1.4;
    var corner = [
      [x2, -hh, -hz], [x2, hh, -hz], [x2, hh, hz], [x2, -hh, hz]
    ];
    for (var i = 0; i < 4; i++) {
      addFace(bf, [s, corner[i], corner[(i + 1) % 4]], [80, 214, 255], 0.05, { flat: true, cull: false });
    }
    for (var j = 0; j < 4; j++) addLine(bl, s, corner[j], [104, 224, 255], 1, 0.16);
    addLineLoop(bl, corner, [120, 232, 255], 1.2, 0.3);
  };

  /* The arm sweeps a full turn about the vertical axis while a scan runs and
     parks when idle.  Unlike the CT gantry it is not wrapped, so a slow sweep
     reads as one continuous revolution instead of jumping at ±180°. */
  OPGScene.prototype._advanceRotor = function (dt) {
    var active = !!(this.machine && this.machine.beam);
    var d = (this.rotTarget || 0) - this.rotAngle;
    if (!active && Math.abs(d) > Math.PI) { this.rotAngle = this.rotTarget || 0; return; }
    this.rotAngle += d * (active ? 1 : Math.min(1, dt * 3));
  };

  OPGScene.prototype._drawSceneGlows = function (ctx, glow) {
    var beam = !!(this.machine && this.machine.beam);
    var fp = this._rotP(this.focal || [37.4, 0, 0]);
    var dp = this._rotP(this.detPt || [-45.4, 0, 0]);
    glow(fp, 6, [255, 188, 98], beam ? 0.9 : 0.12);
    glow(fp, 17, [255, 150, 60], beam ? 0.20 : 0.02);
    glow(dp, 15, [86, 212, 255], beam ? 0.30 : 0.06);

    /* a soft wash down the narrow slit beam */
    var a = this._project(fp), b = this._project(dp);
    if (beam && a && b) {
      var g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      g.addColorStop(0, "rgba(120,226,255,0.10)");
      g.addColorStop(0.5, "rgba(160,238,255,0.20)");
      g.addColorStop(1, "rgba(120,226,255,0.10)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  };

  OPGScene.prototype._hudData = function () {
    var deg = (this.rotAngle / TAU * 360) % 360;
    if (deg < 0) deg += 360;
    return ["OPG · PANORAMIC UNIT",
      "arm " + deg.toFixed(0) + "° · " + (this.machine && this.machine.text ? this.machine.text : "standby")];
  };

  global.CTScene = CTScene;
  global.FluoroScene = FluoroScene;
  global.OPGScene = OPGScene;
})(window);
