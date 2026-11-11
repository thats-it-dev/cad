// The sketch frame: where a 2D sketch sits in 3D space, and how points move between the two.
// Everything here is millimetre floats — the frame is the boundary the script builder crosses, and
// integers never appear in it. A sketch's stored axes are direction-only (1e6 per unit), so their
// magnitude is discarded by normalising.
import type { PlaneRef } from "../model/types.ts";
import { mm } from "../model/units.ts";
import type { Umm } from "../model/units.ts";

export type Vec3 = [number, number, number];

/** A plane's own coordinate system in model space: u and v are the sketch's x and y, unit length, right-handed about normal. */
export type Frame2 = { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => mul(a, 1 / len(a));

/** Which model axis each named plane is perpendicular to, and the in-plane u/v in model axes. */
const AXES: Record<"XY" | "XZ" | "YZ", { index: number; u: Vec3; v: Vec3 }> = {
	XY: { index: 2, u: [1, 0, 0], v: [0, 1, 0] },
	XZ: { index: 1, u: [1, 0, 0], v: [0, 0, 1] },
	YZ: { index: 0, u: [0, 1, 0], v: [0, 0, 1] },
};

/** The frame of an offset axis plane is the plane's own basis; the frame of a face is the basis the
 *  sketch stored when it was drawn. `origin`'s component along the plane's normal is replaced by the
 *  plane's offset, so the frame always lies on the plane it names. */
export function frameFor(plane: PlaneRef, origin: Vec3, axes: [[Umm, Umm, Umm], [Umm, Umm, Umm]]): Frame2 {
	if (plane.kind === "face") {
		const u = normalize(axes[0]);
		const v = normalize(axes[1]);
		return { origin, u, v, normal: normalize(cross(u, v)) };
	}
	const axis = AXES[plane.axis];
	const point: Vec3 = [...origin];
	point[axis.index] = mm(plane.offset);
	return { origin: point, u: axis.u, v: axis.v, normal: normalize(cross(axis.u, axis.v)) };
}

/** A frame from a point and a normal alone, for a face whose sketch axes are not known yet. The
 *  reference vector stays off any axis the normal is close to, so the cross product never degenerates. */
export function frameFromNormal(point: Vec3, normal: Vec3): Frame2 {
	const n = normalize(normal);
	const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	const u = normalize(cross(n, ref));
	return { origin: point, u, v: cross(n, u), normal: n };
}

/** Model point → sketch coordinates. Off-plane components are dropped: a stroke is drawn on the plane. */
export const project = (p: Vec3, f: Frame2): [number, number] => {
	const d = sub(p, f.origin);
	return [dot(d, f.u), dot(d, f.v)];
};

/** Sketch coordinates → model point, landing on the plane. */
export const unproject = (p2: [number, number], f: Frame2): Vec3 =>
	add(f.origin, add(mul(f.u, p2[0]), mul(f.v, p2[1])));
