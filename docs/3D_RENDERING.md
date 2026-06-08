# 3D Rendering — Coordinate Math, GLB Structure, and the Lighting Rig

This is the design doc that was missing during the 26.5.8 alpha line, when the
rotation/translation sign conventions were repeatedly "fixed" and re-broken
(alpha.3 / alpha.6 thrash, then a full revert at alpha.7). The knowledge it
captures used to live only in code comments scattered across
`Model3DViewerGL.tsx`. It has since been consolidated into a single tested
module — this doc explains *why* the math is the way it is so nobody "corrects"
a sign by reasoning alone and ships another regression.

## Source-of-truth map

| Concern | File | Notes |
| --- | --- | --- |
| KiCad ↔ three.js coordinate math | `src/three/coords.ts` | **Single source of truth.** Pure, branded-typed conversions. |
| Regression guard for that math | `src/three/coords.test.ts` | 35 tests pin the exact numeric output of every conversion. |
| The viewer that consumes the math | `src/blocks/Model3DViewerGL.tsx` | GLB load, chip/substrate classification, lighting/camera rig, `applyLiveDelta`, hover helpers. |

**Any axis/sign/scale change MUST go through `coords.ts` and MUST update
`coords.test.ts`.** The tests encode current outputs *as a regression guard*,
not as a spec to satisfy — if you change a sign, the right move is to
visual-verify first (see "How to change a sign safely" below), then update the
pinned values, never the reverse.

---

## KiCad-PCB → three.js-world axis mapping

The 3D positioner stores transforms on disk in **KiCad-PCB coordinates**, while
the live WebGL preview runs in **three.js world coordinates**. `kicad-cli pcb
export glb` bakes the saved `(model …)` transform into the exported geometry, so
the loaded mesh already includes the saved pose; the viewer applies only the
live delta `(live − saved)` on top. These tables are how that delta is remapped.
All values are quoted from `src/three/coords.ts`.

### Unit scales

| Quantity | Positioner emits | three.js wants | Constant | Value |
| --- | --- | --- | --- | --- |
| translation | millimetres | metres | `MM_TO_WORLD` | `1 / 1000` (1 mm tick = 0.001 world units) |
| rotation | degrees | radians | `DEG_TO_RAD` | `Math.PI / 180` |
| scale | dimensionless ratio (live / saved) | dimensionless | — | no conversion |

### Translation (`kicadTranslationToWorld`)

A +1 mm jog on a KiCad axis moves the chip by +0.001 m on the listed world axis.

| KiCad axis | World axis | Sign | Rationale |
| --- | --- | --- | --- |
| +X | +X | + | no remap; both are "to the right" |
| +Y | **−Z** | **negated** | KiCad's "south on the layout sheet" → world depth, negated to match how kicad-cli bakes the GLB (KiCad Y=+1 lands at world −Z) |
| +Z | +Y | + | KiCad's "out of board" lands on Y-up |

Concretely: `dxWorld = dxK/1000`, `dyWorld = dzK/1000`, `dzWorld = −dyK/1000`.

### Rotation (`kicadRotationToWorldEuler`, Euler order `'XYZ'`)

| KiCad axis | World axis | Sign | Note |
| --- | --- | --- | --- |
| rX | rX | + | |
| rY | **rZ** | **NOT negated** | *** see the asymmetry below *** |
| rZ | rY | + | |

Concretely: `drxWorld = drxK`, `dryWorld = drzK`, `drzWorld = dryK` (each ×
`DEG_TO_RAD`).

### Scale (`kicadScaleToWorld`)

Same KiCad → world axis swap as translation, but **without any sign** (a scale
factor has no sign to flip):

| KiCad axis | World axis |
| --- | --- |
| x | x |
| y | z |
| z | y |

So a "scale Z" slider stretches the chip along its tall axis even though
kicad-cli's GLB calls that world Y. A zero saved value falls back to a ratio of
`1` (`scaleRatioFrom`, avoids divide-by-zero / NaN).

### Hover-arrow direction (`kicadAxisToWorld`)

The translation hover arrow uses the unit-vector form of the same mapping (no
/1000): `+X → (s,0,0)`, `+Y → (0,0,−s)`, `+Z → (0,s,0)`, where `s = ±1` from the
sign. Directions match `kicadTranslationToWorld` so the ghost arrow points where
a click would actually move the part.

### Composition

`composeDeltaMatrix` builds the live-delta `Matrix4` from the world-space
translation, rotation (as a `Quaternion` from the Euler), and scale — exactly as
`applyLiveDelta` does. The delta is applied per chip node as
`baseMatrix.clone().multiply(delta)`, where `baseMatrix` is the node's matrix at
load time. This makes the math "original × delta" rather than an accumulating
drift, so returning a slider to its saved value returns the chip to the exact
baked-in pose.

---

## THE translation-vs-rotation-Y asymmetry (the dangerous part)

Both Y components map onto the **world Z axis** — translation Y → `position.z`,
rotation Y → `euler.z` — but **only the translation component is negated**:

```
translation Y:  dzWorld  = −dyKicad     (KiCad +Y → world −Z)
rotation    Y:  drzWorld =  dryKicad     (KiCad rY → world +rZ)
```

Mathematically, a pure axis-relabel (KiCad Y → world Z) would be expected to use
the **same** sign for both translation and rotation. It does not. This is
**suspicious-but-preserved on purpose**:

- It is the empirically-settled behavior that makes the on-disk KiCad-coordinate
  storage round-trip cleanly through `kicad-cli` (visual-verified on the
  `synthetic_pcb_named` fixture).
- It was arrived at after the alpha.3 / alpha.6 thrash. alpha.6 ("rotation X+Z
  save round-trip + Y hover-arc direction") was reverted because the "fixes"
  broke things; alpha.7 is the reverted, known-good state this doc documents.
- `coords.test.ts` pins **both** behaviors. Changing either sign breaks those
  tests by design.

**Do not "fix" this by reasoning.** If a sign genuinely looks wrong, it must be
changed by *visual verification*, not by mathematical argument — that is exactly
the regression class this consolidation exists to prevent.

### How to change a sign safely

1. Change it only in `coords.ts`.
2. Visual-verify on `synthetic_pcb_named`: a +1 mm / +1° jog must move/rotate the
   chip the correct way on screen **and** round-trip through `kicad-cli` (save →
   reload must land the chip in the same place).
3. Only after visual confirmation, update the pinned values in `coords.test.ts`.

Note: the dial *labels* in `Model3DJogDial` / `Model3DRotateDial` were flipped at
26.5.8 to match the user's screen-relative mental model (camera at
`(0.12, 0.10, 0.12)` projects KiCad +Y = world +Z toward screen-down). That is a
**label-only** change — the `applyLiveDelta` remap above did not change, so the
on-disk storage still round-trips. Do not confuse a label flip with an axis-math
flip.

---

## Expected GLB structure

The viewer assumes the hierarchy that `kicad-cli pcb export glb` actually emits:

```
loadedRoot (gltf.scene)
 └─ Scene wrapper (unnamed Group; loadedRoot.children[0])
     ├─ preview_PCB            ← the substrate (kept still)
     ├─ preview_PCB_1..N       ← silk / pads / soldermask layers (also kept still)
     └─ <chip Group>           ← contains the real chip sub-meshes (the movable part)
```

Key assumptions:

- **Substrate naming.** The canonical substrate mesh is named **`preview_PCB`**
  exactly; layer siblings are `preview_PCB_1..N`. Classification treats anything
  matching `/^preview_PCB(_|$)/i` as substrate-related and never translates it.
  `findSubstrateMesh` picks the substrate; the smoke probe asserts the chosen
  name is `preview_PCB`.
- **Chips are siblings, not children, of the substrate.** `applyLiveDelta`
  targets the chip Group(s), not `loadedRoot` — moving `loadedRoot` would drag
  the substrate, the SVG decal, and the axis indicators along with it ("controls
  move everything"). A single `.kicad_mod` may have multiple `(model …)` blocks,
  so the delta is applied to **all** identified chip nodes in lock-step.
- **Recenter.** After classification, the substrate top is shifted to world
  `Y=0` (CAD "board resting on a virtual table") via `loadedRoot.position.y -=
  substrateBboxLocal.max.y`. The recenter is deferred until *after* the
  classifier so the bbox-Y comparison stays in the same pre-recenter frame as
  the captured `baseMatrix` values.

### Chip classifier (and what happens when it fails)

The classifier (whole-scene, "Wave 4-C" algorithm) works by:

1. Skip anything named `/^preview_PCB(_|$)/i`, plus decal/axis helper meshes.
2. Keep only meshes whose bbox sits **above** the substrate top
   (`bbox.max.y > substrateTopY − 5e-4 m` tolerance) — anything below is
   bottom-side artwork.
3. Walk each survivor up to the direct child of the Scene wrapper — that ancestor
   is one rigid chip body (so an OCCT-exploded N-sub-mesh assembly moves as a
   unit).
4. Reject the substrate's parent Group, the wrapper, and `loadedRoot` (moving any
   of those would move the board / everything).
5. Deduplicate (many sub-meshes share one top-level ancestor).

**Fail-loud overlay.** If the classifier finds **zero** chip groups
(`classifierFoundNoChips`), the viewer deliberately does **not** fall back to
translating `loadedRoot` — translating nothing beats translating the wrong thing
(that was the Wave 3-B bug where PCB layers stretched). Instead it:

- logs `console.warn('[3D viewer GL] classifier found no chip groups — applyLiveDelta will be a no-op')`,
- sets `window.__model3dGLLastError`,
- and sets the `noChipModel` signal, which renders a visible bottom banner
  (`data-testid="3d-viewer-gl-no-chip"`):
  *"3D model loaded, but its movable part couldn't be identified — position
  editing is disabled for this model."*

Before this overlay, the model rendered fine, the dials silently moved nothing,
and the user got no feedback (the IPEX-style "renders but jogs are dead" case).
The banner is cleared at the start of every (re)load and re-raised only if *this*
load yields zero chips.

There is a separate **amber warnings banner** (top) driven by structured
`render_3d_glb_angled` warnings (`model_not_found` / `tessellation_failed`) when
kicad-cli could not embed a `(model …)` block — distinct from the no-chip case.

### Test hooks

The viewer exposes `window.__model3dGL*` globals for the visual-verify harness:
`__model3dGLScene`, `__model3dGLChipNodeCount`, `__model3dGLChipMeshNames`,
`__model3dGLSubstrateName`, `__model3dGLSubstrateBbox`, `__model3dGLClassifierDebug`,
`__model3dGLHoverHelperName`, `__model3dGLMouseButtons`, `__model3dGLLastWarnings`,
`__model3dGLLastError`. They cost nothing in production and let probes assert that
the *runtime* found chip nodes (not merely that the GLB contained them).

---

## Lighting / IBL / camera rig

glTF is a PBR format: it needs a filmic tone map and image-based lighting or
metals render black and dielectrics look flat/muddy. The rig below is the result
of several visual-parity passes (alpha.30 → alpha.34 → alpha.5 → alpha.6). The
magic numbers are tuned together — moving one usually means re-tuning its
neighbors.

### Renderer

| Setting | Value | Why |
| --- | --- | --- |
| `setPixelRatio` | `min(devicePixelRatio, 2)` | dpr can be 3 on 4K HiDPI; capping at 2 avoids tripling fragment cost at 320px height for no visible gain (standard three.js practice). |
| `outputColorSpace` | `SRGBColorSpace` | linear-in / sRGB-out — required for the PBR pipeline. |
| `toneMapping` | `ACESFilmicToneMapping` | filmic highlight rolloff; without it metals look black and dielectrics washed-out. |
| `toneMappingExposure` | **`0.75`** | the cheapest brightness knob. Walked 1.0 → 0.95 → 0.75 as the IBL irradiance + three direct lights stacked into "washed-out" (soldermask green came through cyan). 0.75 lets cast shadows actually read. |
| `shadowMap.enabled` | `true` | without contact shadows the chip body floats — the user can't tell where it sits relative to the board. |
| `shadowMap.type` | `PCFSoftShadowMap` | ~2–3 ms/frame on integrated GPUs at 2048², acceptable for a 30 fps preview. |

### IBL (environment)

A neutral studio HDRI is synthesised from three's bundled `RoomEnvironment`,
prefiltered through `PMREMGenerator` (`fromScene(roomEnv, 0.04)`), and assigned to
`scene.environment`. This is what makes glTF look like glTF — it supplies the
diffuse ambient and the reflections. `scene.background` stays `null` so the
zinc-tinted CSS wrapper shows through.

Per-material, `envMapIntensity` is damped to **`0.85`** (default is 1.0). The
intermediate `0.5` value was correct only while the substrate was 0.8-opacity
(double-darkening); once the board is opaque, 0.5 reads as dead matte plastic.
0.85 keeps highlights from blowing out while letting the IBL contribute.

### Lights (IBL does the bulk; directionals sharpen shape)

| Light | Color | Intensity | Position | Shadow | Why |
| --- | --- | --- | --- | --- | --- |
| `AmbientLight` | `0xffffff` | **`0.15`** | — | — | low fill; IBL provides the real ambient. Dropped 0.25 → 0.15 so the directional contrast reads. |
| key `DirectionalLight` | `0xffffff` | **`0.75`** | `(3, 10, 3)` | **casts** | pulled overhead (was `5,8,5`) for less side rake; 0.75 compensates for the shadow's local darkening so the lit side stays bright. |
| fill `DirectionalLight` | `0xffffff` | **`0.35`** | `(-5, 8, -5)` | no | "lit by sky" on the shadow side instead of pitch-black; keeps the key/fill ratio. |
| `HemisphereLight` | sky `0xa6c9b3` / ground `0x1a1a1a` | **`0.20`** | — | — | slight green-cyan sky (matches soldermask) + dark ground for cool/warm face separation, below the key so it doesn't wash shadows out. |

Key-light shadow params (scene is in **metres**):
`shadow.mapSize = 2048×2048`, `shadow.bias = -1e-5` (≈10 µm — `-5e-4` ≈ half a
chip-height pushed shadows off their casters), `shadow.normalBias = 1e-4` (slope
acne on the substrate top), `shadow.radius = 4` (believable soft contact shadow
without blurring the chip outline). The shadow-camera frustum is sized for a
~4 cm board (`±0.05 m` left/right/top/bottom) with the light ~10.8 m from origin,
so `near = 0.1`, `far = 20`.

### Camera

kicad-cli's GLB is in **metres, Y-up**. A typical board is ~4 cm; an IC chip is
~1.6 mm × 0.45 mm.

- `PerspectiveCamera(45, aspect, 1e-5, 100)` — FOV 45°, very tight near plane
  (1e-5 m = 10 µm) so sub-mm component thicknesses never clip at any zoom; far
  100 m. Initial position `(0.12, 0.10, 0.12)` (≈12 cm) frames a 4 cm board
  comfortably. The previous `(40,40,40)` default was 40 metres out (≈1700:1
  frame ratio — catastrophically zoomed out).
- `frameCameraTo` refines near/far/position on each load. It frames to the
  **smallest** non-trivial mesh (= the component), not the whole-board bbox —
  framing to the board projects a 1.6 mm chip to ~3 px on a 320 px canvas
  ("no chip visible"). Distance is `6× component max-dim` (or `3× board` as
  fallback), floored at `0.02 m`. Axis indicators and the SVG decal are excluded
  so a 3 mm arrow cone can't yank the camera onto itself.

### Controls

`OrbitControls` with `enableDamping` (`dampingFactor 0.08`). Mouse mapping is
remapped to the CAD convention (KiCad / Blender / Fusion): `LEFT = ROTATE`,
`MIDDLE = PAN`, `RIGHT = PAN`, wheel = zoom. The canvas captures `wheel` with
`passive: false` + `preventDefault` and is made keyboard-focusable (`tabIndex`,
focus on mousedown) so "click into the viewport, then wheel zooms" works without
scrolling the page.

### Material fix-ups (per load, before attach)

kicad-cli's GLB uses two PBR encodings that are spec-correct but render wrong
here:

1. **Substrate / soldermask** comes through as `alphaMode: BLEND`, opacity
   ≈0.83–0.90 (a kicad-cli artifact, not real transparency). The substrate is
   force-coloured to kicad-cli green `RGB(0.05, 0.20, 0.10)`, `roughness 0.55`,
   `metalness 0`, `opacity 0.9`, `depthWrite true`.
2. **OCCT STEP bodies (IC packages)** come through as `metalness 1.0`,
   `baseColor ≈ (0.5,0.5,0.5)`, no `metalnessMap` — OCCT's "unknown shading"
   default, which renders black without IBL and chrome with it. Detected
   specifically (grey within 0.05, r in 0.4–0.6) and demoted to `metalness 0.1`,
   `roughness ≥ 0.6`. Legitimately-metallic parts (USB shells, gold fingers) are
   left alone. Chip bodies are set `opacity 0.9`, `depthWrite true`.

Substrate `receiveShadow`; chips both `castShadow` and `receiveShadow`
(multi-body assemblies self-shadow correctly).
