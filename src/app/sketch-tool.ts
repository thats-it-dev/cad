// The sketch tool: pen strokes in, an extrude step out.
//
// This file owns the one round trip Task 9 is made of — screen px → plane µm → (later, in kernel/script.ts)
// model mm. `<cad-viewer>` draws the live stroke and reports it in client px; it converts nothing. So the
// conversion is here, and it goes through the camera: `view.screenToPlane` is the ray-plane intersection the
// same canvas used to draw the pixel the pencil is on, which makes it exact at any zoom and any azimuth.
//
// Why not a `Map2` (one origin, one uniform px→mm scale)? Because the viewer's own camera opens at theta π/4
// (src/view/scene.ts), where screen-right is a 45° mix of the sketch plane's axes. A scale-only map would
// commit a drawn 40 × 30 rectangle as a diamond in the model, and a perspective view of a tilted plane is a
// homography that no linear map gets right. Instead each point is converted on its own, and the `Map2` handed
// to `toEntities` is the identity, because by then the points are already plane mm. `toEntities` documents
// `RawStroke` as px: that is the one place the contract is stretched, and it is stretched for geometry, not
// for convenience. See test/sketch-flow.test.ts "does not turn a rectangle into a diamond".
import type { Entity, PlaneRef, Step } from "../model/types.ts";
import type { Umm } from "../model/units.ts";
import { insertExtrude, newDocument, newId, stepById } from "../model/doc.ts";
import { assertDepth, type Pending } from "./doc-state.ts";
import { isClosed, toEntities, type Map2 } from "../sketch/entities.ts";
import { frameFor, frameFromNormal, type Frame2, type Vec3 } from "../sketch/frame.ts";
import type { InkPoint } from "../view/gestures.ts";

/** The camera access a tool is given — the same contract as `Scene.screenToPlane`, in plane mm. */
export type SketchView = {
	screenToPlane(clientX: number, clientY: number, plane: Frame2): [number, number];
};

/** The step `commit` makes: an extrude, which is the only kind a sketch can become in v1.0. */
type Extrude = Extract<Step, { kind: "extrude" }>;

export type SketchSession = {
	/** The plane this pencil is drawing on, in model mm. The ink means nothing without it: pass it to
	 *  `<cad-viewer>.frame` so committed entities land where they were drawn. */
	readonly frame: Frame2;
	/** One completed stroke, every point the pen reported for it. Called once per pen-down-to-lift. */
	stroke(points: InkPoint[]): void;
	/** What the strokes so far became, in plane µm in `frame`: the ink to show while the sketch is pending. */
	entities(): Entity[];
	/**
	 * The sketch as the document wants it, checks and all, without consuming it. Task 10 added this so the
	 * panel and the keyboard commit through `DocState` and share one set of rules: a ring must close, must not
	 * cross itself, and must not be empty. Throwing here leaves the strokes in place, so a refusal costs the
	 * user nothing but the mistake.
	 */
	sketch(): Pending;
	/** The same snapshot before the rules are applied: what to show as ink while the sketch is unfinished, and
	 *  null when there is nothing drawn. `sketch()` throws where this returns, because the panel has to render a
	 *  half-finished drawing without treating it as an error. */
	pending(): Pending | null;
	/** Close the sketch into a step, consuming it, so Extrude twice is one step and not two. */
	commit(depthUmm: Umm, cut: boolean): Extrude;
	/** Throw the pending sketch away. The session stays open for the next stroke. */
	cancel(): void;
	/**
	 * Forget the strokes, because a step was made from them. `cancel` and this differ only in why, but the
	 * difference is the double-commit: a commit that consumed the panel's pending sketch and left the session
	 * holding the ring would let a second press build the same solid again. Task 10's e2e caught exactly that
	 * — three steps from a body, a cut, and one stale tap.
	 */
	consume(): void;
};

/** Points are plane mm by the time they reach `toEntities`, so the map scales and offsets by nothing. */
const ALREADY_PLANE_MM: Map2 = { originPx: [0, 0], mmPerPx: 1 };

/** Snap to 1 µm, the document's own resolution. `snapUmm: 0` is *not* "no snap": `entities.ts` rounds with
 *  `Math.round(v / step) * step`, and a zero step makes every coordinate NaN. 1 µm keeps what the pencil gave. */
const SNAP_UM: Umm = 1;

/** A ring's end may sit this many screen px from its start and still count as meeting it: what a pencil
 *  overshoot looks like on the glass. Pixels are the right unit only while the part fills the screen, so
 *  `CLOSURE_EXTENT` caps it against the ring's own size — otherwise, zoomed out, a 60% C whose tip gap is
 *  ten pixels of screen closes into a polygon with a diagonal the pencil never drew (review P2). */
const CLOSURE_PX = 16;
const CLOSURE_EXTENT = 0.25;

/** … or this large a share of the stroke's own arc length, whichever is the bigger allowance: a ring traced
 *  90% of the way round is a ring the user meant to close. Past that (a C, a hook) it is not a shape, and
 *  `commit` says so — because `buildScript` closes every polygon with `Polygon(points, true)`, so an open
 *  stroke would otherwise come back as a solid spanned by a diagonal the pencil never drew. */
const CLOSURE_ARC = 0.15;

/** The origin a named plane is measured from; `frameFor` moves it onto the plane by the plane's offset. */
const THROUGH_ORIGIN: Vec3 = [0, 0, 0];

/** `frameFor` ignores the axes of an axis plane (the known bug Task 12 fixes), so any unit pair will do here;
 *  what the sketch stores is the frame it actually drew in, read back off the result. */
const XY_AXES: [[Umm, Umm, Umm], [Umm, Umm, Umm]] = [
	[1_000_000, 0, 0],
	[0, 1_000_000, 0],
];

/** One stroke, kept in both halves of the round trip: px for the closure rule, mm for the model. */
type Stroke = { px: [number, number][]; mm: [number, number][]; closed: boolean };

/**
 * A sketch on `plane`. `host` is the face it sits on — the seam Task 12 widens: pass the picked face's origin
 * and normal and the pencil draws there instead. A face plane with no host is refused rather than guessed at,
 * because nothing in the committed model carries a face's 3D anchor yet.
 */
export function startSketch(plane: PlaneRef, host: { origin: Vec3; normal: Vec3 } | undefined, view: SketchView): SketchSession {
	const frame = host ? frameFromNormal(host.origin, host.normal) : plane.kind === "face" ? guessFrame(plane) : frameFor(plane, THROUGH_ORIGIN, XY_AXES);
	const strokes: Stroke[] = [];

	return {
		frame,
		stroke(points) {
			const px: [number, number][] = [];
			const mm: [number, number][] = [];
			for (const p of points) {
				// A ray that runs parallel to the plane meets it nowhere: drop that point, keep its stroke.
				const q = view.screenToPlane(p.x, p.y, frame);
				if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
				px.push([p.x, p.y]);
				mm.push(q);
			}
			// A pen tap is neither a stroke nor a shape, and saying "nothing to sketch" for one is honest.
			if (px.length < 2) return;
			strokes.push({ px, mm, closed: isClosed(px, gapPx(px)) });
		},
		entities() {
			return entitiesOf(strokes);
		},
		sketch() {
			const pending = this.pending();
			if (!pending) throw new Error("nothing to sketch");
			if (strokes.some((s) => !s.closed)) throw new Error("the ring did not close: come back to the start");
			if (pending.entities.some((e) => e.kind === "poly" && crossesItself(e.points))) throw new Error("the ring crosses itself: lift the pen and start again");
			return pending;
		},
		pending() {
			const entities = entitiesOf(strokes);
			if (entities.length === 0) return null;
			return { plane, origin: [0, 0] as [Umm, Umm], axes: axesOf(frame), entities };
		},
		commit(depthUmm, cut) {
			const pending = this.sketch();
			assertDepth(depthUmm);
			strokes.length = 0;
			const sketch = { ...pending, id: newId("sketch") };
			// The step is made by the document module, because the name ("Extrude"/"Cut") and the id rule live
			// there. The document it lands in is the app's, not this session's.
			const added = insertExtrude(newDocument(), null, sketch, depthUmm, cut);
			const step = stepById(added.doc, added.id);
			if (!step || step.kind !== "extrude") throw new Error("the sketch became no step");
			return step;
		},
		cancel() {
			strokes.length = 0;
		},
		consume() {
			strokes.length = 0;
		},
	};
}

/** A snapped sub-nanometre wobble must never leave a negative zero in the model, where `Object.is` and `JSON`
 *  disagree about it. Adding zero turns -0 into 0 and leaves NaN as NaN, so a coordinate that was poisoned by
 *  a divide stays visibly poisoned rather than becoming the origin. */
const wholeUm = (points: [Umm, Umm][]): [Umm, Umm][] => points.map((p) => [p[0]! + 0, p[1]! + 0]);

/** Where two neighbouring reports of the same tail differ: a point the held stroke already has is dropped. */
export function appendInk(held: InkPoint[], incoming: InkPoint[]): InkPoint[] {
	const added = incoming.filter((p, i) => !same(p, i === 0 ? held[held.length - 1] : incoming[i - 1]));
	return held.concat(added);
}

const same = (a: InkPoint | undefined, b: InkPoint | undefined): boolean => !!a && !!b && a.x === b.x && a.y === b.y;

/** The gap a ring may leave between its last point and its first: pixels, or a share of its own arc. */
function gapPx(px: [number, number][]): number {
	let arc = 0;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const p of px) {
		minX = Math.min(minX, p[0]!);
		minY = Math.min(minY, p[1]!);
		maxX = Math.max(maxX, p[0]!);
		maxY = Math.max(maxY, p[1]!);
	}
	for (let i = 1; i < px.length; i++) arc += Math.hypot(px[i]![0] - px[i - 1]![0], px[i]![1] - px[i - 1]![1]);
	// The absolute allowance never outruns a quarter of the ring's own diagonal, so zooming out shrinks it
	// with the drawing instead of swallowing the drawing.
	const extent = Math.hypot(maxX - minX, maxY - minY);
	return Math.max(Math.min(CLOSURE_PX, extent * CLOSURE_EXTENT), arc * CLOSURE_ARC);
}

/**
 * Does this ring cross itself? A bowtie meets every closure rule and `Polygon(points, true)` still builds a
 * wire from it, which leaves the kernel to decide what the face is — two lobes, one lobe, or a silent mess.
 * v1.0's answer is to refuse and say so, because the alternative is a solid the user did not draw. Proper
 * intersections only: neighbours share an endpoint by definition, and a ring that touches itself at a single
 * point without crossing stays drawable.
 */
function crossesItself(ring: [number, number][]): boolean {
	const n = ring.length - 1; // the closing repeat, if any, is ring[0] again
	if (n < 4) return false;
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) continue; // the two ends of a closed ring, which meet by construction
			if (properCross(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return true;
		}
	}
	return false;
}

const side = (a: [number, number], b: [number, number], p: [number, number]): number =>
	(b[0]! - a[0]!) * (p[1]! - a[1]!) - (b[1]! - a[1]!) * (p[0]! - a[0]!);

function properCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
	const d1 = side(a, b, c);
	const d2 = side(a, b, d);
	const d3 = side(c, d, a);
	const d4 = side(c, d, b);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Strokes → entities, one call per stroke: `closed` is a stroke's own verdict, and toEntities is per-stroke
 *  inside, so nothing is lost by asking one at a time and the rings keep the order they were drawn in. */
function entitiesOf(strokes: Stroke[]): Entity[] {
	const out: Entity[] = [];
	for (const s of strokes) {
		for (const e of toEntities([{ points: s.mm }], { map: ALREADY_PLANE_MM, snapUmm: SNAP_UM, closed: s.closed })) {
			out.push(e.kind === "poly" ? { ...e, points: wholeUm(e.points) } : e);
		}
	}
	return out;
}

/** The frame's axes as the document stores them: direction only, at 1e6 µm per unit (src/sketch/frame.ts).
 *  That scale is deliberately not the mm→µm distance conversion — an axis is a direction, not a distance. */
const axesOf = (frame: Frame2): [[Umm, Umm, Umm], [Umm, Umm, Umm]] => [dirUmm(frame.u), dirUmm(frame.v)];
const dirUmm = (v: Vec3): [Umm, Umm, Umm] => [Math.round(v[0]! * 1_000_000), Math.round(v[1]! * 1_000_000), Math.round(v[2]! * 1_000_000)];

/** Task 12's seam, spelled out: a face plane needs the face, and this guesses at nothing. */
function guessFrame(plane: PlaneRef): Frame2 {
	throw new Error(`a sketch on a ${plane.kind} plane needs the face it sits on`);
}
