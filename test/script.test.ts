import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertExtrude, newDocument, newId, replaceStep } from "../src/model/doc.ts";
import { serialize } from "../src/model/serialize.ts";
import type { CadDocument, Entity, PlaneRef, Sketch } from "../src/model/types.ts";
import type { Umm } from "../src/model/units.ts";
import { buildScript } from "../src/kernel/script.ts";

let uuid = 0;
beforeEach(() => {
	uuid = 0;
	vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
		return `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>;
	});
});
afterEach(() => vi.restoreAllMocks());

/** A closed 2D rectangle in plane µm: the extra point back to the start is how a stroke closes. */
const rect = (w: Umm, h: Umm): Entity[] => [
	{ kind: "poly", points: [[0, 0], [w, 0], [w, h], [0, h], [0, 0]] },
];
const axisSketch = (plane: PlaneRef, entities: Entity[] = rect(40_000, 30_000)): Sketch => ({
	id: newId("sketch"),
	plane,
	origin: [0, 0],
	axes: [
		[1_000_000, 0, 0],
		[0, 1_000_000, 0],
	],
	entities,
});
const XY: PlaneRef = { kind: "axis", axis: "XY", offset: 0 };

/** The document as it reads back from storage, which is what the builder is handed. */
function docWith(...steps: { sketch: Sketch; depth: Umm; cut?: boolean }[]): { doc: CadDocument; ids: string[] } {
	let doc = newDocument("t");
	const ids: string[] = [];
	for (const step of steps) {
		const added = insertExtrude(doc, null, step.sketch, step.depth, step.cut ?? false);
		doc = added.doc;
		ids.push(added.id);
	}
	return { doc: JSON.parse(serialize(doc)) as CadDocument, ids };
}

/** A line that calls a kernel operation, i.e. one entry in the worker's model history. */
const OP_LINE = /^\s*const \w+ = (Polygon|MakeFace|Extrude|Difference|Union)\(/;
const opLines = (code: string): number[] =>
	code.split("\n").flatMap((line, i) => (OP_LINE.test(line) ? [i] : []));

describe("script builder: geometry reaches the kernel as points", () => {
	it("emits a polygon wire, a face and an extrusion instead of a Sketch", () => {
		const { doc, ids } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Polygon([");
		expect(s.code).toContain("MakeFace(p1, false)");
		expect(s.code).toContain("Extrude(f1, [0,0,12], false)");
		expect(s.code).not.toContain("Sketch(");
		expect(s.opsPerStep[ids[0]]).toBe(3);
	});

	it("drops the closing repeat so the wire has no zero-length edge", () => {
		const { doc } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Polygon([[0,0,0],[40,0,0],[40,30,0],[0,30,0]], true)");
	});

	it("lifts sketch plane points into model millimetres", () => {
		const { doc } = docWith({
			sketch: axisSketch({ kind: "axis", axis: "XZ", offset: 5_000 }),
			depth: 12_000,
		});
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Polygon([[0,5,0],[40,5,0],[40,5,30],[0,5,30]], true)");
		expect(s.code).toContain("Extrude(f1, [0,-12,0], false)");
	});

	it("cuts with a Difference that consumes the body and the tool", () => {
		const { doc, ids } = docWith(
			{ sketch: axisSketch(XY), depth: 12_000 },
			{ sketch: axisSketch(XY, [{ kind: "circle", centre: [10_000, 10_000], radius: 3_000 }]), depth: 12_000, cut: true },
		);
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Difference(s1, [s2], [false, false], 1e-7, false)");
		expect(s.opsPerStep[ids[0]]).toBe(3);
		expect(s.opsPerStep[ids[1]]).toBe(4);
	});

	it("fuses a second additive step onto the body", () => {
		const { doc, ids } = docWith(
			{ sketch: axisSketch(XY), depth: 12_000 },
			{ sketch: axisSketch({ kind: "axis", axis: "XY", offset: 12_000 }), depth: 5_000 },
		);
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Union([s1,s2], false, 1e-7, false)");
		expect(s.opsPerStep[ids[1]]).toBe(4);
	});
});

describe("script builder: one line per history op", () => {
	it("makes the op count add up to the op lines", () => {
		const { doc } = docWith(
			{ sketch: axisSketch(XY), depth: 12_000 },
			{ sketch: axisSketch(XY, rect(5_000, 5_000)), depth: 12_000, cut: true },
			{ sketch: axisSketch({ kind: "axis", axis: "XY", offset: 12_000 }, rect(2_000, 2_000)), depth: 3_000 },
		);
		const s = buildScript(doc, { probes: [{ kind: "volume" }, { kind: "surface" }], buildId: "b1" });
		const total = Object.values(s.opsPerStep).reduce((a, b) => a + b, 0);
		expect(opLines(s.code)).toHaveLength(total);
		expect(total).toBe(11);
	});

	it("keeps each step's ops contiguous and in document order", () => {
		const { doc, ids } = docWith(
			{ sketch: axisSketch(XY), depth: 12_000 },
			{ sketch: axisSketch(XY, rect(5_000, 5_000)), depth: 12_000, cut: true },
			{ sketch: axisSketch({ kind: "axis", axis: "XY", offset: 12_000 }, rect(2_000, 2_000)), depth: 3_000 },
		);
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		const all = opLines(s.code);
		let at = 0;
		for (const id of ids) {
			const count = s.opsPerStep[id];
			const run = all.slice(at, at + count);
			expect(run, `step ${id}`).toHaveLength(count);
			expect(new Set(run).size, "no line serves two steps").toBe(run.length);
			expect(run.at(-1)! - run[0]! + 1, "the step's ops sit side by side").toBe(count);
			at += count;
		}
		expect(at, "every op line belongs to a step").toBe(all.length);
	});

	it("never nests one call inside another", () => {
		const { doc } = docWith(
			{ sketch: axisSketch(XY), depth: 12_000 },
			{ sketch: axisSketch(XY, rect(5_000, 5_000)), depth: 12_000, cut: true },
		);
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		for (const line of s.code.split("\n").filter((l: string) => OP_LINE.test(l))) {
			expect(line.match(/(Polygon|MakeFace|Extrude|Difference|Union)\(/g)?.length ?? 0, line).toBe(1);
		}
	});
});

describe("script builder: millimetre boundary", () => {
	it("prints whole millimetres without decimals and microns as decimals", () => {
		const thin = rect(40_000, 30_000)[0];
		const step: Entity = { kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 12], [0, 12]] };
		expect(thin.kind).toBe("poly");
		const { doc } = docWith({ sketch: axisSketch(XY, [step]), depth: 12_000 });
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("[40,0,0]");
		expect(s.code).toContain("[40,0.012,0]");
		expect(s.code).toContain("[0,0.012,0]");
		expect(s.code).toContain("Extrude(f1, [0,0,12], false)");
	});

	it("prints no number with more than six decimals or a trailing zero", () => {
		const sketch = axisSketch({ kind: "axis", axis: "YZ", offset: 12_345 }, [
			{ kind: "poly", points: [[0, 0], [333_333, 0], [333_333, 123_457], [0, 1_000_001]] },
		]);
		const { doc } = docWith({ sketch, depth: 12_001 });
		const s = buildScript(doc, { probes: [{ kind: "edgeLength" }], buildId: "b1" });
		const decimals = s.code.match(/-?\d*\.\d+/g) ?? [];
		expect(decimals.length).toBeGreaterThan(0);
		for (const literal of decimals) {
			expect(literal, s.code).toMatch(/^\d*\.\d*[1-9]$/);
			expect(literal.split(".")[1].length, literal).toBeLessThanOrEqual(6);
		}
	});
});

describe("script builder: probes tail", () => {
	it("asks for each probe through the guarded helper, adding no op", () => {
		const { doc, ids } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
		const s = buildScript(doc, {
			probes: [
				{ kind: "volume" },
				{ kind: "surface", target: { step: ids[0], role: "face", index: 2 } },
				{ kind: "edgeLength", target: { step: ids[0], role: "edge", index: 1 } },
			],
			buildId: "b1",
		});
		expect(s.code).toContain(`try { __b("b1", "${ids[0]}", "volume", s1 ? Volume(s1) : null); } catch {`);
		expect(s.code).toContain(`__b("b1", "${ids[0]}", "surface", s1 ? _faceArea(Faces(s1).faces()[2]) : null); } catch {`);
		expect(s.code).toContain(`__b("b1", "${ids[0]}", "edgeLength", s1 ? _edgeLength(Edges(s1).edges()[1]) : null); } catch {`);
		expect(opLines(s.code)).toHaveLength(3);
	});

	it("reports null for a probe whose step never built", () => {
		const { doc, ids } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
		const s = buildScript(doc, { probes: [{ kind: "volume", target: { step: "step-gone", role: "face", index: 0 } }], buildId: "b1" });
		expect(s.code).toContain(`__b("b1", "step-gone", "volume", null); } catch {`);
		expect(ids.length).toBe(1);
	});
});

	it("keeps only solids in the scene, so face_index stays unique", () => {
			// MakeFace and Extrude remove their input when the keep flag is falsy; leaving the profile wire and
			// the face in sceneShapes would compound them alongside the solid, and combineAndRenderShapes
			// restarts face_index numbering per scene shape — a duplicate coplanar face on every sketch plane.
			const { doc } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
			const s = buildScript(doc, { probes: [], buildId: "b1" });
			expect(s.code).toContain("MakeFace(p1, false)");
			expect(s.code).toContain("Extrude(f1, [0,0,12], false)");
		});

		it("emits no boolean call when a cut has nothing to cut from", () => {
			const { doc } = insertExtrude(newDocument("t"), null, axisSketch(XY, rect(5_000, 5_000)), 12_000, true);
			const s = buildScript(doc, { probes: [], buildId: "b1" });
			expect(s.code).not.toContain("Difference(");
			expect(s.code).toContain("= null; // nothing to cut from");
			expect(opLines(s.code)).toHaveLength(3);
			expect(s.opsPerStep[doc.steps[0].id]).toBe(3);
		});

		describe("script builder: steps that cannot build", () => {
	it("threads a face-anchored step as null and emits no op for it", () => {
		const base = insertExtrude(newDocument("t"), null, axisSketch(XY), 12_000, false);
		const added = insertExtrude(
			base.doc,
			null,
			axisSketch({ kind: "face", face: { step: base.id, role: "face", index: 1 } }),
			6_000,
			false,
		);
		const doc = JSON.parse(serialize(added.doc)) as CadDocument;
		const s = buildScript(doc, { probes: [{ kind: "volume", target: { step: added.id, role: "face", index: 0 } }], buildId: "b1" });
		expect(s.opsPerStep[added.id]).toBe(0);
		expect(s.code).toContain("const s2 = null;");
		expect(s.code).toContain(`__b("b1", "${added.id}", "volume", s2 ? Volume(s2) : null); } catch {`);
		expect(opLines(s.code)).toHaveLength(3);
	});

	it("cuts a later step from the last shape that built, not from the skipped one", () => {
		const base = insertExtrude(newDocument("t"), null, axisSketch(XY), 12_000, false);
		const skipped = insertExtrude(
			base.doc,
			null,
			axisSketch({ kind: "face", face: { step: base.id, role: "face", index: 1 } }),
			6_000,
			false,
		);
		const cut = insertExtrude(skipped.doc, null, axisSketch(XY, rect(5_000, 5_000)), 12_000, true);
		const doc = JSON.parse(serialize(cut.doc)) as CadDocument;
		const s = buildScript(doc, { probes: [], buildId: "b1" });
		expect(s.code).toContain("Difference(s1, [s3]");
		expect(s.opsPerStep[skipped.id]).toBe(0);
	});

	it("threads an unreadable step as null too", () => {
		const { doc, ids } = docWith({ sketch: axisSketch(XY), depth: 12_000 });
		const withUnknown = replaceStep(doc, ids[0], { id: ids[0], kind: "unknown", type: "revolve" });
		const s = buildScript(withUnknown, { probes: [], buildId: "b1" });
		expect(s.opsPerStep[ids[0]]).toBe(0);
		expect(s.code).toContain("const s1 = null;");
		expect(opLines(s.code)).toHaveLength(0);
	});
});
