// Strokes of screen pixels become sketch entities in plane micrometres. This module is 2D only: the view
// layer hands over the px→plane map (it owns the camera's y flip), and the script builder later lifts the
// plane points into model space. v1.0 fits nothing but line segments, so a drawn arc stays a polyline.
import { mm, um, type Umm } from "../model/units.ts";
import type { Entity } from "../model/types.ts";

export type RawStroke = { points: [number, number][] };

/** Screen px to plane mm: the sketch-plane origin's pixel position, and one uniform positive scale. */
export type Map2 = { originPx: [number, number]; mmPerPx: number };

/** The floor for dropping a vertex that sits on the line between its neighbours. Wobble is judged against
 *  1% of the stroke's own arc length (see `cornerTolUmm`), never against the snap grid: rounding must not decide
 *  whether a corner exists. This floor only bites on a stroke too small for 1% to mean anything. */
export const CORNER_EPSILON_UM: Umm = 25;

/** A segment within 5° of an axis is taken as exactly horizontal or vertical. A real chamfer is 30°+. */
const AXIS_TAN = 0.0875;

/** Hard ceiling on the turn that counts as wobble, in radians (20°). The density-aware threshold below
 *  rises as sampling gets finer — a slow stroke on iPad samples every ~0.2 mm — and past this angle a
 *  corner is geometry whatever the spacing. Corners shallower than ~20° are flattened: v1.0's trade. */
const MAX_TURN = 0.35;

type Point = [Umm, Umm];

const round = (v: Umm, step: Umm): Umm => Math.round(v / step) * step;
const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/** True when a stroke's ends are within `gapPx` of each other, which is what lets a loop be filled in.
 *  Both arguments are screen px, the units RawStroke carries: the caller decides closure and hands
 *  toEntities a plain `closed` flag, so no px/µm mixing happens below here. */
export function isClosed(points: [number, number][], gapPx: number): boolean {
	if (points.length < 2) return false;
	const first = points[0];
	const last = points[points.length - 1];
	return Math.hypot(last[0] - first[0], last[1] - first[1]) <= gapPx;
}

/** The end of a segment, snapped to the grid and to the axis the segment already nearly follows. `a` is
 *  the previous point as accepted, so an edge made of many nearly-flat segments stays dead straight. */
export function snapSegment(a: Point, b: Point, snapUmm: Umm): Point {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const point: Point = [round(b[0], snapUmm), round(b[1], snapUmm)];
	if (Math.abs(dy) <= Math.abs(dx) * AXIS_TAN) return [point[0], a[1]];
	if (Math.abs(dx) <= Math.abs(dy) * AXIS_TAN) return [a[0], point[1]];
	return point;
}

/** px strokes → entities: map to plane µm, drop wobble, snap, merge repeats, then close once. */
export function toEntities(strokes: RawStroke[], opts: { map: Map2; snapUmm: Umm; closed: boolean }): Entity[] {
	const { map, snapUmm, closed } = opts;
	const entities: Entity[] = [];
	for (const stroke of strokes) {
		const plane = stroke.points.map(
			(p): Point => [um((p[0] - map.originPx[0]) * map.mmPerPx), um((p[1] - map.originPx[1]) * map.mmPerPx)],
		);
		const points: Point[] = [];
		for (const p of simplify(plane)) {
			const snapped = points.length === 0 ? ([round(p[0], snapUmm), round(p[1], snapUmm)] as Point) : snapSegment(points[points.length - 1], p, snapUmm);
			points.push(snapped);
		}
		const ring = merge(points);
		if (ring.length < (closed ? 3 : 2)) continue;
		if (closed) ring.push([ring[0][0], ring[0][1]]);
		entities.push({ kind: "poly", points: ring });
	}
	return entities;
}

/** Drops repeated points, including a final one that repeats the start: a loop drawn back to where it
 *  began is one vertex, so the closing point added later is counted exactly once. */
function merge(points: Point[]): Point[] {
	const kept = points.filter((p, i) => i === 0 || !same(p, points[i - 1]));
	return kept.length > 1 && same(kept[kept.length - 1], kept[0]) ? kept.slice(0, -1) : kept;
}

/** Splits the stroke where its direction changes and keeps one segment per straight run: the corners plus
 *  the two ends. Turn angle, not distance from a chord, because a real corner can sit exactly on the chord
 *  of its neighbours and still be a corner. */
function simplify(points: Point[]): Point[] {
	if (points.length < 3) return points;
	const cuts = cornerCuts(points, Math.min(Math.atan2(cornerTolUmm(points), meanSegmentUmm(points)), MAX_TURN));
	return points.filter((_, i) => i === 0 || i === points.length - 1 || cuts.has(i));
}

/** Vertices where the path turns by more than `maxTurn` radians. Two turns on neighbouring vertices are
 *  indistinguishable from a tiny tab (a 0.5 mm feature at pencil sample spacing): both are kept, because
 *  no local rule can tell a deliberate step from sampling drift. What is pinned is the angle floor below. */
function cornerCuts(points: Point[], maxTurn: number): Set<number> {
	const segs = points.slice(1).map((p, i): Point => [p[0] - points[i][0], p[1] - points[i][1]]);
	const cuts = new Set<number>();
	for (let i = 1; i < segs.length; i++) {
		const [ax, ay] = segs[i - 1];
		const [bx, by] = segs[i];
		if (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) > maxTurn) cuts.add(i);
	}
	return cuts;
}

const meanSegmentUmm = (points: Point[]): number => {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	return total / (points.length - 1) || 1;
};

/** 1% of the stroke's arc length, floored: a hand wobbles the same fraction per mm travelled on a 5 mm tab
 *  as on a 500 mm plate. The bounding-box diagonal is the wrong measure — a long, thin stroke (a shallow step
 *  along a 40 mm edge) reports a big diagonal and its real corners get flattened. */
function cornerTolUmm(points: Point[]): Umm {
	let length = 0;
	for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	return Math.max(CORNER_EPSILON_UM, Math.round(length * 0.01));
}

/** Enclosed area in mm². An open poly encloses nothing and reports 0. */
export function areaOf(entity: Entity): number {
	if (entity.kind === "circle") return Math.PI * mm(entity.radius) ** 2;
	const points = entity.points;
	if (points.length < 3 || !same(points[0], points[points.length - 1])) return 0;
	let sum = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const [x1, y1] = [mm(points[i][0]), mm(points[i][1])];
		const [x2, y2] = [mm(points[i + 1][0]), mm(points[i + 1][1])];
		sum += x1 * y2 - x2 * y1;
	}
	return Math.abs(sum) / 2;
}
