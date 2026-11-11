// The viewer's rules, checked where they can be checked without a browser: the gesture map (Review Focus 1),
// the camera snap, and the box a mesh fills. Everything here is event objects and numbers — three.js is only
// imported for `snapCamera`'s module, never constructed, so no WebGL context is needed.
//
// Node has no PointerEvent, so `pointer()` builds a plain Event and bolts the pointer fields onto it. That is
// enough for Gestures, which only ever reads fields off the event it was handed.
import { describe, expect, it } from "vitest";
import { Gestures, type GestureHandlers } from "../src/view/gestures.ts";
import { faceOfTriangle, meshBounds, snapCamera } from "../src/view/scene.ts";
import { EMPTY_MESH, type Mesh } from "../src/kernel/decode.ts";

const DEG = Math.PI / 180;

type Call = { kind: "orbit" | "pan" | "zoom" | "draw"; args: unknown[] };

/** The four handler sinks, plus the pointer ids the target was asked to capture. */
function rig() {
	const calls: Call[] = [];
	const captured: number[] = [];
	// A real EventTarget, so addEventListener/dispatchEvent are actually connected, wearing the one element
	// method Gestures calls.
	const target = Object.assign(new EventTarget(), {
		setPointerCapture(id: number) {
			captured.push(id);
		},
	}) as EventTarget & { setPointerCapture(id: number): void };

	const handlers: GestureHandlers = {
		orbit: (dx, dy) => calls.push({ kind: "orbit", args: [dx, dy] }),
		pan: (dx, dy) => calls.push({ kind: "pan", args: [dx, dy] }),
		zoom: (factor, centre) => calls.push({ kind: "zoom", args: [factor, centre] }),		draw: (phase, points, pointerType) => calls.push({ kind: "draw", args: [phase, points, pointerType] }),
	};
	const gestures = new Gestures(target, handlers);
	return { calls, captured, target, gestures };
}

type PointerInit = {
	id: number;
	type: string;
	kind?: string;
	x: number;
	y: number;
	t?: number;
	/** Positions a real browser would have folded into this one event. Absent: no coalescing support. */
	burst?: { x: number; y: number; t: number }[];
};

const bolt = (e: Event, fields: Record<string, unknown>): void => {
	// defineProperty, not assignment: clientX and friends are prototype getters, which a strict-mode write
	// cannot shadow.
	for (const [k, value] of Object.entries(fields)) Object.defineProperty(e, k, { value, configurable: true });
};

function pointer(target: EventTarget, init: PointerInit): void {
	const e = new Event(init.type, { bubbles: true, cancelable: true });
	const released = init.type === "pointerup" || init.type === "pointercancel" || init.type === "lostpointercapture";
	bolt(e, {
		pointerId: init.id,
		pointerType: init.kind ?? "touch",
		clientX: init.x,
		clientY: init.y,
		timeStamp: init.t ?? 0,
		button: 0,
		buttons: released ? 0 : 1,
	});
	// `getCoalescedEvents` is missing on engines that do not have it; an empty array is a move with nothing
	// folded in. Both must still yield exactly one point.
	if (init.burst) bolt(e, { getCoalescedEvents: () => init.burst!.map((p) => ({ clientX: p.x, clientY: p.y, timeStamp: p.t })) });
	else if (init.type === "pointermove") bolt(e, { getCoalescedEvents: () => [] });
	target.dispatchEvent(e);
}

const down = (t: EventTarget, id: number, kind: string, x: number, y: number) => pointer(t, { id, type: "pointerdown", kind, x, y });
const move = (t: EventTarget, id: number, kind: string, x: number, y: number, burst?: { x: number; y: number; t: number }[]) =>
	pointer(t, { id, type: "pointermove", kind, x, y, burst });
const up = (t: EventTarget, id: number, kind: string, x: number, y: number) => pointer(t, { id, type: "pointerup", kind, x, y });

const drawn = (calls: Call[]) => calls.filter((c) => c.kind === "draw");
const lastDraw = (calls: Call[]) => drawn(calls)[drawn(calls).length - 1];

describe("gestures", () => {
	it("captures every pointer, so a second one cannot steal the pen", () => {
		const { calls, captured, target, gestures } = rig();
		down(target, 1, "pen", 10, 10);
		down(target, 2, "touch", 40, 40);
		// Per-pointer capture is what keeps the pen's stream arriving when a finger lands beside it.
		expect(captured).toEqual([1, 2]);
		expect(drawn(calls).map((c) => c.args[0])).toEqual(["start"]);
		gestures.dispose();
	});

	it("starts a stroke on a pen down", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 12, 20);
		expect(drawn(calls).length).toBe(1);
		expect(lastDraw(calls)!.args[0]).toBe("start");
		expect(lastDraw(calls)!.args[1]).toEqual([{ x: 12, y: 20, t: 0 }]);
		expect(lastDraw(calls)!.args[2]).toBe("pen");
		expect(calls.filter((c) => c.kind === "orbit" || c.kind === "pan" || c.kind === "zoom")).toEqual([]);
		gestures.dispose();
	});

	// The one Review Focus asks for above all others: the pen and the fingers must not fight.
	it("lets two fingers pan while the pen is still drawing", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 100, 100);
		move(target, 1, "pen", 110, 105);
		down(target, 2, "touch", 10, 10);
		down(target, 3, "touch", 30, 10);
		move(target, 2, "touch", 20, 15);
		move(target, 3, "touch", 40, 15);
		move(target, 1, "pen", 120, 110);

		const strokes = drawn(calls);
		expect(strokes.map((c) => c.args[0])).toEqual(["start", "move", "move"]);
		expect(strokes.every((c) => c.args[2] === "pen")).toBe(true);
		// Both fingers travelled 10 px right and 5 px down, so the pans over the two moves add up to that.
		const pans = calls.filter((c) => c.kind === "pan");
		expect(pans.length).toBeGreaterThan(0);
		expect(pans.reduce((t, c) => [t[0] + (c.args[0] as number), t[1] + (c.args[1] as number)], [0, 0])).toEqual([10, 5]);
		// Fingers must not turn the model while the pen draws: two of them mean pan, never orbit.
		expect(calls.filter((c) => c.kind === "orbit")).toEqual([]);
		gestures.dispose();
	});

	it("pinches with two fingers and orbits with one", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "touch", 0, 0);
		move(target, 1, "touch", 7, 3);
		expect(calls.filter((c) => c.kind === "orbit").map((c) => c.args)).toEqual([[7, 3]]);
		expect(calls.filter((c) => c.kind === "pan")).toEqual([]);

		// The one finger lifts, and a fresh pair 20 px apart doubles its gap.
		up(target, 1, "touch", 7, 3);
		down(target, 2, "touch", -10, 0);
		down(target, 3, "touch", 10, 0);
		move(target, 3, "touch", 30, 0);
		const zooms = calls.filter((c) => c.kind === "zoom");
		expect(zooms.length, "the pair doubling its spread zooms").toBe(1);
		expect(zooms[0]!.args[0]).toBeCloseTo(2, 5);
		expect(calls.filter((c) => c.kind === "orbit").length).toBe(1);
		gestures.dispose();
	});

	it("ends a stroke at pointerup even when lostpointercapture never arrives", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 5, 5);
		move(target, 1, "pen", 15, 5);
		up(target, 1, "pen", 20, 5);
		expect(drawn(calls).map((c) => c.args[0])).toEqual(["start", "move", "end"]);
		// One end, and no camera movement on the way out.
		expect(drawn(calls).filter((c) => c.args[0] === "end").length).toBe(1);
		expect(calls.filter((c) => c.kind !== "draw")).toEqual([]);
		gestures.dispose();
	});

	it("ends a stroke if capture is lost while the pointer is still down", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 5, 5);
		pointer(target, { id: 1, type: "lostpointercapture", kind: "pen", x: 5, y: 5 });
		expect(drawn(calls).map((c) => c.args[0])).toEqual(["start", "end"]);
		// A pointerup that arrives afterwards is the same finger lifted, not a second stroke.
		up(target, 1, "pen", 6, 6);
		expect(drawn(calls).map((c) => c.args[0])).toEqual(["start", "end"]);
		gestures.dispose();
	});

	it("carries every coalesced position of one move", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 0, 0);
		const burst = Array.from({ length: 30 }, (_, i) => ({ x: i, y: i * 2, t: i * 4 }));
		move(target, 1, "pen", 29, 58, burst);
		expect(lastDraw(calls)!.args[0]).toBe("move");
		expect(lastDraw(calls)!.args[1]).toEqual(burst.map((p) => ({ x: p.x, y: p.y, t: p.t })));
		expect((lastDraw(calls)!.args[1] as unknown[]).length).toBe(30);
		gestures.dispose();
	});

	it("falls back to the event's own point when coalescing is missing or empty", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 0, 0);
		// A move whose engine has no getCoalescedEvents at all.
		const e = new Event("pointermove", { bubbles: true });
		bolt(e, { pointerId: 1, pointerType: "pen", clientX: 3, clientY: 4, timeStamp: 9, buttons: 1 });
		target.dispatchEvent(e);
		expect(lastDraw(calls)!.args[1]).toEqual([{ x: 3, y: 4, t: 9 }]);
		move(target, 1, "pen", 8, 8); // getCoalescedEvents() -> []
		expect(lastDraw(calls)!.args[1]).toEqual([{ x: 8, y: 8, t: 0 }]);
		gestures.dispose();
	});

	// Spec Decided: mouse and keyboard have parity with the pen.
	it("orbits a mouse drag and zooms the wheel", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "mouse", 50, 50);
		move(target, 1, "mouse", 62, 44);
		expect(calls.filter((c) => c.kind === "orbit").map((c) => c.args)).toEqual([[12, -6]]);
		expect(drawn(calls)).toEqual([]);

		const wheel = new Event("wheel", { bubbles: true, cancelable: true });
		bolt(wheel, { deltaY: -100, clientX: 200, clientY: 100, timeStamp: 0 });
		target.dispatchEvent(wheel);
		const zooms = calls.filter((c) => c.kind === "zoom");
		expect(zooms.length).toBe(1);
		expect(zooms[0]!.args[0]).toBeGreaterThan(1);
		expect(zooms[0]!.args[1]).toEqual({ x: 200, y: 100 });
		gestures.dispose();
	});

	it("stops reporting a mouse drag once the button is released", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "mouse", 0, 0);
		move(target, 1, "mouse", 6, 6);
		up(target, 1, "mouse", 8, 8);
		// Hovering with no button down is not an orbit.
		move(target, 1, "mouse", 90, 90);
		expect(calls.filter((c) => c.kind === "orbit").map((c) => c.args)).toEqual([[6, 6]]);
		gestures.dispose();
	});

	it("detaches its listeners on dispose, so a stroke in flight cannot reach a handler", () => {
		const { calls, target, gestures } = rig();
		down(target, 1, "pen", 0, 0);
		gestures.dispose();
		move(target, 1, "pen", 40, 40);
		up(target, 1, "pen", 40, 40);
		expect(drawn(calls).map((c) => c.args[0])).toEqual(["start"]);
	});
});

describe("faceOfTriangle", () => {
	it("reads the face a picked triangle belongs to", () => {
		const mesh = stubBox();
		expect(faceOfTriangle(mesh, 0)).toBe(0);
		expect(faceOfTriangle(mesh, 1)).toBe(0);
		expect(faceOfTriangle(mesh, 2)).toBe(1);
		expect(faceOfTriangle(mesh, 11)).toBe(5);
	});

	it("names nothing for a triangle the mesh does not have", () => {
		expect(faceOfTriangle(stubBox(), 12)).toBeNull();
		expect(faceOfTriangle(EMPTY_MESH, 0)).toBeNull();
	});
});

describe("snapCamera", () => {
	const pol = (o: { theta: number; phi: number }) => ({ x: Math.sin(o.phi) * Math.cos(o.theta), y: Math.sin(o.phi) * Math.sin(o.theta), z: Math.cos(o.phi) });

	it("snaps a view that is within 6° of an axis, and only such a view", () => {
		// The brief's own example: a side view 3° short of dead level pulls flat onto it.
		expect(snapCamera({ theta: 2 * DEG, phi: 87 * DEG })).toEqual({ theta: 0, phi: 90 * DEG });
		expect(snapCamera({ theta: 20 * DEG, phi: 3 * DEG }).phi).toBeCloseTo(0, 12);
		// The same phi, but 20° around the model: no axis view is within 6°, so nothing moves.
		expect(snapCamera({ theta: 20 * DEG, phi: 87 * DEG }).phi).toBeCloseTo(87 * DEG, 12);
	});

	it("leaves a view further than 6° from every axis alone", () => {
		const free = { theta: 40 * DEG, phi: 40 * DEG };
		expect(snapCamera(free)).toEqual(free);
		expect(snapCamera({ theta: 10 * DEG, phi: 80 * DEG })).toEqual({ theta: 10 * DEG, phi: 80 * DEG });
	});

	it("snaps to the nearest axis view, not merely to the nearest phi", () => {
		// 3° off the front view in azimuth, and 2° off it in elevation.
		const snapped = snapCamera({ theta: 3 * DEG, phi: 88 * DEG });
		expect(snapped.theta).toBeCloseTo(0, 12);
		expect(snapped.phi).toBeCloseTo(90 * DEG, 12);
		// The isometric corner is an axis view of its own: a hair off it returns to it.
		const iso = snapCamera({ theta: 46 * DEG, phi: 56 * DEG });
		expect(iso.theta).toBeCloseTo(45 * DEG, 12);
		expect(iso.phi).toBeCloseTo(Math.acos(1 / Math.sqrt(3)), 6);
	});

	it("never invents a direction the orbit was not near", () => {
		for (let theta = 0; theta < 360; theta += 5) {
			for (let phi = 0; phi <= 180; phi += 5) {
				const o = snapCamera({ theta: theta * DEG, phi: phi * DEG });
				const from = pol({ theta: theta * DEG, phi: phi * DEG });
				const to = pol(o);
				const gap = Math.acos(Math.min(1, Math.max(-1, from.x * to.x + from.y * to.y + from.z * to.z))) / DEG;
				expect(gap, `theta ${theta} phi ${phi}`).toBeLessThanOrEqual(6.0001);
			}
		}
	});
});

/** A 40 × 30 × 12 mm box as the kernel hands it over: 6 faces, each with its own 4 corners and 2 triangles. */
function stubBox(): Mesh {
	const x = 40, y = 30, z = 12;
	const corners: [number, number, number][][] = [
		[[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0]],
		[[0, 0, z], [x, 0, z], [x, y, z], [0, y, z]],
		[[0, 0, 0], [x, 0, 0], [x, 0, z], [0, 0, z]],
		[[0, y, 0], [x, y, 0], [x, y, z], [0, y, z]],
		[[0, 0, 0], [0, y, 0], [0, y, z], [0, 0, z]],
		[[x, 0, 0], [x, y, 0], [x, y, z], [x, 0, z]],
	];
	const positions: number[] = [];
	const indices: number[] = [];
	corners.forEach((face, i) => {
		const base = i * 4;
		for (const c of face) positions.push(...c);
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	});
	return {
		...EMPTY_MESH,
		positions: new Float32Array(positions),
		normals: new Float32Array(positions.map((_, j) => (j % 3 === 2 ? 1 : 0))),
		indices: new Uint32Array(indices),
		faceRanges: corners.map((_, i) => ({ faceIndex: i, start: i * 6, count: 6 })),
		faceCount: corners.length,
	};
}

describe("meshBounds", () => {
	it("reports the box a mesh fills", () => {
		expect(meshBounds(stubBox())).toEqual({ min: [0, 0, 0], max: [40, 30, 12] });
	});

	it("reports nothing for a build that produced no geometry", () => {
		expect(meshBounds(EMPTY_MESH)).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
	});

	it("holds points on both sides of the origin", () => {
		const m = stubBox();
		m.positions = new Float32Array([-20, -15, 0, 20, 15, 12]);
		m.indices = new Uint32Array([0, 1, 0]);
		expect(meshBounds(m)).toEqual({ min: [-20, -15, 0], max: [20, 15, 12] });
	});
});
