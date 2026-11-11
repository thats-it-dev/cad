// Stage 0: the one number the design could not answer on paper — wall-clock for a whole-document rebuild of a
// 20-step part, and `meshHistoryStep` on its own. The app's own KernelClient does the work, so what is timed is
// what v1.0 will ship: same worker, same generated script, same cache-off `GUIState`.
//
// Disposable by design (docs/stage0.md holds the outcome). Nothing under src/ imports this file; it imports
// src/, and e2e/kernel.spec.ts drives the page this builds into.
//
// Two parts, deliberately: a single 40×30×12 mm box for TRUTH (its volume must read 14400 mm³), and a 20-step
// part for TIME. The box is the only build whose volume is asserted — nineteen disjoint cuts are exactly where
// the kernel's `Difference` logs "destroyed the main body", and a cut that consumes a body leaves `Union`
// adding volumes back. The bench cuts go clean through the material so they neither consume it nor complain.
import { type BuildResult, KernelClient } from "../../src/kernel/client.ts";
import { newDocument, newId, insertExtrude } from "../../src/model/doc.ts";
import type { CadDocument, Entity, PlaneRef, Sketch } from "../../src/model/types.ts";
import type { Umm } from "../../src/model/units.ts";
import { buildScript } from "../../src/kernel/script.ts";

const WORKER = "/kernel/cascade-worker.js";
/** Tessellation tolerances to compare: the kernel's own default, and the "preview" quality Task 9 would use. */
const DEVIATIONS = [0.1, 0.02];
const REPEATS = 5;

/** mm in the document's own unit: the base is 40 × 30 × 12 mm, which is what 14400 mm³ is made of. */
const BASE = { w: 40_000, h: 30_000, depth: 12_000 };
/** A 2 × 6 mm slot, cut clean through the 12 mm height, on a 5 × 4 grid that stays inside the base. */
const SLOT = { w: 2_000, h: 6_000, depth: 20_000, cols: 5, colStep: 7_000, colAt: 5_000, rowStep: 7_000, rowAt: 5_000 };
const CUTS = 19;

const XY: PlaneRef = { kind: "axis", axis: "XY", offset: 0 };
const AXES: Sketch["axes"] = [
	[1_000_000, 0, 0],
	[0, 1_000_000, 0],
];

export type Build = { buildId: string; stepId: string; ok: boolean; error: string | null; faceCount: number; ms: number; probeKey: string | null; volume: number | null };

export type Deviation = {
	build: Build;
	/** Every rebuild sample in ms, oldest first; the first one pays for nothing the others do not. */
	rebuildMs: number[];
	previewMs: number[];
	exportMs: number[];
	previewFaces: number;
	stepBytes: number;
};

export type Stage0 = {
	loadMs: number;
	/** The worker's own cache tally from its `log` channel: "hits" must stay 0 while the cache is off. */
	cacheLine: string;
	/** What the kernel reported through `onError`, including faults a build shrugged off. */
	kernelErrors: string[];
	box: Build;
	deviations: Record<string, Deviation>;
};

const median = (ms: number[]): number => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 0;

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
	const t0 = performance.now();
	const value = await fn();
	return [performance.now() - t0, value];
}

const round = (v: number): number => Math.round(v * 10) / 10;

/** A closed rectangle in sketch µm; the repeat of the first point is how a stroke closes. */
const rect = (x: Umm, y: Umm, w: Umm, h: Umm): Entity[] => [
	{ kind: "poly", points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]] },
];

const cut = (i: number): Entity[] => {
	const cx = SLOT.colAt + SLOT.colStep * (i % SLOT.cols);
	const cy = SLOT.rowAt + SLOT.rowStep * Math.floor(i / SLOT.cols);
	return rect(cx - SLOT.w / 2, cy - SLOT.h / 2, SLOT.w, SLOT.h);
};

function add(doc: CadDocument, entities: Entity[], depth: Umm, isCut: boolean): CadDocument {
	const sketch: Sketch = { id: newId("sketch"), plane: XY, origin: [0, 0], axes: AXES, entities };
	return insertExtrude(doc, null, sketch, depth, isCut).doc;
}

const boxDoc = (): CadDocument => add(newDocument("stage0 box"), rect(0, 0, BASE.w, BASE.h), BASE.depth, false);

function benchDoc(): CadDocument {
	let doc = add(newDocument("stage0 bench"), rect(0, 0, BASE.w, BASE.h), BASE.depth, false);
	for (let i = 0; i < CUTS; i++) doc = add(doc, cut(i), SLOT.depth, true);
	return doc;
}

/** The probe a build answers with, read by its `log` key alone: `<buildId>|<stepId>|<kind>`, or null when
 *  nothing came back. Nothing here re-derives the build id — the key is whatever the current build posted. */
function volumeReading(result: BuildResult): { key: string | null; value: number | null } {
	if (!result.ok) return { key: null, value: null };
	const key = Object.keys(result.probes).find((k) => k.endsWith("|volume")) ?? null;
	return { key, value: key === null ? null : result.probes[key] };
}

let client: KernelClient | null = null;
let stepFile = "";
let cacheLine = "";
const lines: string[] = [];

/** One measured number, printed as `stage0 <name> <value>` for e2e/kernel.spec.ts to read, and listed on the
 *  page so the same run is legible on an iPad where nobody is watching a console. */
function say(name: string, value: number | string): void {
	const line = `stage0 ${name} ${value}`;
	lines.push(line);
	const el = document.getElementById("lines");
	if (el) el.textContent = lines.join("\n");
	console.log(line);
}

/** A worker per deviation: `maxDeviation` is a client option, so comparing qualities means rebuilding it. */
async function open(maxDeviation: number, errors: string[]): Promise<number> {
	client?.dispose();
	const next = new KernelClient({
		workerUrl: WORKER,
		maxDeviation,
		onError: (e) => errors.push(e.message),
		onCrash: (e) => errors.push(e.message),
		onLog: (line) => {
			if (line.includes("hits")) cacheLine = line;
		},
	});
	client = next;
	return (await timed(() => next.ready()))[0];
}

const kernel = (): KernelClient => {
	if (!client) throw new Error("no kernel worker is open");
	return client;
};

/** One build of `doc`, timed, reduced to the numbers the page reports. */
async function once(doc: CadDocument, label: string): Promise<Build> {
	const [ms, build] = await timed(() => kernel().build(doc, [{ kind: "volume" }]));
	const probe = volumeReading(build);
	const value: Build = {
		buildId: build.buildId,
		stepId: doc.steps[doc.steps.length - 1].id,
		ok: build.ok,
		error: build.ok ? null : build.error,
		faceCount: build.mesh.faceCount,
		ms: round(ms),
		probeKey: probe.key,
		volume: probe.value ?? null,
	};
	say(label, value.ms);
	if (value.volume !== null) say(`volume-after-${label}`, value.volume);
	return value;
}

export async function runBench(): Promise<Stage0> {
	const kernelErrors: string[] = [];
	status("loading the kernel (20.25 MiB of wasm on the first visit)…");

	const loadMs = await open(DEVIATIONS[0], kernelErrors);
	say("load", round(loadMs));
	const box = await once(boxDoc(), "rebuild-1-step");
	say("cache", cacheLine);

	const doc = benchDoc();
	// The last op of the last step is the solid the optimistic preview would draw while a rebuild catches up.
	const stepId = doc.steps[doc.steps.length - 1].id;
	const lastOp = buildScript(doc, { probes: [], buildId: "spike" }).opsPerStep[stepId] - 1;
	const deviations: Record<string, Deviation> = {};

	for (const maxDeviation of DEVIATIONS) {
		status(`maxDeviation ${maxDeviation}: ${REPEATS} rebuilds…`);
		// The boot worker already has the first quality, so only a change of `maxDeviation` pays for a new one.
		if (maxDeviation !== DEVIATIONS[0]) await open(maxDeviation, kernelErrors);
		const run: Deviation = { build: await once(doc, `rebuild-20-step@${maxDeviation}`), rebuildMs: [], previewMs: [], exportMs: [], previewFaces: 0, stepBytes: 0 };
		run.rebuildMs.push(run.build.ms);
		for (let i = 1; i < REPEATS; i++) run.rebuildMs.push((await once(doc, `rebuild-20-step@${maxDeviation}`)).ms);

		if (maxDeviation === DEVIATIONS[0]) {
			status("meshHistoryStep on its own…");
			for (let i = 0; i < REPEATS; i++) {
				const [ms, mesh] = await timed(() => kernel().preview(stepId, lastOp));
				run.previewMs.push(round(ms));
				run.previewFaces = mesh.faceCount;
				say(`preview@${maxDeviation}`, round(ms));
			}
		}

		status("exporting STEP…");
		const [ms] = await timed(async () => {
			stepFile = await kernel().exportSTEP();
		});
		run.exportMs.push(round(ms));
		run.stepBytes = stepFile.length;
		say(`export-step@${maxDeviation}`, round(ms));
		deviations[String(maxDeviation)] = run;
	}

	client?.dispose();
	say(`median-rebuild-20-step@${DEVIATIONS[0]}`, round(median(deviations[String(DEVIATIONS[0])].rebuildMs)));
	save.hidden = stepFile.length === 0;
	return { loadMs: round(loadMs), cacheLine, kernelErrors, box, deviations };
}

const status = (line: string): void => {
	const el = document.getElementById("status");
	if (el) el.textContent = line;
};

const save = document.getElementById("save") as HTMLButtonElement;
const go = document.getElementById("go") as HTMLButtonElement;

/** STEP in the kernel's MEMFS, posted back as text by `saveShapeSTEP`; saved through a blob so CSP stays at 'self' blob:. */
function downloadSTEP(): void {
	const url = URL.createObjectURL(new Blob([stepFile], { type: "model/step" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = "stage0.step";
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function main(): Promise<void> {
	const out = document.getElementById("result");
	go.disabled = true;
	try {
		const result = await runBench();
		if (out) out.textContent = JSON.stringify(result, null, 1);
		document.body.dataset.done = "1";
		status("done");
	} catch (e) {
		if (out) out.textContent = JSON.stringify({ failed: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }, null, 1);
		document.body.dataset.done = "1";
		status("failed");
	} finally {
		go.disabled = false;
	}
}

go.addEventListener("click", () => void main());
save.addEventListener("click", downloadSTEP);
void main();
