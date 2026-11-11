# Stage 0: the kernel latency number

The design's one unmeasured number (`docs/spec.md`, "My calls"): how long a whole-document rebuild of a 20-step
part takes on the real kernel, and what `meshHistoryStep` costs on its own. That decides whether v1.0 needs the
optimistic preview. Stage 0 is a spike, not a ship: the harness is committed so the numbers can be re-measured
on another device, and nothing in `src/` imports it.

## What runs

`spike/stage0/index.html` + `spike/stage0/bench.ts`, through the app's own `KernelClient` — same worker, same
generated script, same `GUIState: {"Cache?": false}`. `e2e/kernel.spec.ts` drives that page and asserts the
geometry is real. Two parts, deliberately:

- **the box** — one extrude of a 40 × 30 mm sketch at 12 mm depth. This is the part whose volume is asserted:
  14400 mm³ within 0.1%. The kernel's `Volume` is analytic, so it read **14400 exactly**.
- **the bench** — that same box plus 19 cut steps, each a 2 × 6 mm slot cut clean through the 12 mm height, on a
  5 × 4 grid inside the base. 20 steps, 80 kernel operations, and it reads 11664 mm³ (14400 − 19 × 144). The cuts
  go through the material rather than sitting inside it on purpose: an interior cut that consumes the body is the
  case where the kernel's `Difference` logs "destroyed the main body", and a build that logs is a build
  `KernelClient` reports as failed. **The bench is for time; the box is for truth.** Never assert volume on the bench.

Re-run it: `npx playwright test e2e/kernel.spec.ts --project=desktop --reporter=list` prints every number as a
`stage0 <name> <ms>` line. To measure a device that cannot run a dev server, build with the spike in
(`CAD_SPIKE=1 npm run build && npm run preview`) and open `/spike/stage0/index.html` on it — the spike page is
opt-in and never ships in a deploy build (vite.config.ts:9-15), so it exists only on a branch preview or a local
server. It starts on load; "Run again" repeats without re-fetching the wasm.

## The numbers

Measured 2026-11-11 on the spark — Linux aarch64 (DGX Spark, 20 cores), Chromium through Playwright 1.64, served
by `vite preview` on localhost. The wasm is 21241345 bytes (20.25 MiB) and it came out of the browser's HTTP
cache: 135 ms cannot be a 20 MiB fetch, and the file name is hashed with `Cache-Control: immutable`, so a repeat
visit never re-pulls it. First visit on a device pays that fetch on top of `kernel load` below — for the iPad it
is the Tailscale round trip, not the compute, that dominates.

| what | `maxDeviation` 0.1 mm | `maxDeviation` 0.02 mm |
| --- | --- | --- |
| kernel load: worker + 20.25 MiB wasm (HTTP-cached) | 135 ms | — |
| rebuild, 1 step (the box) | 44 ms | — |
| **rebuild, 20 steps (the bench)** | **815 ms** median (946, 816, 804, 800, 799) | 814 ms median (982, 822, 814, 808, 806) |
| preview: `meshHistoryStep` on the last step | 78 ms median (79, 77, 79, 78, 77) | not run |
| export: `saveShapeSTEP` | 92 ms | 90 ms |
| volume probe | box 14400, bench 11664 mm³ | same |

Nothing behind these rebuilds is memoised, and that is now measured rather than asserted: the kernel zeroes its
cache counters at the start of every `evaluate` and prints its own tally at the end of the same one
(CascadeWorker.js:161-192), so the bench carries a per-build `Cache: 0 hits, 3 misses` line and
`e2e/kernel.spec.ts` parses the hit count out of it — `toContain("0 hits")` would have been satisfied by
"100 hits". Every probe reading arrived under the build id of the build that asked for it (the bench build's id
differs from the box's, also asserted). And `error-growth 0` confirms the client's `console.error` patch does not
nest across the ~12 builds one worker runs: the script arrives through a plain `eval` inside a method, so `const`
bindings are per-build while `console.error =` writes the global — an unguarded patch would have multiplied each
kernel error by 2^(builds-1).

## The decision

- **`maxDeviation`: 0.1 mm**, the kernel's own default, stays. 0.02 mm changed nothing — 814 vs 815 ms on this
  part — because every face in it is planar, so a finer tessellation costs nothing and buys nothing visible.
  Curved sketches (Task 12's fillets, circles at speed) are where the two will separate; that is a v1.2 question,
  not a v1.0 one. The app may still ask for 0.02 while the user drags, but not because it is faster.
- **Does v1.0 need the optimistic preview: NOT DECIDED — pending the iPad row below.** The spec draws the line at
  ~2 s on an iPad, and 815 ms is a spark-desktop-Chromium number. For the iPad to cross the line it only has to
  be 2.5× slower than this machine, which an iPad doing the same OCCT work in Safari's wasm JIT plausibly is.
  Task 9 should not wire the preview on this number alone, and should not skip it either.
- What is *not* in doubt: the preview is cheap insurance. `meshHistoryStep` came back in 78 ms — 10× under a
  rebuild — and returned a solid, so the fallback path works and costs one extra call. If the iPad rebuild lands
  over 2 s, wiring it in Task 9 is a ~78 ms win per edit.

## iPad (pending — Task 15 with Michael)

| what | iPad |
| --- | --- |
| kernel load | not measured |
| rebuild, 1 step | not measured |
| rebuild, 20 steps | not measured |
| preview (`meshHistoryStep`) | not measured |
| export STEP | not measured |

To fill this in: deploy the branch, open `https://<preview-url>/spike/stage0/index.html` in Safari on the iPad,
wait for the page to say `done`, and read the `stage0 …` block. No console needed — the page prints its own
numbers, and "Save STEP" hands back the exported file so the export can be checked in Files.
