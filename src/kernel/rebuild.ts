// The rebuild pipeline: one build in flight, and a document that changes mid-build replaces what gets built
// next instead of queueing behind it. Editing five sketch points in a row must cost one rebuild, not five, and
// the mesh on screen has to end up matching the document as it stands now.
import type { BuildResult, KernelClient } from "./client.ts";
import type { CadDocument } from "../model/types.ts";

export type Kernel = Pick<KernelClient, "build">;

/** The requests this turn produced, in the order they arrived. */
type Waiter = { resolve: (r: BuildResult) => void; reject: (e: unknown) => void };

export class Rebuilder {
	private readonly kernel: Kernel;
	/** The newest document asked for, or null once it has been handed to a build. */
	private pending: CadDocument | null = null;
	private waiters: Waiter[] = [];
	private running = false;

	constructor(kernel: Kernel) {
		this.kernel = kernel;
	}

	busy(): boolean {
		return this.running;
	}

	/** Asks for `doc` to be on screen. Resolves with the build that covered it, which may be the one already
	 *  running, or a later one that replaced it. */
	request(doc: CadDocument): Promise<BuildResult> {
		this.pending = doc;
		return new Promise<BuildResult>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
			if (!this.running) void this.loop();
		});
	}

	private async loop(): Promise<void> {
		this.running = true;
		// One microtask of grace up front: the other requests made in this turn arrive first, so only the newest
		// document is worth building. Anyone landing during a build is already held in `pending` and gets the
		// next one, which is the only build that saw their document.
		await Promise.resolve();
		while (this.pending !== null) {
			const doc = this.pending;
			this.pending = null;
			const waiting = this.waiters.splice(0);
			let result: BuildResult;
			try {
				result = await this.kernel.build(doc);
			} catch (e) {
				for (const w of [...waiting, ...this.waiters.splice(0)]) w.reject(e);
				break;
			}
			for (const w of waiting) w.resolve(result);
		}
		this.running = false;
	}
}
