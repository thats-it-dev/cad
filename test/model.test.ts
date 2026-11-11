import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	brokenSteps,
	insertExtrude,
	indexOfStep,
	newDocument,
	newId,
	normalize,
	removeStep,
	replaceStep,
	stepById,
} from "../src/model/doc.ts";
import { deserialize, serialize } from "../src/model/serialize.ts";
import { mm } from "../src/model/units.ts";
import type { CadDocument, Entity, PlaneRef, Sketch, Step } from "../src/model/types.ts";
import type { Umm } from "../src/model/units.ts";

let uuid = 0;
beforeEach(() => {
	uuid = 0;
	vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
		return `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>;
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const axisXY = (): PlaneRef => ({ kind: "axis", axis: "XY", offset: 0 });
const faceOn = (step: string): PlaneRef => ({ kind: "face", face: { step, role: "face", index: 1 } });
const rect = (w: Umm, h: Umm): Entity[] => [{ kind: "poly", points: [[0, 0], [w, 0], [w, h], [0, h], [0, 0]] }];
const sketch = (plane: PlaneRef, entities: Entity[]): Sketch => ({
	id: newId("sketch"),
	plane,
	origin: [0, 0],
	axes: [[1_000_000, 0, 0], [0, 1_000_000, 0]],
	entities,
});

/** The step narrowed to an extrude, so a wrong kind reads as an error rather than undefined fields. */
function extrude(doc: CadDocument, id: string) {
	const step = stepById(doc, id);
	if (step?.kind !== "extrude") throw new Error(`step ${id} is not an extrude: ${JSON.stringify(step)}`);
	return step;
}
const ids = (doc: CadDocument) => doc.steps.map((s) => s.id);

/** base ← cut ← pad: the third step is drawn on a face of the second, the second on a face of the first. */
function chain(): { doc: CadDocument; base: string; cut: string; pad: string } {
	const a = insertExtrude(newDocument("t"), null, sketch(axisXY(), rect(40_000, 30_000)), 12_000, false);
	const b = insertExtrude(a.doc, a.id, sketch(faceOn(a.id), rect(10_000, 10_000)), 5_000, true);
	const c = insertExtrude(b.doc, b.id, sketch(faceOn(b.id), rect(4_000, 4_000)), 2_000, false);
	return { doc: c.doc, base: a.id, cut: b.id, pad: c.id };
}

describe("newDocument", () => {
	it("starts empty with schema 1", () => {
		expect(newDocument("housing")).toEqual({ schema: 1, name: "housing", steps: [] });
	});
	it("names an unnamed document", () => {
		expect(newDocument().name).not.toBe("");
	});
});

describe("newId", () => {
	it("keeps the prefix in front of a uuid", () => {
		expect(newId("step")).toBe("step-00000000-0000-4000-8000-000000000001");
	});
	it("never repeats itself", () => {
		const seen = new Set([newId("step"), newId("step"), newId("sketch"), newId("sketch")]);
		expect(seen.size).toBe(4);
	});
});

describe("insertExtrude", () => {
	it("puts the new step right after the anchor", () => {
		const { doc, base, cut, pad } = chain();
		const { doc: grown, id } = insertExtrude(doc, base, sketch(axisXY(), rect(2_000, 2_000)), 1_000, false);
		expect(indexOfStep(grown, id)).toBe(indexOfStep(doc, base) + 1);
		expect(ids(grown)).toEqual([base, id, cut, pad]);
	});
	it("appends when there is no anchor, and when the anchor is gone", () => {
		const { doc, base, cut, pad } = chain();
		const appended = insertExtrude(doc, null, sketch(axisXY(), rect(1_000, 1_000)), 500, false);
		expect(ids(appended.doc)).toEqual([base, cut, pad, appended.id]);
		const orphan = insertExtrude(doc, "step-gone", sketch(axisXY(), rect(1_000, 1_000)), 500, false);
		expect(indexOfStep(orphan.doc, orphan.id)).toBe(doc.steps.length);
	});
	it("leaves the document it was given alone", () => {
		const { doc } = chain();
		const before = serialize(doc);
		insertExtrude(doc, null, sketch(axisXY(), rect(1_000, 1_000)), 500, true);
		replaceStep(doc, doc.steps[0].id, { id: doc.steps[0].id, kind: "unknown", type: "extrude" });
		expect(serialize(doc)).toBe(before);
	});
	it("stores the depth as µm, matching the millimetres the kernel is handed", () => {
		const { doc, base } = chain();
		expect(extrude(doc, base).depth).toBe(12_000);
		expect(mm(extrude(doc, base).depth)).toBe(12); // script.ts prints Extrude(f1, [0,0,12], …)
	});
	it("records whether a step adds or removes material", () => {
		const { doc, base, cut } = chain();
		expect(extrude(doc, base).cut).toBe(false);
		expect(extrude(doc, cut).cut).toBe(true);
		expect(extrude(doc, base).name).not.toBe("");
	});
});

describe("stepById and indexOfStep", () => {
	it("finds a step and reports where it is", () => {
		const { doc, cut } = chain();
		expect(stepById(doc, cut)?.id).toBe(cut);
		expect(indexOfStep(doc, cut)).toBe(1);
	});
	it("misses quietly", () => {
		const { doc } = chain();
		expect(stepById(doc, "nope")).toBeUndefined();
		expect(indexOfStep(doc, "nope")).toBe(-1);
	});
});

describe("replaceStep", () => {
	it("swaps one step and leaves the neighbours as they were", () => {
		const { doc, base, cut, pad } = chain();
		const shallower: Step = { ...extrude(doc, base), depth: 6_000 };
		const grown = replaceStep(doc, base, shallower);
		expect(extrude(grown, base).depth).toBe(6_000);
		expect(grown.steps[1]).toEqual(doc.steps[1]);
		expect(ids(grown)).toEqual([base, cut, pad]);
	});
	it("keeping the row's id, so a stale sketch id cannot strand the dependents", () => {
		const { doc, base, cut } = chain();
		const renamed = replaceStep(doc, base, { ...extrude(doc, base), id: "someone-else" });
		expect(indexOfStep(renamed, base)).toBe(0);
		expect(brokenSteps(renamed)).toEqual([]);
		expect(extrude(renamed, cut).sketch.plane).toEqual(faceOn(base));
	});
	it("applying the same replacement twice is the same as once", () => {
		const { doc } = chain();
		const once = replaceStep(doc, doc.steps[0].id, { ...extrude(doc, doc.steps[0].id), depth: 9_000 });
		const twice = replaceStep(once, doc.steps[0].id, { ...extrude(once, doc.steps[0].id), depth: 9_000 });
		expect(serialize(twice)).toBe(serialize(once));
	});
	it("ignores a replacement for an id that is not there", () => {
		const { doc } = chain();
		expect(serialize(replaceStep(doc, "nope", { id: "nope", kind: "unknown", type: "flux" }))).toBe(serialize(doc));
	});
});

describe("removeStep", () => {
	it("drops only that step", () => {
		const { doc, base, cut, pad } = chain();
		expect(ids(removeStep(doc, cut))).toEqual([base, pad]);
	});
	it("keeps a step drawn on a removed face and marks it broken", () => {
		const { doc, base, cut } = chain();
		const gone = removeStep(doc, base);
		expect(stepById(gone, cut)).toBeDefined();
		expect(extrude(gone, cut).sketch.plane).toEqual(faceOn(base));
		expect(brokenSteps(gone)).toEqual([{ id: cut, reason: "parent removed" }]);
	});
	it("removing twice removes nothing more", () => {
		const { doc, base } = chain();
		expect(serialize(removeStep(removeStep(doc, base), base))).toBe(serialize(removeStep(doc, base)));
	});
});

describe("brokenSteps", () => {
	it("is empty for a chain where every parent is present", () => {
		expect(brokenSteps(chain().doc)).toEqual([]);
	});
	it("reports an unknown step kind with its type, not with prose", () => {
		const doc: CadDocument = { schema: 1, name: "x", steps: [{ id: "s1", kind: "unknown", type: "flux" }] };
		expect(brokenSteps(doc)).toEqual([{ id: "s1", reason: "unknown kind", type: "flux" }]);
	});
	it("lists every problem once, in document order", () => {
		const { doc, base, cut } = chain();
		const mixed: CadDocument = {
			...removeStep(doc, base),
			steps: [{ id: "old", kind: "unknown", type: "loft" }, ...removeStep(doc, base).steps],
		};
		expect(brokenSteps(mixed)).toEqual([
			{ id: "old", reason: "unknown kind", type: "loft" },
			{ id: cut, reason: "parent removed" },
		]);
		expect(brokenSteps(doc).length).toBe(0);
		expect(extrude(doc, cut).sketch.plane).toEqual(faceOn(base));
	});
});

describe("normalize", () => {
	it("carries an unknown step from a later version, and everything it held", () => {
		const { doc, problems } = normalize({ schema: 1, steps: [{ id: "s1", kind: "flux", watts: 5 }] });
		expect(problems).toEqual(["step s1: unknown kind flux"]);
		expect(doc.steps[0]).toMatchObject({ id: "s1", kind: "unknown", type: "flux" });
		expect(serialize(doc)).toContain('"watts":5');
	});
	it("accepts JSON text as well as a parsed object", () => {
		const doc = chain().doc;
		expect(serialize(normalize(serialize(doc)).doc)).toBe(serialize(doc));
		const broken = normalize("{not json").doc;
		expect(broken.schema).toBe(1);
		expect(broken.steps).toEqual([]);
		expect(broken.name).not.toBe("");
		expect(normalize("{not json").problems).toEqual(["document: not valid JSON"]);
		expect(normalize(null).problems).toContain("document: not an object");
	});
	it("reports nothing about a document this app wrote", () => {
		expect(normalize(chain().doc).problems).toEqual([]);
	});
	it("repairs the same document twice without doubling", () => {
		const future = { schema: 1, name: "x", steps: [{ id: "s1", kind: "flux", watts: 5 }, { id: "s2" }] };
		const once = normalize(future);
		const twice = normalize(once.doc);
		expect(serialize(twice.doc)).toBe(serialize(once.doc));
		expect(once.problems).toEqual(["step s1: unknown kind flux", "step s2: missing kind"]);
		expect(twice.problems).toEqual([]);
	});
	it("keeps a document's own name and ids, and mints a missing step id", () => {
		const { doc, problems } = normalize({ schema: 1, name: "housing", steps: [{ kind: "unknown", type: "flux" }] });
		expect(doc.name).toBe("housing");
		expect(doc.steps[0].id).toBe("step-00000000-0000-4000-8000-000000000001");
		expect(problems).toEqual(["step 0: missing id"]);
	});
	it("flags a schema it cannot read and a steps list that is not one", () => {
		expect(normalize({ schema: 2, name: "x", steps: [] }).problems).toEqual(["document: schema 2 is not 1"]);
		expect(normalize({ schema: 1, name: "x" }).problems).toEqual(["document: steps is not an array"]);
	});
	it("demotes an extrude whose geometry it cannot trust instead of guessing", () => {
		const { doc, base } = chain();
		const bad = [
			{ ...extrude(doc, base), depth: "12" },
			{ ...extrude(doc, base), cut: "no" },
			{ ...extrude(doc, base), sketch: { ...extrude(doc, base).sketch, entities: [{ kind: "arc" }] } },
			{ ...extrude(doc, base), sketch: { ...extrude(doc, base).sketch, plane: { kind: "axis", axis: "YX", offset: 0 } } },
			{ ...extrude(doc, base), sketch: 7 },
		];
		for (const step of bad) {
			const fixed = normalize({ ...doc, steps: [step] });
			expect(fixed.problems, JSON.stringify(step)).toEqual([`step ${base}: invalid extrude step`]);
			expect(fixed.doc.steps[0]).toMatchObject({ id: base, kind: "unknown", type: "extrude" });
			expect(brokenSteps(fixed.doc)).toEqual([{ id: base, reason: "unknown kind", type: "extrude" }]);
		}
	});
	it("rounds a float distance on the way in, so no float reaches the document", () => {
		const { doc, base } = chain();
		expect(normalize(doc).problems).toEqual([]);
		const step = extrude(doc, base);
		const fixed = normalize({
			...doc,
			steps: [{ ...step, depth: 12_000.4, sketch: { ...step.sketch, origin: [0.6, 0] } }],
		});
		expect(fixed.problems).toEqual([`step ${base}: 2 distances rounded to µm`]);
		expect(fixed.doc.steps[0]).toMatchObject({ depth: 12_000, sketch: { origin: [1, 0] } });
	});
	it("reads an axis plane with no offset as the plane through the origin", () => {
		const { doc, base } = chain();
		const bare = normalize({
			...doc,
			steps: [{ ...extrude(doc, base), sketch: { ...extrude(doc, base).sketch, plane: { kind: "axis", axis: "XY" } } }],
		});
		expect(bare.problems).toEqual([]);
		expect(bare.doc.steps[0]).toMatchObject({ sketch: { plane: { kind: "axis", axis: "XY", offset: 0 } } });
	});
});

describe("serialize and deserialize", () => {
	it("reads back exactly what it wrote", () => {
		const { doc } = chain();
		expect(deserialize(serialize(doc))).toEqual(doc);
	});
	it("keeps µm integers exact through a save and a load", () => {
		const { doc, base, cut } = chain();
		const reloaded = deserialize(serialize(doc));
		expect(extrude(reloaded, base).depth).toBe(12_000);
		expect(extrude(reloaded, cut).sketch.entities[0]).toEqual({
			kind: "poly",
			points: [[0, 0], [10_000, 0], [10_000, 10_000], [0, 10_000], [0, 0]],
		});
	});
});
