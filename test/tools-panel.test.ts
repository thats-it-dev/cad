// Task 10's rules, checked in Node, where a document is just data. `<cad-tools>` itself belongs to the browser
// (e2e/tools.spec.ts): vitest here has no DOM, so what this file can prove is the state the panel renders from,
// and the one rule a UI test cannot see — that a press with nothing pending never reaches the document.
//
// DocState is the only door through which the model changes. That is the whole reason it exists: before it,
// app-main held `doc` as a field and each panel kept its own idea of what was on screen, so a failed build left
// the history row and the canvas describing different documents.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocState, commitPending, type Pending } from "../src/app/doc-state.ts";
import { toolsFor, VIEWS, type ToolsState } from "../src/app/tools-model.ts";
import { insertExtrude, newDocument, newId, removeStep } from "../src/model/doc.ts";
import type { CadDocument, Entity, PlaneRef, Sketch, Step } from "../src/model/types.ts";
import type { Umm } from "../src/model/units.ts";

let uuid = 0;
beforeEach(() => {
	uuid = 0;
	vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
		return `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>;
	});
});
afterEach(() => vi.restoreAllMocks());

const XY = (): PlaneRef => ({ kind: "axis", axis: "XY", offset: 0 });
const faceOn = (step: string): PlaneRef => ({ kind: "face", face: { step, role: "face", index: 1 } });
const AXES: Pending["axes"] = [
	[1_000_000, 0, 0],
	[0, 1_000_000, 0],
];

/** A 40 × 30 mm rectangle, in the µm a committed sketch stores. */
const RING: Entity[] = [{ kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 0]] }];

const pending = (entities: Entity[] = RING): Pending => ({ plane: XY(), origin: [0, 0], axes: AXES, entities });

const sketchOf = (plane: PlaneRef, entities: Entity[]): Sketch => ({ id: newId("sketch"), plane, origin: [0, 0], axes: AXES, entities });

/** One box, made the way the app would make it. */
function oneBox(): CadDocument {
	return insertExtrude(newDocument(), null, sketchOf(XY(), RING), 12_000, false).doc;
}

function extrude(doc: CadDocument, at: number): Step & { kind: "extrude" } {
	const step = doc.steps[at];
	if (step?.kind !== "extrude") throw new Error(`step ${at} is not an extrude: ${JSON.stringify(step)}`);
	return step;
}

describe("DocState", () => {
	it("starts with an empty document, nothing pending, nothing selected, nothing broken", () => {
		const state = new DocState();
		expect(state.doc.steps).toEqual([]);
		expect(state.doc.name, "a fresh document is named by the model, not by the app").toBe("Untitled");
		expect(state.pending).toBeNull();
		expect(state.selection).toBeNull();
		expect(state.broken).toEqual([]);
	});

	it("fires change once per apply, carrying the new document", () => {
		const state = new DocState();
		const seen: CadDocument[] = [];
		state.addEventListener("change", (e) => seen.push((e as CustomEvent<CadDocument>).detail));
		state.apply(() => oneBox());
		expect(seen, "one event per apply, not one per field that moved").toHaveLength(1);
		expect(seen[0]?.steps).toHaveLength(1);
	});

	it("says nothing when a mutator returns the document it was given", () => {
		const state = new DocState();
		const changed = vi.fn();
		state.addEventListener("change", changed);
		state.apply((doc) => doc);
		expect(changed, "a no-op edit must not start a rebuild").not.toHaveBeenCalled();
	});

	it("keeps two applies in a row, so no edit is lost to the last writer", () => {
		const state = new DocState();
		state.apply((doc) => insertExtrude(doc, null, sketchOf(XY(), RING), 12_000, false).doc);
		state.apply((doc) => insertExtrude(doc, null, sketchOf(XY(), RING), 5_000, true).doc);
		expect(state.doc.steps.map((s) => s.kind), "both landed").toEqual(["extrude", "extrude"]);
		expect(extrude(state.doc, 1).cut, "the second was a cut").toBe(true);
	});

	it("recomputes broken from the document, rather than letting a panel cache it", () => {
		const base = oneBox();
		const parentId = extrude(base, 0).id;
		const withChild = insertExtrude(base, null, sketchOf(faceOn(parentId), RING), 4_000, false).doc;
		const state = new DocState(withChild);
		expect(state.broken, "a face sketch on a step that exists is fine").toEqual([]);
		state.apply((doc) => removeStep(doc, parentId));
		expect(state.broken, "remove the parent and the dependent reports itself broken").toHaveLength(1);
		expect(state.broken[0]?.reason).toBe("parent removed");
	});

	it("holds the pending sketch as state", () => {
		const state = new DocState();
		state.setPending(pending());
		expect(state.pending?.entities).toHaveLength(1);
		state.setPending(null);
		expect(state.pending, "discarded").toBeNull();
	});

	it("tracks the selection separately from the document, so selecting does not rebuild", () => {
		const state = new DocState(oneBox());
		const changed = vi.fn();
		state.addEventListener("change", changed);
		const id = extrude(state.doc, 0).id;
		state.select({ kind: "step", id });
		expect(state.selection).toEqual({ kind: "step", id });
		expect(changed, "a selection is not an edit").not.toHaveBeenCalled();
	});
});

describe("committing what is pending", () => {
	it("makes one step from the pending sketch", () => {
		const state = new DocState(oneBox());
		state.setPending(pending());
		expect(commitPending(state, { depth: 12_000, cut: false })).toBe(true);
		expect(state.doc.steps).toHaveLength(2);
		expect(extrude(state.doc, 1).name, "a step is named by what it does").toBe("Extrude");
		expect(extrude(state.doc, 1).depth).toBe(12_000);
		expect(state.pending, "the ink is in the model now, so it stops being ink").toBeNull();
	});

	it("names a cut for what it is", () => {
		const state = new DocState(oneBox());
		state.setPending(pending());
		commitPending(state, { depth: 12_000, cut: true });
		expect(extrude(state.doc, 1)).toMatchObject({ name: "Cut", cut: true });
	});

	it("refuses a second press, which is the double-commit bug", () => {
		const state = new DocState(oneBox());
		state.setPending(pending());
		commitPending(state, { depth: 12_000, cut: true });
		expect(commitPending(state, { depth: 12_000, cut: true }), "nothing is pending the second time").toBe(false);
		expect(state.doc.steps, "Cut pressed twice in one session is one step").toHaveLength(2);
	});

	it("refuses a depth that builds nothing, and keeps the drawing for a retry", () => {
		const state = new DocState(oneBox());
		state.setPending(pending());
		for (const depth of [0, -12_000, Number.NaN, 1.5]) {
			expect(() => commitPending(state, { depth: depth as Umm, cut: false }), `${depth} is not a depth`).toThrow(/depth/i);
		}
		expect(state.pending?.entities, "the expensive thing survives the cheap mistake").toHaveLength(1);
		expect(state.doc.steps).toHaveLength(1);
	});

	it("refuses an empty pending sketch instead of making a step of nothing", () => {
		const state = new DocState();
		state.setPending(pending([]));
		expect(commitPending(state, { depth: 12_000, cut: false })).toBe(false);
		expect(state.doc.steps).toHaveLength(0);
	});

	it("clears the pending sketch before the document changes, so a listener cannot double-commit", () => {
		// The old order cleared pending *after* `apply`, so anything the listener does — start a kernel worker,
		// fail to, take a screenshot for the crash log — ran with "built" and "still drawn" both true, and the
		// next press added a second step for one gesture. A DOM EventTarget reports a throwing listener instead
		// of rethrowing into commitPending, so the order is what this asserts, not an exception.
		const state = new DocState();
		const observed: [number, boolean][] = [];
		state.addEventListener("change", (event) => {
			observed.push([(event as CustomEvent<CadDocument>).detail.steps.length, state.pending !== null]);
		});
		state.setPending(pending());
		expect(commitPending(state, { depth: 12_000, cut: false })).toBe(true);
		expect(observed, "the listener saw the step, and no ring").toEqual([[1, false]]);
		expect(state.doc.steps).toHaveLength(1);
		expect(state.pending).toBeNull();
		expect(commitPending(state, { depth: 12_000, cut: false }), "a second press is refused").toBe(false);
		expect(state.doc.steps, "still one step").toHaveLength(1);
	});
});

describe("what the panel shows", () => {
	const base: ToolsState = { mode: "sketch", pending: null, selection: null, steps: 0, busy: false };
	const ids = (state: ToolsState) => toolsFor(state).map((t) => t.id);

	it("offers depth, Extrude and Cut only when a sketch is pending", () => {
		expect(ids(base), "nothing drawn: no shape to build").not.toContain("extrude");
		expect(ids(base)).not.toContain("cut");
		expect(toolsFor(base).some((t) => t.kind === "depth"), "and no depth box").toBe(false);

		const ready = toolsFor({ ...base, pending: pending() });
		expect(ready.find((t) => t.id === "extrude"), "one press from a solid").toMatchObject({ enabled: true });
		expect(ready.find((t) => t.id === "cut"), "one press from a hole").toMatchObject({ enabled: true });
		expect(ready.some((t) => t.kind === "depth"), "the depth is typed here, not floating on the canvas").toBe(true);
	});

	it("keeps the mode and view buttons available with nothing pending, because they always work", () => {
		expect(ids(base)).toEqual(expect.arrayContaining(["sketch", "select", "front", "top", "right", "iso", "fit"]));
	});

	it("disables every mutation while a build is in flight", () => {
		const busy = toolsFor({ ...base, pending: pending(), busy: true });
		const mutating = busy.filter((t) => t.mutates);
		expect(mutating.length, "there is something to disable").toBeGreaterThan(0);
		for (const t of mutating) expect(t.enabled, `${t.id} while busy`).toBe(false);
		for (const t of busy.filter((x) => !x.mutates)) expect(t.enabled, `${t.id} is a view, not an edit`).toBe(true);
	});

	it("marks the mode the app is in", () => {
		const select = toolsFor({ ...base, mode: "select" });
		expect(select.find((t) => t.id === "select")).toMatchObject({ pressed: true });
		expect(select.find((t) => t.id === "sketch")).toMatchObject({ pressed: false });
	});

	it("offers delete only when there is a step, and enables it only when one is picked", () => {
		expect(ids(base), "no steps, no delete").not.toContain("delete");
		const unpicked = toolsFor({ ...base, steps: 1 });
		expect(unpicked.find((t) => t.id === "delete")).toMatchObject({ enabled: false });
		expect(toolsFor({ ...base, steps: 1, selection: { kind: "step", id: "s1" } }).find((t) => t.id === "delete")).toMatchObject({ enabled: true });
	});
});

describe("the four views", () => {
	it("are a quarter turn apart, and isometric is the one the viewer opens on", () => {
		expect(VIEWS.front.theta).toBe(0);
		expect(VIEWS.right.theta - VIEWS.front.theta, "front to right is 90 deg").toBeCloseTo(Math.PI / 2, 10);
		expect(VIEWS.iso.theta).toBeCloseTo(Math.PI / 4, 10);
		expect(VIEWS.iso.phi, "the isometric tilt, from scene.ts's home camera").toBeCloseTo(Math.acos(1 / Math.sqrt(3)), 10);
	});

	it("keeps top off the pole, where a Z-up camera's screen-right degenerates", () => {
		// phi = 0 puts the eye on +Z, parallel to camera.up: cross(up, eye) is the zero vector, and
		// normalize() of that is NaN, which would show up as a sketch plane nothing can be drawn on.
		expect(VIEWS.top.phi, "a hair off the pole, the way three.js' own controls clamp it").toBeGreaterThan(0);
		expect(Math.sin(VIEWS.top.phi) * Math.cos(VIEWS.top.theta), "and far enough out that the basis is finite").toBeGreaterThan(0);
	});
});
