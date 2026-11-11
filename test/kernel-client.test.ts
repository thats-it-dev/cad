// The kernel client's protocol, tested against a stub worker rather than the 21 MB wasm bundle: what gets
// posted, what comes back, and what the client does when the worker stops talking or talks back with an error.
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, PREAMBLE_END, workerError, type BuildResult } from "../src/kernel/client.ts";
import { EMPTY_MESH } from "../src/kernel/decode.ts";
import type { CadDocument, Entity, Step } from "../src/model/types.ts";

type Msg = { type: string; payload: any; requestId?: number };
type Behaviour = (w: StubWorker, msg: Msg) => void;

/** The fake kernel's readings for each probe kind, in mm³, mm² and mm. */
const READING: Record<string, number> = { volume: 48_000, surface: 4_600, edgeLength: 40 };

class StubWorker {
	static instances: StubWorker[] = [];
	static behaviour: Behaviour = () => {};
	readonly url: string;
	readonly options: { type: string };
	readonly sent: Msg[] = [];
	terminated = false;
	onmessage: ((e: { data: Msg }) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;

	constructor(url: string, options: { type: string }) {
		this.url = url;
		this.options = options;
		StubWorker.instances.push(this);
		// A real worker delivers on its own timing, never inside `new Worker()`, so readiness is never sync.
		setTimeout(() => this.fire({ type: "startupCallback", payload: {} }), 0);
	}

	postMessage(msg: Msg): void {
		this.sent.push(msg);
		if (!this.terminated) StubWorker.behaviour(this, msg);
	}

	terminate(): void {
		this.terminated = true;
	}

	/** Delivers a message to the main thread, as the worker's own postMessage would. */
	fire(msg: Msg): void {
		if (!this.terminated) this.onmessage?.({ data: msg });
	}

	/** Surfaces a worker-side throw, which is the only way an `onerror` handler is ever reached. */
	fireError(message: string): void {
		this.onerror?.(workerError(message));
	}

	/** Answers a `request()`, echoing its requestId, as the worker's message wrapper does. */
	answer(msg: Msg, payload: unknown): void {
		this.fire({ type: msg.type, payload, requestId: msg.requestId });
	}

	of(type: string): Msg[] {
		return this.sent.filter((m) => m.type === type);
	}

	get last(): Msg {
		return this.sent[this.sent.length - 1];
	}
}

/** One triangle, shifted by `x` mm so a test can tell which faces came back. */
const face = (faceIndex: number, x: number) => ({
	vertex_coord: [x, 0, 0, x + 10, 0, 0, x + 10, 10, 0],
	uv_coord: [0, 0, 1, 0, 1, 1],
	normal_coord: [0, 0, 1, 0, 0, 1, 0, 0, 1],
	tri_indexes: [0, 1, 2],
	number_of_triangles: 1,
	face_index: faceIndex,
});

const combineReply = (faces: unknown[]) => [[faces, []], { groundPlaneVisible: undefined, gridVisible: undefined }];

/** The answering kernel: runs the script's probe calls, then meshes whatever it has. */
const answering =
	(faces: unknown[] = [face(0, 0)]): Behaviour =>
	(w, msg) => {
		if (msg.type === "Evaluate") {
			for (const p of probeCalls(msg.payload.code)) {
				if (p.expr.trim() !== "null") w.fire({ type: "log", payload: `__PROBE__${p.buildId}|${p.stepId}|${p.kind}|${READING[p.kind]}` }); // as the patched __b posts it, not via console.log
			}
			w.fire({ type: "log", payload: `evaluated ${probeCalls(msg.payload.code).length} probe(s)` });
		}
		if (msg.type === "combineAndRenderShapes") w.answer(msg, combineReply(faces));
		// meshHistoryStep replies with the bare [faces, edges] pair, no sceneOptions. The face is tagged by the
		// step index it was meshed from, so a test can see which history entry the client addressed.
		if (msg.type === "meshHistoryStep") w.answer(msg, [[face(msg.payload.stepIndex, msg.payload.stepIndex * 100)], []]);
		if (msg.type === "saveShapeSTEP") w.answer(msg, "ISO-10303-21;\nDATA;");
	};

/** An `Evaluate` that never gets a mesh back, i.e. a hung kernel. */
const silent: Behaviour = () => {};

/** A worker error that lands the way the real one does: reported from inside evaluate, and the worker's own
 *  rethrow arriving afterwards as an onerror we must not double-count. */
const errorAfterReply =
	(message: string, faces: unknown[] = []): Behaviour =>
	(w, msg) => {
		if (msg.type === "Evaluate") {
			w.fire({ type: "log", payload: `__ERROR__${message}` });
			setTimeout(() => w.fireError(message), 0);
		}
		if (msg.type === "combineAndRenderShapes") w.answer(msg, combineReply(faces));
	};

/** The way a kernel error reaches us now: reported from inside evaluate, ahead of the synchronous mesh reply,
 *  because the client patches console.error (see PROBE_PREAMBLE) instead of waiting for the worker's rethrow. */
const errorTwoHopsAfterReply =
	(message: string): Behaviour =>
	(w, msg) => {
		if (msg.type === "Evaluate") w.fire({ type: "log", payload: `__ERROR__${message}` });
		if (msg.type === "combineAndRenderShapes") w.answer(msg, combineReply([face(0, 0), face(1, 0)]));
	};
const probeCalls = (code: string) =>
	[...code.matchAll(/__b\("([^"]*)", ?"([^"]*)", ?"([^"]*)", ?([^)]*)\)/g)].map((m) => ({ buildId: m[1], stepId: m[2], kind: m[3], expr: m[4] }));

const rect: Entity[] = [{ kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 0]] }];

/** A step on an axis plane builds (3 ops); on a face it cannot yet (0 ops, Task 12 threads null). */
const pad = (id: string, axis = true): Step => ({
	id,
	kind: "extrude",
	name: id,
	depth: 12_000,
	cut: false,
	sketch: {
		id: `sketch-${id}`,
		plane: axis ? { kind: "axis", axis: "XY", offset: 0 } : { kind: "face", face: { step: "s1", role: "face", index: 0 } },
		origin: [0, 0],
		axes: [
			[1_000_000, 0, 0],
			[0, 1_000_000, 0],
		],
		entities: rect,
	},
});

const doc = (...steps: Step[]): CadDocument => ({ schema: 1, name: "part", steps });

function client_(behaviour: Behaviour, opts: { toolTimeoutMs?: number } = {}) {
	StubWorker.behaviour = behaviour;
	const errors: ErrorEvent[] = [];
	const logs: string[] = [];
	const client = new KernelClient({
		workerUrl: "/kernel/fake-worker.js",
		toolTimeoutMs: 40,
		onError: (e: ErrorEvent) => errors.push(e),
		onLog: (l: string) => logs.push(l),
		...opts,
	});
	return { client, errors, logs, worker: () => StubWorker.instances[StubWorker.instances.length - 1] };
}

/** Resolves to a successful build, and fails the test with the kernel's own words when it is not one. */
const good = (r: BuildResult) => {
	if (!r.ok) throw new Error(`expected a good build, got: ${r.error}`);
	return r;
};

/** Narrows a failed build, and fails the test when the client claimed success instead. */
const bad = (r: BuildResult) => {
	if (r.ok) throw new Error("expected a failed build");
	return r;
};

beforeEach(() => {
	StubWorker.instances = [];
	StubWorker.behaviour = () => {};
	(globalThis as unknown as { Worker: typeof Worker }).Worker = StubWorker as unknown as typeof Worker;
});
afterEach(() => vi.restoreAllMocks());

describe("KernelClient: starting up", () => {
	it("owns the worker so it can watch it die", async () => {
		const { client } = client_(answering());
		expect(client.isReady()).toBe(false);
		await client.ready();
		expect(client.isReady()).toBe(true);
		const worker = StubWorker.instances[0];
		expect(worker.url).toBe("/kernel/fake-worker.js");
		expect(worker.options).toEqual({ type: "module" });
		client.dispose();
		expect(worker.terminated).toBe(true);
	});
});

describe("KernelClient: a build", () => {
	it("keeps the kernel cache off on every build", async () => {
		const { client, worker } = client_(answering());
		await client.build(doc(pad("s1")));
		expect(worker().of("Evaluate")[0].payload.GUIState).toEqual({ "Cache?": false });
		expect(worker().of("combineAndRenderShapes")).toHaveLength(1);
	});

	it("decodes the mesh the worker replies with", async () => {
		const { client } = client_(answering([face(3, 20)]));
		const r = good(await client.build(doc(pad("s1"))));
		expect(r.mesh.faceCount).toBe(1);
		expect(Array.from(r.mesh.positions)).toEqual([20, 0, 0, 30, 0, 0, 30, 10, 0]);
		expect(r.mesh.faceRanges).toEqual([{ faceIndex: 3, start: 0, count: 3 }]);
		expect(r.probes).toEqual({});
	});

	it("keeps the last good mesh when the kernel throws mid-build", async () => {
		const { client, errors } = client_(answering());
		const first = good(await client.build(doc(pad("s1"))));
		StubWorker.behaviour = errorAfterReply("INTERNAL OPENCASCADE ERROR DURING GENERATE: boolean failed", [face(0, 0), face(1, 0)]);
		const second = bad(await client.build(doc(pad("s1"), pad("s2"))));
		expect(second.error).toContain("boolean failed");
		expect(second.mesh).toBe(first.mesh);
		expect(errors.map((e) => e.message)).toEqual(["INTERNAL OPENCASCADE ERROR DURING GENERATE: boolean failed"]);

		StubWorker.behaviour = answering();
		expect(good(await client.build(doc(pad("s1")))).mesh).not.toBe(EMPTY_MESH);
	});

	it("still calls a late kernel error a failure, reported during evaluate", async () => {
			// The worker's own console.error rethrows from a setTimeout, which can land after the mesh reply and be
			// read as success. The client patches console.error to report synchronously instead, so the ordering is
			// settled by the kernel's message queue rather than by a timer nobody on this side can outwait.
			const { client } = client_(answering());
			const first = good(await client.build(doc(pad("s1"))));
			StubWorker.behaviour = errorTwoHopsAfterReply("INTERNAL OPENCASCADE ERROR DURING GENERATE: boolean failed");
			const second = bad(await client.build(doc(pad("s1"), pad("s2"))));
			expect(second.error).toContain("boolean failed");
			expect(second.mesh, "the canvas keeps what it had").toBe(first.mesh);
		});

		it("refuses a preview against a failed build's history", async () => {
			// evaluate wipes modelHistory even when it fails, so yesterday's step index now points at nothing, or
			// worse at another step's geometry. preview() must say so rather than draw a lie.
			const { client } = client_(answering());
			await good(await client.build(doc(pad("s1"))));
			StubWorker.behaviour = errorTwoHopsAfterReply("INTERNAL OPENCASCADE ERROR DURING GENERATE: boolean failed");
			await bad(await client.build(doc(pad("s1"), pad("s2"))));
			await expect(client.preview("s1", 2)).rejects.toThrow("not in the last good build");
		});

		it("does not fail a build over a step this version cannot build", async () => {
		const { client, errors } = client_(
			errorAfterReply("INTERNAL OPENCASCADE ERROR DURING GENERATE: Null Shape detected in sceneShapes; skipping: null", [face(0, 0)]),
		);
		const r = good(await client.build(doc(pad("s1"), pad("s2", false))));
		expect(r.mesh.faceCount).toBe(1);
		expect(errors).toEqual([]);
	});

	it("fails, and keeps the old mesh, when nothing at all was built", async () => {
		const { client } = client_(answering());
		const first = good(await client.build(doc(pad("s1"))));
		StubWorker.behaviour = errorAfterReply("INTERNAL OPENCASCADE ERROR DURING GENERATE: There were no scene shapes returned!");
		const second = await client.build(doc(pad("s1", false)));
		expect(second.ok).toBe(false);
		expect(second.mesh).toBe(first.mesh);
		expect(second.mesh).not.toBe(EMPTY_MESH);
	});

	it("recovers from a worker that stops answering", async () => {
		const { client, worker } = client_(answering());
		const first = good(await client.build(doc(pad("s1"))));
		const stalled = worker();
		expect(stalled.sent.length).toBeGreaterThan(0);

		StubWorker.behaviour = silent;
		const result = bad(await client.build(doc(pad("s1"), pad("s2"))));
		expect(result.error).toMatch(/timed out/);
		expect(result.mesh).toBe(first.mesh);
		// The dead worker is gone, and a fresh one took its place without the caller asking twice.
		expect(stalled.terminated).toBe(true);
		expect(StubWorker.instances).toHaveLength(2);

		StubWorker.behaviour = answering([face(0, 500)]);
		const next = good(await client.build(doc(pad("s1"))));
		expect(Array.from(next.mesh.positions)).toEqual([500, 0, 0, 510, 0, 0, 510, 10, 0]);
	});
});

describe("KernelClient: probes", () => {
	it("defines __b and collects what the script logs", async () => {
		const { client, worker, logs } = client_(answering());
		const probes = [{ kind: "volume" as const }, { kind: "surface" as const, target: { step: "s1", role: "face" as const, index: 0 } }, { kind: "edgeLength" as const }];
		const r = good(await client.build(doc(pad("s1")), probes));
		const code = worker().of("Evaluate")[0].payload.code as string;
		expect(code).toContain("const __b =");
		expect(code).toContain('"__PROBE__"');
		expect(probeCalls(code).map((p) => p.buildId)).toEqual([r.buildId, r.buildId, r.buildId]);
		expect(r.probes).toEqual({
			[`${r.buildId}|s1|volume`]: 48_000,
			[`${r.buildId}|s1|surface`]: 4_600,
			[`${r.buildId}|s1|edgeLength`]: 40,
		});
		expect(logs.some((l) => l.includes("__PROBE__"))).toBe(false);
		expect(logs.some((l) => l.startsWith("evaluated"))).toBe(true);
	});

	it("drops a stale build's probe and reports no reading for a null one", async () => {
		const { client } = client_(answering());
		StubWorker.behaviour = (w, msg) => {
			if (msg.type === "Evaluate") {
				const [p] = probeCalls(msg.payload.code);
				w.fire({ type: "log", payload: `__PROBE__stale-build|${p.stepId}|${p.kind}|1e+9` });
				w.fire({ type: "log", payload: `__PROBE__${p.buildId}|skipped|volume|null` });
			}
			answering()(w, msg);
		};
		const r = good(await client.build(doc(pad("s1")), [{ kind: "volume" }]));
		expect(Object.keys(r.probes)).toEqual([`${r.buildId}|s1|volume`]);
		expect(Object.values(r.probes)).not.toContain(0);
	});

	it("patches console.error once per worker, not once per build", async () => {
		// The worker runs the script through `eval(payload.code)` inside its evaluate method, which is an
		// indirect eval: a `const` in the preamble is scoped to that one evaluation while `console.error =`
		// writes the global. Patched unguarded, every build wraps the previous build's wrapper and delegates to
		// it, so one kernel error is reported once per build since the first patch. Three builds, one context.
		const { client, worker } = client_(answering());
		await client.build(doc(pad("s1")), []);
		// Everything up to the client's own end-of-preamble marker; past it is the script builder's geometry,
		// which needs the kernel library and would throw in this bare context.
		const code = worker().of("Evaluate")[0].payload.code.split(PREAMBLE_END)[0] as string;
		const posted: string[] = [];
		const sandbox = {
			postMessage: (m: Msg) => void posted.push(String(m.payload)),
			console: { error: (..._a: unknown[]) => {}, log: (..._a: unknown[]) => {} },
		};
		const ctx = vm.createContext(sandbox);
		vm.runInContext("self = globalThis;", ctx); // the worker's global, which the sandbox object alone is not
		const run = (why: string) => vm.runInContext(`globalThis.eval(${JSON.stringify(code)});`, ctx, { filename: why });
		// Each build's script goes through globalThis.eval, not a bare script: `eval(payload.code)` inside the
		// worker's evaluate method (public/kernel/cascade-worker.js:16) is an INDIRECT eval — its const bindings
		// stay local to that evaluation while `console.error =` writes the global. A top-level script does the
		// opposite, and the second run would throw "Identifier '__b' has already been declared": a vm artifact,
		// not the bug here.
		run("build 1"); // installs the guard
		run("build 2"); // would wrap build 1's wrapper without it
		run("build 3");
		sandbox.console.error("boolean failed");
		// The wrapper posts once and then delegates to the one wrapper before it, so growth is linear: an
		// unguarded patch gives three reports for three builds. Confirmed by removing the guard.
		expect(posted.filter((p) => p.startsWith("__ERROR__"))).toEqual(["__ERROR__boolean failed"]);
	});
});

describe("KernelClient: history and export", () => {
	it("previews a step by its place in the kernel's op history", async () => {
		const { client, worker } = client_(answering());
		await client.build(doc(pad("s1"), pad("s2")));
		// s1 is Polygon/MakeFace/Extrude, so s2's first op is history step 3.
		const mesh = await client.preview("s2", 0);
		expect(worker().of("meshHistoryStep").at(-1)?.payload).toEqual({ stepIndex: 3, maxDeviation: 0.1 });
		expect(mesh.faceCount).toBe(1);
		expect(mesh.positions[0]).toBe(300);

		await client.preview("s1", 2);
		expect(worker().of("meshHistoryStep").at(-1)?.payload).toEqual({ stepIndex: 2, maxDeviation: 0.1 });
	});

	it("refuses to preview a step that was never built", async () => {
		const { client } = client_(answering());
		await client.build(doc(pad("s1")));
		await expect(client.preview("s404", 0)).rejects.toThrow(/s404/);
	});

	it("hands back the STEP text the worker writes", async () => {
		const { client, worker } = client_(answering());
		await client.build(doc(pad("s1")));
		expect(await client.exportSTEP()).toBe("ISO-10303-21;\nDATA;");
		expect(worker().of("saveShapeSTEP").at(-1)?.requestId).toBeGreaterThan(0);
	});

	it("previews nothing at all as an empty mesh", async () => {
		const { client } = client_(answering());
		await client.build(doc(pad("s1")));
		StubWorker.behaviour = (w, msg) => {
			if (msg.type === "meshHistoryStep") w.answer(msg, null);
		};
		expect(await client.preview("s1", 0)).toBe(EMPTY_MESH);
	});
});
