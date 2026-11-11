// The kernel client: one cascade-core worker, and the build protocol spoken over it.
//
// The worker is constructed here rather than by the vendored `CascadeEngine` on purpose. That wrapper builds
// its own worker (CascadeEngine.js:15) and never hands it out, so nothing outside it can see `onerror`, and a
// kernel that dies mid-build would leave the app waiting on a promise that no longer has an answer. Owning the
// worker means owning three things the engine cannot do: an `onerror` that marks a build failed, a
// `toolTimeoutMs` shorter than MessageBus's own 30 s (MessageBus.js:53) so a hung kernel is recovered instead
// of mourned, and a probe reader that turns the script's `console.log` lines back into measurements.
//
// Two rules below carry most of the value. A failed build hands back the mesh it had, never an empty one, so
// the canvas keeps showing the last thing that worked. And the worker's `console.error` does not report the
// error, it *rethrows it on a later task*, so a build waits one task after the meshing reply before deciding
// whether it succeeded.
import { decodeMesh, EMPTY_MESH, type Mesh, type RawEdge, type RawFace } from "./decode.ts";
import { buildScript, type Probe } from "./script.ts";
import { MessageBus } from "./vendor/MessageBus.js";
import type { CadDocument } from "../model/types.ts";

export type BuildResult =
	| { ok: true; mesh: Mesh; buildId: string; probes: Record<string, number> }
	| { ok: false; mesh: Mesh; buildId: string; error: string };

export type KernelOptions = {
	/** Same-origin URL, never a bundled hash: the worker is a module worker. Task 9 passes window.__CAD_KERNEL__. */
	workerUrl: string;
	onError: (e: ErrorEvent) => void;
	/** A worker error the app has not already been told about: the kernel throwing between builds, or its own
 *  one-task-late rethrow of a fault settle() reported synchronously. Optional so a caller that only cares
 *  about failed builds is not forced to de-duplicate them. */
	onCrash?: (e: ErrorEvent) => void;
	onLog?: (line: string) => void;
	/** How long the worker may take to answer one call before it is replaced. */
	toolTimeoutMs?: number;
	/** Tessellation tolerance in mm; the kernel's own default (CascadeWorker's `maxDeviation || .1`). */
	maxDeviation?: number;
};

const TIMEOUT = 10_000;
const MAX_DEVIATION = 0.1;
/** The kernel memoises each operation by its arguments, so an edited step can quietly reuse the previous
 *  build's shape. `self.GUIState["Cache?"]` gates both the lookup and the store, so it goes off every build. */
const GUI_STATE = { "Cache?": false };

/** What `combineAndRenderShapes` replies with: the raw `[ [faces, edges], sceneOptions ]` pair. The vendored
 *  engine destructures it exactly this way (`const [[faces, edges], opts] = result`, vendor/CascadeEngine.js),
 *  and the real kernel confirmed it: reading faces one level deeper made `decodeMesh` call `.reduce` on a
 *  number and every build came back failed with a message about the mesh, not the worker. */
type CombineReply = [[RawFace[], RawEdge[]], Record<string, unknown>] | null | undefined;

/** A shape the kernel skipped, which is expected while a face-anchored step exists (Task 12). Not a failure. */
const SKIPPED_SHAPE = /Null Shape detected in sceneShapes|Non-Shape detected in sceneShapes/i;
const PROBE_PREFIX = "__PROBE__";
const PROBE_LINE = /^__PROBE__([^|]+)\|([^|]+)\|([^|]+)\|(-?[\d.eE+-]+)$/;
const ERROR_PREFIX = "__ERROR__";

/** Marks the end of the preamble inside the code sent to the worker, so a test can take the preamble out of a
 *  real Evaluate payload without counting lines of someone else's formatting. */
export const PREAMBLE_END = "/*__CAD_PREAMBLE__*/";

/** Both channels post directly rather than through console: the shipped worker wraps console.error in a throw
 *  from a setTimeout and posts console.log from one too (public/kernel/cascade-worker.js:16), which is how a
 *  failure ends up arriving AFTER the mesh reply and being read as success. A synchronous postMessage from a
 *  call made during evaluate lands before any of that, and the reply to combineAndRenderShapes is itself
 *  posted synchronously from the same turn, so ordering is: geometry, its errors and probes, then the settle. */
const PROBE_PREAMBLE =
	`self.__cadLog = (p) => self.postMessage({ type: "log", payload: p });
` +
	`const __b = (buildId, stepId, kind, value) => self.__cadLog("${PROBE_PREFIX}" + buildId + "|" + stepId + "|" + kind + "|" + value);
` +
	// Guarded by a worker global, not by a const: the worker runs this through `eval(payload.code)` inside its
	// evaluate method, which is an indirect eval, so a const here is scoped to that one evaluation while
	// `console.error =` writes the shared global. Unguarded, every build would wrap the previous build's wrapper
	// and delegate to it, and one kernel error would be posted once per build since the first patch.
	`if (!self.__cadPatched) { self.__cadPatched = true; const __console0 = console.error; console.error = (...a) => { self.__cadLog("${ERROR_PREFIX}" + a.map((x) => (x && x.message ? x.message : String(x))).join(" ")); return __console0.apply(console, a); }; }
${PREAMBLE_END}
`;

/** An ErrorEvent is a browser global; it is absent on Node < 26, which is what CI runs. Everything the app
 *  reads off one is `message`, so the fallback is honest rather than decorative. */
export const workerError = (message: string): ErrorEvent =>
	typeof ErrorEvent === "function" ? new ErrorEvent("error", { message }) : ({ message, type: "error" } as ErrorEvent);

/** What the worker is doing right now: probes land on the log stream, not on a reply. */
type Live = { buildId: string; probes: Record<string, number>; error: string | null; event: ErrorEvent | null };


export class KernelClient {
	private readonly opts: KernelOptions;
	private readonly timeout: number;
	private readonly deviation: number;
	private worker: Worker | null = null;
	private bus: MessageBus | null = null;
	private handshake: Promise<void> = new Promise(() => {});
	private alive = false;
	/** The last mesh that came from a build that did not fail. */
	private lastMesh: Mesh = EMPTY_MESH;
	/** Op-line counts of the last good build, in step order, for addressing the worker's model history. */
	private history: { stepId: string; ops: number }[] = [];
	private live: Live | null = null;

	constructor(opts: KernelOptions) {
		this.opts = opts;
		this.timeout = opts.toolTimeoutMs ?? TIMEOUT;
		this.deviation = opts.maxDeviation ?? MAX_DEVIATION;
	}

	/** Resolves once the worker has loaded wasm and answered its startup handshake. */
	ready(): Promise<void> {
		if (!this.bus) this.spawn();
		return this.handshake;
	}

	isReady(): boolean {
		return this.alive;
	}

	async build(doc: CadDocument, probes: Probe[] = []): Promise<BuildResult> {
		const buildId = crypto.randomUUID();
		const script = buildScript(doc, { probes, buildId });
		this.live = { buildId, probes: {}, error: null, event: null };
		try {
			await this.started();
			this.bus?.send("Evaluate", { code: PROBE_PREAMBLE + script.code, GUIState: GUI_STATE });
			const reply = await this.bus?.request<CombineReply>(
				"combineAndRenderShapes",
				{ maxDeviation: this.deviation, sceneOptions: {} },
				this.timeout,
			);
			// Nothing more to wait for: the errors and probes of this build were posted during evaluate, before
			// the synchronous reply we are now holding. An onerror that still arrives later belongs to a build the
			// caller has already been told about, and settle() has run by then.
			return this.settle(buildId, decodeMesh(reply ? { faces: reply[0][0], edges: reply[0][1] } : null), script.opsPerStep);
		} catch (e) {
			// A worker that answered nothing cannot be trusted to answer the next build either.
			this.recover();
			return this.failed(buildId, e instanceof Error ? e.message : String(e));
		}
	}

	/** Triangulates one operation of one step. `opIndex` counts this step's own ops, of which `preview` knows none. */
	async preview(stepId: string, opIndex: number): Promise<Mesh> {
		const stepIndex = this.historyIndex(stepId, opIndex);
		await this.started();
		const reply = await this.bus?.request<[RawFace[], RawEdge[]] | null>("meshHistoryStep", { stepIndex, maxDeviation: this.deviation }, this.timeout);
		return decodeMesh(reply ? { faces: reply[0], edges: reply[1] } : null);
	}

	async exportSTEP(): Promise<string> {
		await this.started();
		return (await this.bus?.request<string>("saveShapeSTEP", undefined, this.timeout)) ?? "";
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
		this.bus = null;
		this.alive = false;
		this.live = null;
	}

	/** Builds the worker, wires the bus, then chains our `onerror` after MessageBus's (MessageBus.js:32), which
	 *  only logs to the console and would otherwise swallow the one signal that the kernel is gone. */
	private spawn(): void {
		const worker = new Worker(this.opts.workerUrl, { type: "module" });
		const bus = new MessageBus(worker);
		this.worker = worker;
		this.bus = bus;
		this.alive = false;
		this.handshake = new Promise((resolve) => {
			bus.on("startupCallback", () => {
				this.alive = true;
				resolve();
			});
		});
		bus.on("log", (payload: unknown) => this.readLog(payload));
		const logged = worker.onerror;
		worker.onerror = (e: ErrorEvent) => {
			logged?.call(worker, e);
			this.readError(e);
		};
	}

	private recover(): void {
		this.dispose();
		void this.ready();
	}

	/** Handshakes need the same deadline as calls: a wasm load that never finishes must not hang a build. */
	private async started(): Promise<void> {
		const handshake = this.ready();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([handshake, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`kernel did not start within ${this.timeout}ms`)), this.timeout)))]);
		} finally {
			clearTimeout(timer);
		}
	}

	private readLog(payload: unknown): void {
		for (const line of String(payload).split("\n")) {
			if (!line.startsWith(PROBE_PREFIX) && !line.startsWith(ERROR_PREFIX)) {
				this.opts.onLog?.(line);
				continue;
			}
			if (line.startsWith(ERROR_PREFIX)) {
				// The kernel's own console.error, reported as it happens rather than rethrown one task late. First
				// error wins; a line arriving after settle() belongs to a build already reported and is dropped.
				if (this.live && this.live.error === null) this.live.error = line.slice(ERROR_PREFIX.length);
				continue;
			}
			const m = PROBE_LINE.exec(line);
			// A null reading cannot match, so an unmeasured probe is absent rather than zero. Lines from an
			// earlier build are dropped: they describe geometry that is no longer on screen.
			if (!m || !this.live || m[1] !== this.live.buildId) continue;
			const value = Number(m[4]);
			if (Number.isFinite(value)) this.live.probes[`${m[1]}|${m[2]}|${m[3]}`] = value;
		}
	}

	private readError(e: ErrorEvent): void {
		if (!this.live) {
			// A throw outside a build (the worker's late rethrow of one already reported, or a crash between
			// builds). settle() has already told the app about the first case, so this one only reaches the log.
			this.opts.onCrash?.(e);
			return;
		}
		if (this.live.error === null) {
			this.live.error = e.message;
			this.live.event = e;
		}
	}

	/** The one place that decides whether geometry reached the canvas: an error the kernel did not shrug off,
	 *  or an error it did but with nothing built at all, means the previous mesh stays. */
	private settle(buildId: string, mesh: Mesh, opsPerStep: Record<string, number>): BuildResult {
		const live = this.live;
		this.live = null;
		const error = live?.error ?? null;
		const shrugged = error !== null && SKIPPED_SHAPE.test(error);
		if (error !== null && (!shrugged || mesh.faceCount === 0)) {
			// The app learns about failures exactly once, whether the kernel reported through the patched
			// console.error or the worker actually threw.
			this.opts.onError(live?.event ?? workerError(error));
			// The mesh from a build that failed is never the one to show: a partial scene is what tricked the
			// kernel into complaining in the first place.
			return this.failed(buildId, error);
		}
		this.lastMesh = mesh;
		this.history = Object.entries(opsPerStep).map(([stepId, ops]) => ({ stepId, ops }));
		return { ok: true, mesh, buildId, probes: live?.probes ?? {} };
	}

	private failed(buildId: string, error: string): BuildResult {
		// The worker wipes modelHistory at the start of every evaluate, including a failing one. Keeping the
		// previous build's indexing would let preview() address the failed build's history and quietly return
		// another step's geometry; historyIndex throws now, which the caller shows as a failed preview.
		this.history = [];
		return { ok: false, mesh: this.lastMesh, buildId, error };
	}

	private historyIndex(stepId: string, opIndex: number): number {
		let index = 0;
		for (const step of this.history) {
			if (step.stepId === stepId) return index + opIndex;
			index += step.ops;
		}
		throw new Error(`step ${stepId} is not in the last good build`);
	}
}
