# cad.thatsit.app — design

## Intent

Michael designs parts on his iPad with an Apple Pencil and prints them. The first real project is a
housing for an LED-matrix alarm clock: several bodies, cuts into faces, exact dimensions. The output is
STEP, because the model has to survive going back into a real CAD tool. What is missing today is a CAD
app that is calm on a tablet, fast enough to draw on, and honest about millimetres.

Success looks like: draw a closed rectangle with the pencil, tap Extrude, type a depth, export STEP, and
have it open as a solid in another CAD tool.

## Goals

- Pencil sketching on the iPad with no perceptible lag; two fingers navigate the model at the same time.
- Sketch → solid: extrude and cut, including sketches drawn onto an existing face.
- Fillet and chamfer on selected edges, with a typed radius or distance.
- Measure the real solid: distance, edge length, face area, radius, angle, volume.
- Multi-body documents: bodies stay separate solids, and one export carries them all.
- STEP out of the geometry kernel, so the B-rep is a genuine one.
- Projects open, save and persist on the device.
- Kit look and feel throughout: tokens, kit components, light and dark.

## Non-goals (v1)

- Assemblies, joints, mates, constraints and a solver.
- Parametric spreadsheets, configurations, templates.
- STL/OBJ export, and importing STEP.
- Drawing/drafting sheets, drawings of parts.
- Mirror, linear and circular patterns, shells, thread features, text.
- atproto sync and sharing.
- Curved surfaces, lofts and sweeps.

## Anti-goals

- A desktop CAD port with small buttons.
- Floating rounded rectangles stacked over the viewport, Shapr3D-style.
- A mesh-only model that only looks like it has solid geometry.
- Silent failures: a failed kernel operation shown as a successful one.
- A model that cannot be reopened and edited later.

## Constraints

- Apps live at `thats-it-dev/<name>` from the app template: Vite + TypeScript + Lit, kit from
  `https://kit.thatsit.app`, and a CSP of `default-src 'self'; script-src 'self' https://kit.thatsit.app`
  (`public/_headers`).
- `cascade-core` 2.0.6 is the kernel: OpenCascade 8.0 compiled to WASM, MIT, `cascadestudio.wasm` 21.2 MB
  (6.4 MB gzipped). Cloudflare Pages caps an asset at 25 MiB, so it fits, barely.
- Its only modelling entry point is `eval(code)` inside a worker, so `script-src` needs `'unsafe-eval'`
  and `'wasm-unsafe-eval'`. No SharedArrayBuffer, so no COOP/COEP.
- Files in `public/` are not in the service worker precache list, which keeps first paint off the 21 MB
  download.
- App sources stay under 400 lines per file; `npm run verify` is the gate; e2e must not depend on a
  21 MB download per test.

## Approaches considered

1. **JS prismatic kernel, hand-written STEP writer.** ~300 KB total, no CSP change, sub-second load.
   Rejected: bodies fuse into one solid, so no multi-body; STEP is limited to planar and cylindrical
   faces; fillets and chamfers are only approximated on profile corners. Michael wants multi-body parts
   and STEP.
2. **`cascade-core` (OCCT WASM) + three.js viewer. Chosen.** Real B-rep, real booleans, real fillets, and
   STEP comes out of OCCT's own writer. Costs: a 21 MB asset, `'unsafe-eval'` + `'wasm-unsafe-eval'` in
   the CSP, and a lazy-loading kernel with a worker round trip.
3. **Server-side kernel on the spark, tailnet only.** Small client, heavy maths off the iPad. Rejected:
   the app must work on an iPad anywhere, and a round trip per rebuild is worse than a local worker.

## Decided by Michael

- Rebuild unit is the whole document: one script builds every body, and a changed step re-runs that script
  as it stands. The kernel's own operation cache is switched off on every call
  (`guiState: {"Cache?": false}`), so nothing depends on an undocumented internal cache and a cached shape
  can never outlive the step that produced it.
- Topology keeps its identity through the feature that produced it (body 1 → step 3 → face 2 of that
  operation), not through geometry matching, and a feature whose parent was deleted goes broken rather
  than silently re-resolving somewhere else.
- v1.0 stays one body; multi-body is v1.1. The clock housing is the acceptance test for v1.1, not for v1.0.
- Millimetres; parts meant to be printed; STEP as the export format.
- Multi-body: separate bodies inside one document, each independently positioned.
- Modelling starts from a solid box, and cavities are cut from it; parts are always modelled from scratch
  by sketching on planes and on existing faces — never from reference components or imported models.
- Document is a feature history rebuilt in order; a failed step shows the last good solid and flags the
  step.
- Editing a sketch means redrawing it, and everything downstream rebuilds.
- v1 operations: sketch on a plane or face, extrude, cut, fillet, chamfer, and measure the solid through
  the kernel.
- iPad-first, and the parts of the desktop layout that a wide screen needs (history, tool selection) ship
  with v1. Mouse and keyboard have parity with the pen.
- UI: kit look and feel, no floating 2D panels over the canvas except the value field while a dimension is
  being set. Left panel = tools, and its contents change with the active tool or selection. Right panel =
  history, sketches and bodies. Both collapse. Icon-driven.
- Gesture map: one finger orbits, two fingers pan and pinch-zoom, the pen draws and selects. Free orbit
  with snap-to-axis views and fit-to-part.
- Projects are stored on the device.

## My calls (correct me)

- **Units are integers where they are stored, millimetres where they are computed.** Document and sketch
  values are stored as integer micrometres. The script builder is the one place that converts to
  millimetre floats, because `saveShapeSTEP` takes no unit parameter and OCCT writes whatever numbers the
  script passed. So the conversion boundary is "leaving the app for the kernel", not "leaving the kernel
  for STEP", and anything the kernel hands back (mesh positions, measurements) is already millimetres.
- **Kernel latency gets measured before the rebuild policy is final.** A whole-document rebuild on an iPad
  is the design's one unmeasured number. If the first on-device prototype rebuilds a 20-step part in over
  ~2 s, v1.0 adds an optimistic preview: the mesh of the changed step's own history entry, asked for with
  `engine.meshHistoryStep(i)`, drawn while the full rebuild catches up. A prototype settles this, not a
  guess, so Stage 0 exists to produce the number.
- **The 21 MB binary is committed to the repo** at `public/kernel/`, keeping CSP at `'self'`. If a public
  npm CDN is acceptable later, this is a small change.
- **v1 shows typed dimensions, not draggable dimension glyphs.** Strokes and the existing geometry snap to
  round numbers, and the numbers that define them appear as fields. Draggable dimension annotations are
  their own later feature.
- **Rebuild policy: whole document per rebuild, kernel cache off, app-side step preview on top.**
  `cascade-core` gates its `argCache` on `guiState["Cache?"]` and it defaults to off; the app leaves it off
  so a broken step can never be served from a stale handle. "Prefix cache" is therefore not a kernel
  thing — what the app caches is the mesh of each step, fetched with `engine.meshHistoryStep(i)` from the
  worker's own per-operation timeline, which is also how the optimistic preview is drawn.
- **Body placement is typed numbers plus snap**, no freehand placement UI.
- **Two viewports are required:** the pen draws into the model, so it cannot be one canvas shared with the
  UI. The model canvas is WebGL (three.js); the sketch layer over it is a plain 2D canvas — strokes,
  snapping and dimension fields are screen-space drawing, not scene geometry.
- **e2e stubs the kernel worker** with a fake that returns a fixed mesh, and one longer-timeout test
  exercises the real kernel.
- **v1 saves on a debounce** and on background/visibility change; manual "Save As" and duplicate are
  v2.

## Architecture

- `src/model/` — the document: bodies, sketches, steps, ids. Pure TypeScript, unit tested.
- `src/sketch/` — pen input to entities (line, arc, circle), closure, snapping, projected 2D geometry.
  Pure TypeScript, unit tested.
- `src/kernel/` — the worker client: script builder, mesh decode, pick requests, STEP export, failure
  report.
- `src/view/` — three.js scene, dual canvas, orbit/pan/zoom, stylus handling, face and edge selection,
  overlays, measurement labels.
- `src/app-main.ts` composes the kit shell, the two panels and the viewer. Panels are files of their own.
- Rebuild: the document is serialised into one deterministic `cascade-core` script per rebuild — all
  bodies in one script, since `engine.evaluate()` combines and clears the worker's shape list at the end
  of every call. The worker returns triangle meshes for faces and edges. Topology references are carried
  by the app as (body, step, role) and resolved to an index in that script's own output order; there is no
  stable id from the kernel to rely on. The mechanism is the returned mesh itself: every face object carries
  `face_index` and every edge polyline carries `edge_index`, both numbered in the worker's traversal order
  of that build.
- Sketch geometry reaches the kernel as points, not as a `Sketch`. `Sketch(start, plane)` accepts only the
  three planes `XY`/`XZ`/`YZ`, with no origin and no offset, so it cannot describe a sketch drawn on a
  face. The script builder owns the sketch frame — an origin plus two in-plane unit axes, taken from the
  plane or from the face it was drawn on — and emits 3D points in the kernel's frame: `Polygon(points, true)`
  then `MakeFace(wire)`, which keeps the wire. `Sketch` is used only for a sketch on the model XY plane.
- Failure: a kernel error does not arrive as a rejected promise. `console.error` inside the worker is
  patched to `throw` asynchronously, which surfaces as an unhandled rejection on the worker and can leave
  that worker unusable; and `evaluate()` still fires its mesh request after a script throws, so a broken
  step can come back as an empty or partial mesh that reads as a success. Three consequences. (1) The
  script builder threads each operation's return value into the next one instead of relying on the worker's
  shape list, so a failed step yields a `null` rather than a wrong solid. (2) The app treats `worker.onerror`
  as a build failure, keeps the last good mesh on screen, and flags the step. (3) A worker that errors
  outside a build, or that stops answering within the request timeout, is terminated and reloaded; a rebuild
  is the recovery, so nothing has to survive in kernel state.
- Measurement: v1.3 computes what the returned meshes can give exactly (edge polylines, arc centres) and
  asks the kernel for the rest. `engine.evaluate()` returns only `{meshData, sceneOptions}`, so a number has
  no return channel: the rebuild script ends with probe calls (`Volume`, `SurfaceArea`, `EdgeLength`, and
  the face and edge property helpers) that report through the worker's `log` event, correlated by a build id
  printed on the same channel. Whatever a measurement is derived from is stated in the UI, so a tessellated
  radius never reads as an exact one.
- Persistence: IndexedDB stores the document JSON plus a thumbnail.
- Loading: the kernel starts on demand, with a progress affordance; sketching, orbiting and the model tree
  all work before it arrives.

## Stages

- **Stage 0 (a spike, not a ship):** the 21 MB kernel loaded on an iPad over the app's own CSP, and the design's one unmeasured number: wall-clock for a whole-document rebuild of a 20-step part, plus `meshHistoryStep` on its own. Decides whether v1.0 needs the optimistic preview. Disposable code, results written back into this spec.
- **v1.0 (the first ship):** one body; sketch on the XY plane and on a face; extrude; cut; projects;
  pencil drawing with coalesced ink and the gesture map; export a single-body STEP; left and right panels
  docked, tools and history; solid shading plus edge lines.
- **v1.1:** multi-body documents, body placement, and a STEP export holding every body.
- **v1.2:** fillet and chamfer on selected edges, with a typed radius.
- **v1.3:** measurement through the kernel — distance, edge length, face area, radius, angle, volume.
- **v1.4:** push-pull of faces and edges, writing a history step.
- **v2:** patterns, mirror, shell, holes; drag dimensions; STL; STEP import; sync.
