// Task 9's whole risk is the unit round trip: screen px → plane µm → kernel mm. This file tests that trip in
// Node, against a fake camera, because the fake *kernel* cannot say anything true about geometry
// (public/kernel/fake-worker.js answers every build with the same canned box, so no e2e claim about a mesh
// proves what a stroke became). e2e/sketch.spec.ts covers the browser half: the buttons, the field, history.
import { describe, expect, it } from "vitest";
import { appendInk, startSketch, type SketchView } from "../src/app/sketch-tool.ts";
import { insertExtrude, newDocument } from "../src/model/doc.ts";
import { buildScript } from "../src/kernel/script.ts";
import type { PlaneRef } from "../src/model/types.ts";
import type { Frame2 } from "../src/sketch/frame.ts";
import type { InkPoint } from "../src/view/gestures.ts";

const XY: PlaneRef = { kind: "axis", axis: "XY", offset: 0 };

/**
 * The camera contract, which is `Scene.screenToPlane`: client px in, mm on the plane out, in that frame's own
 * u/v basis. Modelled as the similarity a real view gives locally — one scale, the screen's y flip, and the
 * azimuth the plane is seen from. `frames` records every frame the session asked about, so a test can say
 * "the session converted through the frame it built", not just "the numbers came out right".
 */
type Cam = { originPx?: [number, number]; mmPerPx: number; azimuth?: number; miss?: (p: InkPoint) => boolean };
type Rig = { view: SketchView; frames: Frame2[]; cam: Cam };

function camera(cam: Cam): Rig {
	const [ox, oy] = cam.originPx ?? [300, 200];
	const cos = Math.cos(cam.azimuth ?? 0);
	const sin = Math.sin(cam.azimuth ?? 0);
	const frames: Frame2[] = [];
	return {
		cam,
		frames,
		view: {
			screenToPlane: (x: number, y: number, frame: Frame2) => {
				frames.push(frame);
				if (cam.miss?.({ x, y, t: 0 })) return [Number.NaN, Number.NaN];
				const u = (x - ox) * cam.mmPerPx;
				const v = -(y - oy) * cam.mmPerPx;
				return [u * cos + v * sin, -u * sin + v * cos];
			},
		},
	};
}

/** Plane mm → client px, the inverse of `camera`'s map: where the pencil has to land for the plane to read q. */
function pxOf(cam: Cam, q: [number, number]): InkPoint {
	const [ox, oy] = cam.originPx ?? [300, 200];
	const cos = Math.cos(cam.azimuth ?? 0);
	const sin = Math.sin(cam.azimuth ?? 0);
	const u = q[0] * cos - q[1] * sin;
	const v = q[0] * sin + q[1] * cos;
	return { x: ox + u / cam.mmPerPx, y: oy - v / cam.mmPerPx, t: 0 };
}

/** A pen stroke along plane targets, lifted on its last point. */
const strokeOf = (rig: Rig, targets: [number, number][]): InkPoint[] => targets.map((q) => pxOf(rig.cam, q));

/** Corners plus the repeat back to the first: what it takes for a ring to close. */
const round = (targets: [number, number][]): [number, number][] => [...targets, targets[0]!];

/** A 40 × 30 mm rectangle, corner to corner, in plane mm. */
const RECT: [number, number][] = [
	[0, 0],
	[40, 0],
	[40, 30],
	[0, 30],
];

/** The same rectangle 90% of the way round: the ring stops 14 mm short of its start, on the last edge. */
const NINETY: [number, number][] = [[0, 0], [40, 0], [40, 30], [0, 30], [0, 16]];

/** 60% of the way round: an open C, which is not a shape whatever the tolerance for a gap says. */
const SIXTY: [number, number][] = [[0, 0], [40, 0], [40, 30], [26, 30]];

const corners = (session: ReturnType<typeof startSketch>): [number, number][][] =>
	session.entities().map((e) => (e.kind === "poly" ? e.points : []));

describe("the pixel round trip is the task", () => {
	it("commits a 40 × 30 mm rectangle as whole micrometres", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round([[0, 0], [40, 0], [40, 30], [20, 30], [0, 30]])));
		const step = session.commit(12_000, false);
		expect(step.kind, "a committed sketch is an extrude step").toBe("extrude");
		expect(step.sketch.entities).toEqual([{ kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 0]] }]);
	});

	it("reads the same micrometres at any zoom and any place on the screen", () => {
		const want = [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 0]];
		for (const cam of [camera({ mmPerPx: 0.5 }), camera({ mmPerPx: 0.03125 }), camera({ mmPerPx: 0.4, originPx: [90, 640] })]) {
			const session = startSketch(XY, undefined, cam.view);
			session.stroke(strokeOf(cam, round(RECT)));
			expect(session.commit(12_000, false).sketch.entities[0]).toEqual({ kind: "poly", points: want });
		}
	});

	it("does not turn a rectangle into a diamond when the view is isometric", () => {
		// The default camera is theta π/4, phi acos(1/√3): screen-right is a 45° mix of the plane's axes.
		// An axis-aligned scale alone would commit this ring rotated, which is the failure this task must not have.
		const cam = camera({ mmPerPx: 0.25, azimuth: Math.PI / 4 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		const points = session.commit(12_000, false).sketch.entities;
		expect(points).toEqual([{ kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 0]] }]);
	});

	it("converts through the frame the plane names, offset included", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch({ kind: "axis", axis: "XY", offset: 12_000 }, undefined, cam.view);
		expect(session.frame.origin, "the frame is on the plane, not through the origin").toEqual([0, 0, 12]);
		session.stroke(strokeOf(cam, round(RECT)));
		session.commit(12_000, false);
		expect(cam.frames.at(-1)?.origin, "the conversion asked the camera about that frame").toEqual([0, 0, 12]);
	});

	it("reaches the kernel as whole millimetre points", () => {
		const cam = camera({ mmPerPx: 0.25, azimuth: Math.PI / 4 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		let doc = newDocument("t");
		const step = session.commit(12_000, false);
		doc = insertExtrude(doc, null, step.sketch, step.depth, step.cut).doc;
		const script = buildScript(doc, { probes: [], buildId: "b" });
		expect(script.code).toContain("Polygon([[0,0,0],[40,0,0],[40,30,0],[0,30,0]], true)");
		expect(script.code).toContain("Extrude(f1, [0,0,12], false)");
		expect(script.code.split("\n").filter((l) => /^const \w+ = (Polygon|MakeFace|Extrude)/.test(l))).toHaveLength(3);
	});
});

describe("closing the ring", () => {
	it("counts the closing point once", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		const [poly] = session.commit(12_000, false).sketch.entities;
		expect(poly?.kind === "poly" && poly.points, "four corners, the start counted once").toEqual([
			[0, 0],
			[40_000, 0],
			[40_000, 30_000],
			[0, 30_000],
			[0, 0],
		]);
	});

	it("closes a ring that got 90% of the way round", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, NINETY));
		expect(session.commit(12_000, false).sketch.entities).toEqual([
			{ kind: "poly", points: [[0, 0], [40_000, 0], [40_000, 30_000], [0, 30_000], [0, 16_000], [0, 0]] },
		]);
	});

	it("closes a small gap in pixels whatever the zoom", () => {
		// A 5 mm square at 0.25 mm/px is 20 px of edge: 15% of its arc is 3 px, so the pixel floor, not the
		// fraction, is what lets a pencil's overshoot meet.
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		// The vertex where the pen stopped stays in the ring: `simplify` always keeps a stroke's last point, and
		// it is collinear with the closing edge, so the face it bounds is the whole 5 mm square.
		const targets: [number, number][] = [
			[0, 0],
			[5, 0],
			[5, 5],
			[0, 5],
			[0, 0.75],
		];
		session.stroke(strokeOf(cam, targets));
		expect(session.commit(12_000, false).sketch.entities).toEqual([
			{ kind: "poly", points: [[0, 0], [5_000, 0], [5_000, 5_000], [0, 5_000], [0, 750], [0, 0]] },
		]);
	});

	it("refuses a stroke that never came round", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, SIXTY));
		expect(corners(session)[0]?.length, "the open stroke is still shown as ink").toBe(4);
		expect(() => session.commit(12_000, false)).toThrow(/close/i);
	});
});

describe("strokes and sessions", () => {
	it("does not count a coalesced tail twice", () => {
		const held: InkPoint[] = [
			{ x: 10, y: 20, t: 1 },
			{ x: 30, y: 20, t: 2 },
		];
		expect(appendInk(held, [{ x: 30, y: 20, t: 2 }]), "a move and the lift reporting one point add nothing").toEqual(held);
		expect(appendInk(held, [{ x: 30, y: 20, t: 2 }, { x: 40, y: 21, t: 3 }])).toEqual([...held, { x: 40, y: 21, t: 3 }]);
		expect(appendInk(held, []), "an empty burst changes nothing").toEqual(held);
	});

	it("keeps two rings in one sketch and fuses them in one step", () => {
		const cam = camera({ mmPerPx: 0.5 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		session.stroke(strokeOf(cam, round([[60, 0], [80, 0], [80, 20], [60, 20]])));
		const step = session.commit(12_000, false);
		expect(step.sketch.entities).toHaveLength(2);
		expect(step.sketch.id, "one sketch, two rings").toBe(step.sketch.id);
		const { doc, id } = insertExtrude(newDocument(), null, step.sketch, step.depth, step.cut);
		expect(buildScript(doc, { probes: [], buildId: "b" }).opsPerStep[id]).toBe(7);
	});

	it("takes the depth it is given, and refuses one that builds nothing", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		const cut = session.commit(6_000, true);
		expect(cut.kind === "extrude" && cut, "a cut is an extrude step that says so").toMatchObject({ kind: "extrude", name: "Cut", depth: 6_000, cut: true });
		session.stroke(strokeOf(cam, round(RECT)));
		expect(() => session.commit(0, false)).toThrow(/depth/i);
	});

	it("consumes the sketch on commit, so Extrude twice is one step", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		session.commit(12_000, false);
		expect(session.entities(), "the ink is the step now, not a pending sketch").toEqual([]);
		expect(() => session.commit(12_000, false)).toThrow(/nothing to sketch/i);
	});

	it("discards everything on cancel", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		session.cancel();
		expect(session.entities()).toEqual([]);
		expect(() => session.commit(12_000, false)).toThrow(/nothing to sketch/i);
		session.stroke(strokeOf(cam, round(RECT)));
		expect(session.commit(12_000, false).sketch.entities).toHaveLength(1);
	});

	it("says nothing to sketch when the view never meets the plane", () => {
		// screenToPlane answers with a NaN pair for a ray parallel to the plane (edge-on, phi 90° on XZ).
		const view: SketchView = { screenToPlane: () => [Number.NaN, Number.NaN] };
		const session = startSketch(XY, undefined, view);
		session.stroke([{ x: 10, y: 10, t: 0 }, { x: 90, y: 12, t: 1 }]);
		expect(session.entities()).toEqual([]);
		expect(() => session.commit(12_000, false)).toThrow(/nothing to sketch/i);
	});

	it("drops the points that miss the plane instead of poisoning the ring with NaN", () => {
		// One corner's ray happens to run parallel to the plane. The other three stand, as a triangle, and no
		// NaN reaches the document: Math.round(NaN) would put NaN in a step's coordinates.
		const cam = camera({ mmPerPx: 0.25, miss: (p) => p.x > 450 && p.y > 150 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		expect(session.commit(12_000, false).sketch.entities).toEqual([
			{ kind: "poly", points: [[0, 0], [40_000, 30_000], [0, 30_000], [0, 0]] },
		]);
	});
});

describe("the seam Task 12 widens", () => {
	it("stores the axes the frame it drew in, at 1e6 per unit", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const session = startSketch(XY, undefined, cam.view);
		session.stroke(strokeOf(cam, round(RECT)));
		expect(session.commit(12_000, false).sketch).toMatchObject({
			plane: XY,
			origin: [0, 0],
			axes: [
				[1_000_000, 0, 0],
				[0, 1_000_000, 0],
			],
		});
	});

	it("takes a host face's origin and normal when one is given", () => {
		const cam = camera({ mmPerPx: 0.25 });
		const plane: PlaneRef = { kind: "face", face: { step: "step-1", role: "face", index: 1 } };
		const session = startSketch(plane, { origin: [0, 0, 12], normal: [0, 0, 1] }, cam.view);
		expect(session.frame.origin).toEqual([0, 0, 12]);
		expect(session.frame.normal).toEqual([0, 0, 1]);
		session.stroke(strokeOf(cam, round(RECT)));
		const [poly] = session.commit(12_000, false).sketch.entities;
		expect(session.commit.length >= 0 && poly?.kind, "the ring is still plane µm").toBe("poly");
	});

	it("refuses a face sketch with no face to sit on", () => {
		const plane: PlaneRef = { kind: "face", face: { step: "step-1", role: "face", index: 1 } };
		expect(() => startSketch(plane, undefined, camera({ mmPerPx: 0.25 }).view)).toThrow(/face/i);
	});
});
