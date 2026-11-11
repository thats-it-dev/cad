// Stage 0's one real-kernel test: the spike page under spike/stage0 runs the committed kernel, and this reads
// what it measured. Everything else in e2e uses the fake worker (see e2e/cad.spec.ts) so the suite stays fast;
// this is the run that pays for 20.25 MiB of wasm and real OCCT calls, once per quality.
import type { Page } from "@playwright/test";
import type { Stage0 } from "../spike/stage0/bench.ts";
import { expect, test } from "./csp.ts";

// The kernel's first load, then five rebuilds and one export at each of two tessellation qualities.
test.setTimeout(420_000);

/** The 40 × 30 × 12 mm box the bench builds first, in mm³. */
const BOX = 40 * 30 * 12;

/** The page writes its JSON and flips `body[data-done]` in the same turn, so "1" means every number is on screen. */
const settled = (page: Page) => page.waitForFunction(() => document.body.dataset.done === "1", null, { timeout: 360_000 });

async function measured(page: Page): Promise<Stage0 & { failed?: string }> {
	const json = await page.locator("#result").textContent();
	if (!json) throw new Error("the spike page finished with no JSON");
	return JSON.parse(json) as Stage0 & { failed?: string };
}

test("the real kernel builds a solid and measures the box it built", async ({ page }) => {
	const said: string[] = [];
	page.on("console", (m) => {
		const line = m.text();
		if (line.startsWith("stage0 ")) {
			said.push(line);
			console.log(line); // the numbers docs/stage0.md records, in this test's output
		}
	});

	await page.goto("/spike/stage0/index.html");
	await settled(page);
	const r = await measured(page);

	// A page that threw writes { failed } instead of the measurements; say which line died.
	expect(r.failed, "the spike page reported a failure").toBeUndefined();
	expect(said.length, "the page must print its stage0 lines").toBeGreaterThan(8);

	// The single box: a solid comes back, and the kernel's own `Volume` agrees with arithmetic to 0.1%.
	expect(r.box.ok, r.box.error ?? "the box build reported no failure").toBe(true);
	// Six, not merely > 0: a box has six faces, and this is the assertion that pins the reply's nesting. The
	// client once read faces from the wrong depth of combineAndRenderShapes' payload and decodeMesh made a
	// one-face mesh of it, which a "solid came back" check could never see.
	expect(r.box.faceCount, "one extruded box is six faces").toBe(6);
	const volume = r.box.volume ?? 0;
	expect(Math.abs(volume - BOX) / BOX, `volume probe read ${volume}`).toBeLessThan(0.001);

	// The measurement plumbing v1.3 depends on: probe readings arrive on the log channel, keyed by the build
	// that asked for them. A second build must carry a second id, so a stale reading cannot be mistaken for now.
	expect(r.box.probeKey).toBe(`${r.box.buildId}|${r.box.stepId}|volume`);
	const bench = r.deviations[String(0.1)].build;
	expect(bench.buildId, "a rebuild must carry a new build id").not.toBe(r.box.buildId);
	expect(bench.probeKey).toBe(`${bench.buildId}|${bench.stepId}|volume`);
	// The shipped worker zeroes its cache counters at the start of every evaluate and prints the tally at the end
	// of the same one (public/kernel/cascade-worker.js:16), so each build carries its own evidence that nothing was memoised.
	const hitsRe = /Cache: (\d+) hits/;
	for (const [line, label] of [
		[bench.cacheLine, "the 20-step rebuild"],
		[r.box.cacheLine, "the box build"],
	] as const) {
		expect(line, `the worker's own cache tally for ${label}`).toMatch(hitsRe);
		expect(Number(hitsRe.exec(line)?.[1]), `${label} must not hit the cache`).toBe(0);
	}

	expect(r.errorGrowth, "clean builds must add no console.error reports").toBe(0);

	// And the numbers themselves: all of them present, none of them zero.
	for (const deviation of ["0.1", "0.02"]) {
		const run = r.deviations[deviation];
		expect(run.rebuildMs).toHaveLength(5);
		expect(Math.max(...run.rebuildMs), `rebuilds at maxDeviation ${deviation}`).toBeGreaterThan(0);
		expect(run.exportMs).toHaveLength(1);
		expect(run.stepBytes, "STEP export must return the file text").toBeGreaterThan(0);
	}

	// The optimistic preview's own cost, which is the whole question Stage 0 asks.
	const preview = r.deviations[String(0.1)].previewMs;
	expect(preview).toHaveLength(5);
	expect(r.deviations[String(0.1)].previewFaces, "meshHistoryStep must return a solid").toBeGreaterThan(0);
	expect(Math.min(...r.deviations[String(0.1)].rebuildMs), "a rebuild must outlast a preview").toBeGreaterThan(Math.max(...preview));
});
