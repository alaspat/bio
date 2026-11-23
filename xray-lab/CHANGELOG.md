# Changelog — X-Ray Tube Lab (updated build)

All changes applied on top of the original uploaded project. Files keep the
same structure: `index.html`, `ct-fluoro.html`, `css/`, `js/`.

## Fixed

1. **`coverageCm` unbounded** (`js/insert-tube.js`)
   `2·SID·tan(angle)` could reach 73 cm at 20°. Now clamped to the 43 cm
   detector plate.
2. **Dead `rims` code path** (`js/tube3d.js`)
   `addCylinderX` pushed rim outlines into a throwaway array
   (`list.__lines || []`) — removed; rim outlines stay the caller's job via
   `addLineLoop`, as all existing call sites already do.
3. **Dead `effectiveKVp` getter** (`js/insert-tube.js`) — removed (its logic
   already lives in `_shapeSpectrum`).
4. **Cache staleness after cooling** (`js/insert-tube.js`)
   `cool()` now invalidates `_cache.metrics`, so `anodeHeatPct` in cached
   metrics is always fresh.
5. **Photon-count model** (`js/insert-tube.js`)
   `photons = electrons × efficiency` mixed an energy fraction with a
   population fraction. Now `photons = electrons · η · kVp / E_mean`
   (energy balance: radiated energy ÷ mean photon energy).

## Improved

6. **Dynamic spectrum axis** (`js/app.js`)
   Chart x-axis now spans `max(current kVp, pinned kVp)` rounded up to a
   multiple of 30 — mammography spectra (28 kVp) no longer share a chart with
   120 keV of empty space, while pinned A/B comparisons stay aligned. Hovering
   uses the same dynamic scale (`chartGeom.xMax`).
7. **Hann apodisation toggle for CT** (`js/ct-fluoro.js`, `ct-fluoro.html`,
   `css/ct-fluoro.css`)
   New "Reconstruction filter" section: Ram-Lak vs Hann windowed ramp. The
   Hann kernel is built by numeric inverse transform of `|f|·W(f)` so its
   amplitude matches the analytic Ram-Lak kernel; toggling refilters the
   existing sinogram instantly (new `refilterRecon()`), no rescan needed.
8. **`prefers-reduced-motion` support** (`js/app.js`)
   Anode autorotation is suppressed and the scene stays informative when the
   OS requests reduced motion (the stylesheet media query was already there;
   the render loop now honours it too).

## Added

9. **`tests/insert-tube.test.js`** — 22 node assertions over the DOM-free
   physics engine: kerma calibration (0.45 mGy reference), HVL monotonicity,
   characteristic lines gated by the K-edge, spectrum endpoint ≤ kVp,
   coverage clamp, photon-count identity, cache freshness, generator blends,
   Mo mammography ranges, and the sampled-photon distribution. Run:
   `node tests/insert-tube.test.js`

## Deferred (recommended next steps)

- K-edge filtration materials (Mo/Rh filters for mammography) — HVL 0.63 mm Al
  vs a real-world 0.30–0.35 with a 30 µm Mo filter.
- Spectrum-weighted subject contrast (reusing the phantom's 16 energy groups).
- Web-Worker offload for the FBP reconstruction.
- Duplicated helpers (`clamp`, `fmt`, `gauss`) consolidated into `js/core.js`.
- URL-hash state sharing, AEC mode, MTF curve, ROI readouts, Arabic i18n.
