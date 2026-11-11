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
	expect(r.box.faceCount).toBeGreaterThan(0);
	const volume = r.box.volume ?? 0;
	expect(Math.abs(volume - BOX) / BOX, `volume probe read ${volume}`).toBeLessThan(0.001);

	// The measurement plumbing v1.3 depends on: probe readings arrive on the log channel, keyed by the build
	// that asked for them. A second build must carry a second id, so a stale reading cannot be mistaken for now.
	expect(r.box.probeKey).toBe(`${r.box.buildId}|${r.box.stepId}|volume`);
	const bench = r.deviations[String(0.1)].build;
	expect(bench.buildId, "a rebuild must carry a new build id").not.toBe(r.box.buildId);
	expect(bench.probeKey).toBe(`${bench.buildId}|${bench.stepId}|volume`);
	// The kernel's cache is off on every build, so timing five rebuilds measures five rebuilds.
	expect(r.cacheLine, "the worker's own cache tally, on the log channel").toContain("0 hits");

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
