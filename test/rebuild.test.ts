// One build at a time, and never a queue. A document that changes while a build is running replaces what gets
// built next, so fast editing converges on the latest state instead of walking through every intermediate.
import { describe, expect, it } from "vitest";
import { Rebuilder } from "../src/kernel/rebuild.ts";
import type { BuildResult, KernelClient } from "../src/kernel/client.ts";
import { EMPTY_MESH } from "../src/kernel/decode.ts";
import type { CadDocument } from "../src/model/types.ts";

/** The kernel the rebuilder drives: records which documents it was asked to build, and resolves on a tick. */
type StubKernel = Pick<KernelClient, "build"> & { calls: CadDocument[]; builds: number };

function stubKernel(opts: { failFirst?: boolean } = {}): StubKernel {
	const calls: CadDocument[] = [];
	let builds = 0;
	const build = async (doc: CadDocument): Promise<BuildResult> => {
		calls.push(doc);
		const mine = ++builds;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (opts.failFirst && mine === 1) throw new Error("kernel exploded");
		return { ok: true, mesh: EMPTY_MESH, buildId: `b${mine}`, probes: {} };
	};
	return {
		build,
		calls,
		get builds() {
			return builds;
		},
	};
}

const doc = (name: string): CadDocument => ({ schema: 1, name, steps: [] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Rebuilder", () => {
	it("coalesces requests made in one turn into a single build of the newest document", async () => {
		const kernel = stubKernel();
		const rebuilder = new Rebuilder(kernel);
		const [first, second] = await Promise.all([rebuilder.request(doc("d1")), rebuilder.request(doc("d2"))]);
		expect(kernel.builds).toBe(1);
		expect(kernel.calls).toEqual([doc("d2")]);
		expect(first).toBe(second);
	});

	it("gives a request that lands mid-build its own build", async () => {
		const kernel = stubKernel();
		const rebuilder = new Rebuilder(kernel);
		const d1 = doc("d1");
		const d2 = doc("d2");
		const first = rebuilder.request(d1);
		await tick();
		const second = rebuilder.request(d2);
		expect(await first).toMatchObject({ buildId: "b1" });
		expect(await second).toMatchObject({ buildId: "b2" });
		expect(kernel.calls).toEqual([d1, d2]);
	});

	it("is busy only while a build is in flight", async () => {
		const kernel = stubKernel();
		const rebuilder = new Rebuilder(kernel);
		expect(rebuilder.busy()).toBe(false);
		const pending = rebuilder.request(doc("d1"));
		expect(rebuilder.busy()).toBe(true);
		await pending;
		expect(rebuilder.busy()).toBe(false);
	});

	it("carries a failed build to the caller and stays usable", async () => {
		const kernel = stubKernel({ failFirst: true });
		const rebuilder = new Rebuilder(kernel);
		await expect(rebuilder.request(doc("d1"))).rejects.toThrow("kernel exploded");
		expect(rebuilder.busy()).toBe(false);
		await expect(rebuilder.request(doc("d2"))).resolves.toMatchObject({ ok: true, buildId: "b2" });
	});

	it("keeps the mesh of the build it finished, when several requests were dropped", async () => {
		const kernel = stubKernel();
		const rebuilder = new Rebuilder(kernel);
		const waiting = rebuilder.request(doc("d1"));
		await tick();
		const results = await Promise.all([waiting, rebuilder.request(doc("d2")), rebuilder.request(doc("d3"))]);
		expect(kernel.calls.map((d) => d.name)).toEqual(["d1", "d3"]);
		expect(results[2]).toBe(results[1]);
	});
});
