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

/** What `combineAndRenderShapes` replies with: the raw `[ [faces, edges], sceneOptions ]` pair. */
type CombineReply = [[RawFace[], RawEdge[]], Record<string, unknown>] | null | undefined;

/** A shape the kernel skipped, which is expected while a face-anchored step exists (Task 12). Not a failure. */
const SKIPPED_SHAPE = /Null Shape detected in sceneShapes|Non-Shape detected in sceneShapes/i;
const PROBE_PREFIX = "__PROBE__";
const PROBE_LINE = /^__PROBE__([^|]+)\|([^|]+)\|([^|]+)\|(-?[\d.e+]+)$/;

/** `buildScript` emits `try { __b(buildId, stepId, kind, value) } catch {}` lines and never defines `__b`, so
 *  the definition is threaded in here. Its `try` means a host without it cannot fail the build either. */
const PROBE_PREAMBLE =
	`const __b = (buildId, stepId, kind, value) => console.log("${PROBE_PREFIX}" + buildId + "|" + stepId + "|" + kind + "|" + value);\n`;

/** What the worker is doing right now: probes land on the log stream, not on a reply. */
type Live = { buildId: string; probes: Record<string, number>; error: string | null; event: ErrorEvent | null };

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
			// The kernel rethrows its own console.error one task late (CascadeWorker's console override), so
			// the reply can arrive before the failure it belongs to.
			await nextTask();
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
			if (!line.startsWith(PROBE_PREFIX)) {
				this.opts.onLog?.(line);
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
			this.opts.onError(e);
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
			if (live?.event) this.opts.onError(live.event);
			// The mesh from a build that failed is never the one to show: a partial scene is what tricked the
			// kernel into complaining in the first place.
			return this.failed(buildId, error);
		}
		this.lastMesh = mesh;
		this.history = Object.entries(opsPerStep).map(([stepId, ops]) => ({ stepId, ops }));
		return { ok: true, mesh, buildId, probes: live?.probes ?? {} };
	}

	private failed(buildId: string, error: string): BuildResult {
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
