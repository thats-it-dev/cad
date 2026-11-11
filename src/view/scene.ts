// The model canvas: three.js, one BufferGeometry per build, and the orbit camera the gestures drive.
//
// Units are millimetres throughout, because everything the kernel hands back is already millimetres
// (src/model/units.ts) — a 40 × 30 × 12 mm box is 40 units wide here, so fit, pan and the pick distance all
// read as real sizes. The world axis is Z: a sketch's plane is XY unless the document says otherwise, and
// `camera.up` matches.
//
// Ink arrives as `Entity[]`, which is plane micrometres in some sketch's own frame, so drawing it needs both
// the frame and the camera. That is why `render` takes the ink and hands finished screen polylines to the
// overlay: the projection lives with the thing it projects through, and the overlay stays a painter.
import * as THREE from "three";
import type { Mesh } from "../kernel/decode.ts";
import type { Entity } from "../model/types.ts";
import { mm } from "../model/units.ts";
import { unproject, type Frame2, type Vec3 } from "../sketch/frame.ts";
import type { Overlay, Pixel } from "./overlay.ts";

/** A box in model millimetres. */
export type Box3 = { min: Vec3; max: Vec3 };

/** The plane a point is expressed in: a sketch frame, in model millimetres. */
export type Plane3 = Frame2;

/** Which way the camera looks, as an azimuth and a polar angle from +Z, in radians. */
export type Orbit = { theta: number; phi: number };

/** The orbit the gestures move. Distances are mm, offsets from them are CSS px. */
export type View = Orbit & {
	distance: number;
	target: Vec3;
	orbit(dx: number, dy: number): void;
	pan(dx: number, dy: number): void;
	zoom(factor: number, centre: Pixel): void;
	/** Pulls to an axis view if the release left the camera within 6° of one. */
	snap(): void;
};

export type Scene = {
	view: View;
	/** Where the ink in `render` lives. Defaults to the model's XY plane at the origin. */
	frame: Plane3;
	render(mesh: Mesh, ink?: Entity[]): void;
	fit(box: Box3): void;
	resize(width: number, height: number): void;
	dispose(): void;
	/** Screen px → plane mm. Both entries are NaN for a ray that never meets the plane. */
	screenToPlane(clientX: number, clientY: number, plane: Plane3): [number, number];
	/** The face of the last-rendered mesh under a screen point, or nothing. */
	pick(clientX: number, clientY: number): { faceIndex: number; point: Vec3 } | null;
};

const FOV = 35;
/** Orbit drag: a 300 px flick is roughly a quarter turn, the same for a finger and for a mouse. */
const RAD_PER_PX = Math.PI / 2 / 300;
/** phi is clamped off the poles so `camera.up` is never parallel to the view direction. */
const POLAR = 1e-4;
const NEAR_LIMIT = 0.05;
const FAR_LIMIT = 2_000_000;
/** The half-angle within which an orbit release counts as "meant that axis view", in radians (6°). */
const SNAP_LIMIT = (6 * Math.PI) / 180;

/** The axis views, as an orbit each: four sides, straight down, straight up, and the isometric corner. */
const AXIS_VIEWS: Orbit[] = [
	{ theta: 0, phi: Math.PI / 2 },
	{ theta: Math.PI / 2, phi: Math.PI / 2 },
	{ theta: Math.PI, phi: Math.PI / 2 },
	{ theta: -Math.PI / 2, phi: Math.PI / 2 },
	{ theta: 0, phi: 0 },
	{ theta: 0, phi: Math.PI },
	{ theta: Math.PI / 4, phi: Math.acos(1 / Math.sqrt(3)) },
];

const direction = (o: Orbit): THREE.Vector3 => {
	const phi = Math.min(Math.max(o.phi, POLAR), Math.PI - POLAR);
	return new THREE.Vector3(Math.sin(phi) * Math.cos(o.theta), Math.sin(phi) * Math.sin(o.theta), Math.cos(phi));
};

/**
 * The nearest axis view within 6°, or the orbit untouched. Distance is measured as the angle between the two
 * view directions rather than as a difference in `theta` or `phi`, so a pole (where the azimuth means nothing)
 * and a diagonal corner are handled by the same rule as a side view.
 */
export function snapCamera(orbit: Orbit): Orbit {
	const from = direction(orbit);
	let best = 0;
	let gap = SNAP_LIMIT;
	AXIS_VIEWS.forEach((axis, i) => {
		const d = Math.acos(Math.min(1, Math.max(-1, from.dot(direction(axis)))));
		if (d <= gap) {
			gap = d;
			best = i + 1;
		}
	});
	if (best === 0) return { theta: orbit.theta, phi: orbit.phi };
	return AXIS_VIEWS[best - 1]!;
}

/** The box a mesh fills, in mm. An empty build fills nothing. */
export function meshBounds(mesh: Mesh): Box3 {
	const box: Box3 = {
		min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
		max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
	};
	for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
		for (let a = 0; a < 3; a++) {
			box.min[a] = Math.min(box.min[a], mesh.positions[i + a]!);
			box.max[a] = Math.max(box.max[a], mesh.positions[i + a]!);
		}
	}
	if (!Number.isFinite(box.min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
	return box;
}

/**
 * Which face a picked triangle belongs to. A triangle's index run sits inside exactly one face's range, and
 * the range carries the worker's own `face_index`, which is what a pick has to report.
 *
 * Task 12 owns the next step, and it is not a small one: nothing in this tree maps a scene `face_index` back
 * to a document step. The kernel numbers faces across the whole render in traversal order, while `opsPerStep`
 * counts operations, so the table has to be built where the script is. Until then `cad-pick` has no honest
 * `TopoRef.step` to carry, so the viewer does not emit that event yet.
 */
export function faceOfTriangle(mesh: Mesh, triangle: number): number | null {
	const at = triangle * 3;
	for (const range of mesh.faceRanges) {
		if (at >= range.start && at < range.start + range.count) return range.faceIndex;
	}
	return null;
}

/** Edge polylines as segment pairs, which is the only form `LineSegments` understands. One run ends where
 *  the indices stop counting up, because decode emits every edge's vertices in order (src/kernel/decode.ts). */
function edgePairs(mesh: Mesh): number[] {
	const out: number[] = [];
	for (let i = 1; i < mesh.edgeIndices.length; i++) {
		const a = mesh.edgeIndices[i - 1]!;
		const b = mesh.edgeIndices[i]!;
		if (b === a + 1) out.push(a, b);
	}
	return out;
}

export function createScene(canvas: HTMLCanvasElement, overlay?: Overlay): Scene {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
	// A capped ratio is the difference between a crisp model and a 3× pixel budget on a phone.
	renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

	const scene = new THREE.Scene();
	// Ground light from below keeps a downward-facing face off black; the key rides with the camera so the
	// shading reads the same from every angle the user orbits to.
	const hemi = new THREE.HemisphereLight(0xffffff, 0x9099a8, 1.1);
	const key = new THREE.DirectionalLight(0xffffff, 1.6);
	scene.add(hemi, key);

	const solid = new THREE.Mesh(
		new THREE.BufferGeometry(),
		// DoubleSide because the kernel's winding is not guaranteed per face; three flips the normal for the
		// back face, so a reversed face shades correctly instead of vanishing.
		new THREE.MeshStandardMaterial({ color: 0xaeb6c2, metalness: 0.05, roughness: 0.62, side: THREE.DoubleSide }),
	);
	const wire = new THREE.LineSegments(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial({ color: 0x2a2e35, transparent: true, opacity: 0.5 }),
	);
	scene.add(solid, wire);

	const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1000);
	camera.up.set(0, 0, 1);

	const ray = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	const centre = new THREE.Vector3();
	const toward = new THREE.Vector3();
	const sideways = new THREE.Vector3();
	let width = 1;
	let height = 1;
	let shown: Mesh | null = null;
	let radius = 100;
	let frame: Plane3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };

	const view: View = {
		theta: Math.PI / 4,
		phi: Math.acos(1 / Math.sqrt(3)),
		distance: 200,
		target: [0, 0, 0],
		orbit(dx, dy) {
			view.theta -= dx * RAD_PER_PX;
			view.phi = Math.min(Math.max(view.phi - dy * RAD_PER_PX, 0), Math.PI);
		},
		pan(dx, dy) {
			const mmPerPx = visibleHeight() / height;
			move(dx * mmPerPx, dy * mmPerPx);
		},
		zoom(factor, centre) {
			const mmPerPx = visibleHeight() / height;
			// Keep the point under the fingers or the cursor where it was, then dolly.
			move((centre.x - width / 2) * mmPerPx * (1 - 1 / factor), (centre.y - height / 2) * mmPerPx * (1 - 1 / factor));
			view.distance = Math.min(Math.max(view.distance / factor, NEAR_LIMIT), FAR_LIMIT);
		},
		snap() {
			const snapped = snapCamera(view);
			view.theta = snapped.theta;
			view.phi = snapped.phi;
		},
	};

	/** How tall the view is, in mm, at the target plane. */
	function visibleHeight(): number {
		return 2 * view.distance * Math.tan(((FOV / 2) * Math.PI) / 180);
	}

	/** Shifts the target along the screen's own axes, in mm. `right` is screen-right, `up` screen-up. */
	function move(right: number, up: number): void {
		// toward = target → eye. Screen-right is up × (target→eye) crossed the other way round: with camera.up
		// = +Z and azimuth θ the eye sits at (sin θ cos φ, …, cos θ cos φ) from the target, so the horizontal
		// unit the pan has to follow is (-sin θ, cos θ, 0) = (target→eye) × up … and screen-up is the negative
		// of up × that, because up × right points *down* the screen for a Z-up camera. Both signs were got
		// wrong once, which made a two-finger drag push the model against the fingers.
		toward.copy(direction(view)).negate();
		sideways.crossVectors(camera.up, toward).normalize().negate();
		toward.crossVectors(sideways, camera.up).normalize();
		view.target = [
			view.target[0] + sideways.x * right + toward.x * up,
			view.target[1] + sideways.y * right + toward.y * up,
			view.target[2] + sideways.z * right + toward.z * up,
		];
	}

	function upload(mesh: Mesh): void {
		const geometry = new THREE.BufferGeometry();
		const edgeGeometry = new THREE.BufferGeometry();
		if (mesh.positions.length >= 3) {
			geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
			geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
			geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
			// A face the kernel tessellated without normals would shade black; flat ones cost one pass and
			// never leave a hole in the model.
			// A face the kernel tessellated without normals would shade black, so recompute if any normal is
			// blank — decode zeroes only the faces whose normal_coord was the wrong length (src/kernel/decode.ts),
			// so an all-or-nothing test here would leave exactly the hole it promises to close.
			if (mesh.normals.length !== mesh.positions.length || mesh.normals.some((n) => n === 0)) geometry.computeVertexNormals();
			geometry.computeBoundingSphere();
			edgeGeometry.setAttribute("position", new THREE.BufferAttribute(mesh.edgePositions, 3));
			edgeGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(edgePairs(mesh)), 1));
			edgeGeometry.computeBoundingSphere();
		}
		solid.geometry.dispose();
		wire.geometry.dispose();
		solid.geometry = geometry;
		wire.geometry = edgeGeometry;
		solid.visible = mesh.faceCount > 0;
		wire.visible = mesh.edgeCount > 0;
		shown = mesh;
	}

	/** Screen px to normalised device coords, off the canvas's own box (it sits in a shadow root). */
	function device(clientX: number, clientY: number): THREE.Vector2 {
		const rect = canvas.getBoundingClientRect();
		return ndc.set(((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1));
	}

	/** A ray from the camera through a screen point. */
	function cast(clientX: number, clientY: number): void {
		ray.setFromCamera(device(clientX, clientY), camera);
	}

	/** A model point → px in the canvas's own space, which is what the overlay draws into. The overlay canvas
	 *  sits exactly over this one, so local px is one coordinate system for both; `device()` above and the
	 *  gestures' `clientX` are the client-space pair. */
	function projectTo(p: Vec3): Pixel {
		centre.set(p[0], p[1], p[2]).project(camera);
		return { x: ((centre.x + 1) / 2) * width, y: ((1 - centre.y) / 2) * height };
	}

	/** Sketch entities in plane mm → screen px, through the frame they were drawn in. */
	function inkLines(ink: Entity[]): Pixel[][] {
		return ink.map((entity) =>
			outline(entity).map((p2) => projectTo(unproject(p2, frame))),
		);
	}

	return {
		view,
		get frame() {
			return frame;
		},
		set frame(f: Plane3) {
			frame = f;
		},
		render(mesh: Mesh, ink: Entity[] = []) {
			if (mesh !== shown) upload(mesh);
			centre.set(view.target[0], view.target[1], view.target[2]);
			camera.position.copy(centre).addScaledVector(direction(view), view.distance);
			camera.lookAt(centre);
			// A tight near/far pair is what keeps depth precision on a 40 mm part; a fixed far plane of 1 km
			// z-fights the faces the kernel just barely separated.
			camera.near = Math.max(NEAR_LIMIT, view.distance - radius * 2);
			camera.far = view.distance + radius * 2 + 1;
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld(true);
			key.position.copy(camera.position);
			key.target.position.copy(centre);
			renderer.render(scene, camera);
			overlay?.clear();
			if (overlay && ink.length) overlay.polylines(inkLines(ink));
		},
		fit(box: Box3) {
			const r = meshRadius(box);
			radius = r;
			view.target = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];			// Half the smaller field of view, because a phone held upright crops the sides first.
			const half = (Math.min(FOV, FOV * (width / height)) * Math.PI) / 360;
			view.distance = Math.min(Math.max(r / Math.sin(half) + r, NEAR_LIMIT), FAR_LIMIT);
		},
		resize(w: number, h: number) {
			width = Math.max(1, w);
			height = Math.max(1, h);
			renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
			renderer.setSize(width, height, false);
			overlay?.resize(width, height);
		},
		dispose() {
			solid.geometry.dispose();
			wire.geometry.dispose();
			(solid.material as THREE.Material).dispose();
			(wire.material as THREE.Material).dispose();
			renderer.dispose();
		},
		screenToPlane(clientX: number, clientY: number, plane: Plane3): [number, number] {
			cast(clientX, clientY);
			const n = new THREE.Vector3(...plane.normal).normalize();
			const origin = new THREE.Vector3(...plane.origin);
			const along = ray.ray.direction.dot(n);
			const hit = ray.ray.origin.clone().sub(origin);
			// Parallel to the plane: no point on it is under the cursor.
			if (Math.abs(along) < 1e-9 || !Number.isFinite(along)) return [Number.NaN, Number.NaN];
			const d = -hit.dot(n) / along;
			const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, d).sub(origin);
			return [p.dot(new THREE.Vector3(...plane.u)), p.dot(new THREE.Vector3(...plane.v))];
		},
		pick(clientX: number, clientY: number) {
			if (!shown || !solid.visible) return null;
			cast(clientX, clientY);
			const hit = ray.intersectObject(solid, false)[0];
			// three types faceIndex as `number | null | undefined`: null on a hit with something that has no
			// triangles. The triangle index is what faceRanges are searched with.
			const triangle = hit?.faceIndex;
			if (typeof triangle !== "number") return null;
			const faceIndex = faceOfTriangle(shown, triangle);
			if (faceIndex === null) return null;
			return { faceIndex, point: [hit.point.x, hit.point.y, hit.point.z] };
		},
	};
}

/** An entity's outline in plane mm: a poly is its points, a circle is 32 segments around it. */
function outline(entity: Entity): [number, number][] {
	if (entity.kind === "circle") {
		const c: [number, number] = [mm(entity.centre[0]), mm(entity.centre[1])];
		const r = mm(entity.radius);
		return Array.from({ length: 33 }, (_, i) => {
			const a = ((i % 32) / 32) * Math.PI * 2;
			return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
		});
	}
	return entity.points.map((p) => [mm(p[0]), mm(p[1])]);
}

/** Half the box's diagonal: the sphere a part fits in, which is what `fit` backs away to. */
function meshRadius(box: Box3): number {
	return Math.max(1, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
}
