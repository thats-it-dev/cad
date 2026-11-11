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

Measured 2026-11-11 on the spark — Linux aarch64 (DGX Spark, 20 cores), Chromium through Playwright 1.64, one
`--project=desktop` run of `e2e/kernel.spec.ts`, served by `vite preview` on localhost. Every number in the table
is from that single run, and each is a line the harness printed (the rebuild rows carry the harness's own
`samples-…` and `median-…` lines rather than numbers pasted in by hand). The wasm is 21241345 bytes (20.25 MiB)
and it came out of the browser's HTTP cache: 130 ms cannot be a 20 MiB fetch. It is not content-hashed —
`public/kernel/` is copied verbatim to `dist/kernel/` — so the caching comes from the long `Cache-Control` on
that stable URL, not from the file name. A device's first visit pays that fetch on top of `kernel load`: for the
iPad it will be the Tailscale round trip, not the compute, that dominates.

| what | `maxDeviation` 0.1 mm | `maxDeviation` 0.02 mm |
| --- | --- | --- |
| kernel load: worker + 20.25 MiB wasm (HTTP-cached) | 130 ms | — |
| rebuild, 1 step (the box) | 45 ms | — |
| **rebuild, 20 steps (the bench)** | **816 ms** median (972, 826, 816, 810, 810) | 809 ms median (985, 826, 809, 803, 801) |
| preview: `meshHistoryStep` on the last step | 79 ms median (79, 79, 79, 78, 77) | not run |
| export: `saveShapeSTEP` | 88 ms | 88 ms |
| volume probe | box 14400, bench 11664 mm³ | same |

Nothing behind these rebuilds is memoised, and that is measured rather than asserted: the shipped worker zeroes
`cacheHits` and `cacheMisses` at the top of its `evaluate` and prints the tally at the end of the same one
(`public/kernel/cascade-worker.js:16`), so every build carries its own `Cache: 0 hits, N misses` line and
`e2e/kernel.spec.ts` parses the hit count out of it — `toContain("0 hits")` would have been satisfied by "100
hits". The mechanism is worth stating exactly, because it cuts against intuition: with the cache off the kernel
never *stores*, so it can never *hit*. "0 hits" is what turning the cache off looks like, and it is per evaluate,
not cumulative. Every probe reading arrived under the build id of the build that asked for it (the bench build's
id differs from the box's, also asserted).

`error-growth 0` is a tripwire, not a proof: clean builds raise no `console.error`, so it reads 0 whether or not
the patch nests. The proof is the unit test in `test/kernel-client.test.ts`, which evals the preamble three times
in one worker-like context and asserts one report per error — 3 reports unguarded, 1 guarded. The reason nesting
was possible at all: the worker runs the script through `eval(payload.code)` inside its `evaluate` method, which
is an *indirect* eval, so a `const` in the client's preamble is scoped to that single evaluation while
`console.error =` writes the shared global. Growth is linear (one post, then one call into the previous wrapper),
not exponential.

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
