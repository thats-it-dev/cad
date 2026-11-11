// The build script: a document becomes cascade-core source, one library call per line.
// Two rules hold this together. Geometry leaves here as *points*, never as a kernel `Sketch`: every sketch
// plane point is lifted into model space with the step's frame and printed in millimetres, so the kernel sees
// plain coordinates. And every operation gets its own line because the worker keys its model history by
// `lineNumber` (CascadeWorker.js:180-189) — `opsPerStep` is the count of those lines per step, and Task 6
// reads it to address `meshHistoryStep`, which means one step's ops must sit side by side.
import { mm, type Umm } from "../model/units.ts";
import type { CadDocument, Entity, Sketch, Step, TopoRef } from "../model/types.ts";
import { frameFor, unproject, type Frame2, type Vec3 } from "../sketch/frame.ts";

export type Probe = { kind: "volume" | "surface" | "edgeLength"; target?: TopoRef };

export type Script = { code: string; opsPerStep: Record<string, number> };

/** The kernel's own default boolean fuzz, in mm (StandardLibrary.js:479). */
const FUZZ = "1e-7";

/** The origin a named plane is measured from: `frameFor` replaces the component along the plane's normal with
 *  the plane's offset, so the frame always lies on the plane it names. A face-anchored sketch would need a 3D
 *  anchor here instead, which the document does not carry yet (Task 12) — see `unbuilt`. */
const THROUGH_ORIGIN: Vec3 = [0, 0, 0];

type Extrude = Extract<Step, { kind: "extrude" }>;
type Names = { p: number; f: number; s: number };
type Built = { lines: string[]; shape: string };

export function buildScript(doc: CadDocument, opts: { probes: Probe[]; buildId: string }): Script {
	const names: Names = { p: 0, f: 0, s: 0 };
	const lines: string[] = [`// build ${opts.buildId} — ${doc.steps.length} step(s), generated from the document`];
	const opsPerStep: Record<string, number> = {};
	/** step id → the variable holding its solid, for the probe tail to address. */
	const shapeOf = new Map<string, string>();
	let body: string | null = null;
	let lastShape: { stepId: string; shape: string } | null = null;

	for (const step of doc.steps) {
		const built: Built =
			step.kind === "extrude" && step.sketch.plane.kind === "axis" ? buildExtrude(step, names, body) : unbuilt(step, names);
		lines.push(...built.lines);
		opsPerStep[step.id] = built.lines.filter(isOp).length;
		shapeOf.set(step.id, built.shape);
		lastShape = { stepId: step.id, shape: built.shape };
		// Only a step that actually built owns the body. A later cut from a step that did not build references that
		// step's null variable and yields nothing, which is honest; falling back to an earlier solid would quietly
		// re-apply the cut to the wrong shape.
		if (built.lines.some(isOp)) body = built.shape;
	}

	for (const probe of opts.probes) {
		lines.push(probeLine(probe, opts.buildId, shapeOf, lastShape));
	}

	return { code: `${lines.join("\n")}\n`, opsPerStep };
}

/** Polygon → MakeFace → Extrude, then a boolean against whatever the body already is. */
function buildExtrude(step: Extrude, names: Names, body: string | null): Built {
	const sketch = step.sketch;
	const frame = frameFor(sketch.plane, THROUGH_ORIGIN, sketch.axes);
	const direction = vec(frame.normal.map((n) => n * mm(step.depth)) as Vec3);
	const lines: string[] = [];
	const solids: string[] = [];

	for (const entity of sketch.entities) {
		const wire = `p${++names.p}`;
		lines.push(`const ${wire} = Polygon(${ring(entity, sketch, frame)}, true);`);
		const face = `f${++names.f}`;
		lines.push(`const ${face} = MakeFace(${wire}, true);`);
		const solid = `s${++names.s}`;
		lines.push(`const ${solid} = Extrude(${face}, ${direction}, true);`);
		solids.push(solid);
	}

	if (solids.length === 0) {
		const nothing = `s${++names.s}`;
		return { lines: [`const ${nothing} = null; // the sketch holds no shape`], shape: nothing };
	}
	let shape = solids[0];
	if (solids.length > 1) {
		shape = `s${++names.s}`;
		lines.push(`const ${shape} = Union([${solids}], false, ${FUZZ}, false);`);
	}

	if (step.cut) {
		const cut = `s${++names.s}`;
		lines.push(`const ${cut} = Difference(${body ?? "null"}, [${shape}], [false, false], ${FUZZ}, false);`);
		return { lines, shape: cut };
	}
	if (!body) return { lines, shape };

	const fused = `s${++names.s}`;
	lines.push(`const ${fused} = Union([${body},${shape}], false, ${FUZZ}, false);`);
	return { lines, shape: fused };
}

/**
 * A step this build cannot express: a sketch on a face (no 3D anchor is stored for it, Task 12) or a kind this
 * version cannot read. It emits no operation, so its count in `opsPerStep` is 0, and it threads `null` — the
 * next boolean cuts from nothing and the build renders nothing. A skipped step is logged by the worker as
 * "Null Shape detected in sceneShapes; skipping" (CascadeWorker.js:218), which is not a build failure.
 */
function unbuilt(step: Step, names: Names): Built {
	const why =
		step.kind === "extrude"
			? "a sketch on a face has no stored 3D anchor yet (Task 12)"
			: `kind "${step.type}" cannot be read`;
	const shape = `s${++names.s}`;
	return { lines: [`const ${shape} = null; // ${why}`], shape };
}

/** One sketch entity as a closed ring of model points. The closing repeat a stroke carries is dropped:
 *  `Polygon` joins the last point back to the first (StandardLibrary.js:78), and a zero-length edge there
 *  makes the face null. */
function ring(entity: Entity, sketch: Sketch, frame: Frame2): string {
	const points = entity.kind === "circle" ? circle(entity, sketch, frame) : flatten(entity.points, sketch, frame);
	return `[${points.map(vec).join(",")}]`;
}
/** A circle reaches the kernel as points too: `Circle()` is always built at the origin facing +Z, so it cannot
 *  sit on an offset or tilted plane. Segments keep the sag under 1 µm, capped so a large arc cannot print
 *  thousands of coordinates. */
function circle(entity: Extract<Entity, { kind: "circle" }>, sketch: Sketch, frame: Frame2): Vec3[] {
	const centre = [mm(sketch.origin[0]) + mm(entity.centre[0]), mm(sketch.origin[1]) + mm(entity.centre[1])];
	const radius = mm(entity.radius);
	const segments = Math.min(256, Math.max(12, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.001, radius) / radius))));
	return Array.from({ length: segments }, (_, i): [number, number] => {
		const angle = (2 * Math.PI * i) / segments;
		return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
	}).map((q) => unproject(q, frame));
}

/** Plane µm → model mm: the sketch's own origin rides on the plane origin, then the frame lifts the pair. */
function flatten(points: [Umm, Umm][], sketch: Sketch, frame: Frame2): Vec3[] {
	const [ox, oy] = [mm(sketch.origin[0]), mm(sketch.origin[1])];
	const closed = points.length > 1 && same(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
	return closed.map((q) => unproject([ox + mm(q[0]), oy + mm(q[1])], frame));
}

const same = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1];

/** A coordinate in script text. Rounded at 1 nm — the kernel's fuzz is 1e-7 mm, so anything finer is noise —
 *  and printed by `String`, which never leaves a trailing zero. */
const pct = (v: number): string => {
	const nm = Math.round(v * 1e6) / 1e6;
	return String(Object.is(nm, -0) ? 0 : nm);
};

const vec = (v: Vec3): string => `[${v.map(pct).join(",")}]`;

const isOp = (line: string): boolean => /^const \w+ = (Polygon|MakeFace|Extrude|Difference|Union)\(/.test(line);

/** One measurement, on one line, that cannot fail the build: the `try` covers a host that never defined `__b`
 *  and a shape that was skipped, so a probe reads as null and the geometry still renders.
 *  The helper's contract is `__b(buildId, stepId, kind, value)`. */
function probeLine(probe: Probe, buildId: string, shapeOf: Map<string, string>, last: { stepId: string; shape: string } | null): string {
	const stepId = probe.target?.step ?? last?.stepId ?? "";
	const shape = probe.target ? shapeOf.get(probe.target.step) : (last?.shape ?? null);
	return `try { __b(${JSON.stringify(buildId)}, ${JSON.stringify(stepId)}, "${probe.kind}", ${measure(probe.kind, probe.target, shape)}); } catch { /* a probe must never fail the build */ }`;
}

/** The kernel's own measurement call. `Faces`/`Edges` only walk topology, so none of these lines is an op. */
function measure(kind: Probe["kind"], target: TopoRef | undefined, shape: string | null | undefined): string {
	if (!shape) return "null";
	const whole = kind === "volume" ? `Volume(${shape})` : kind === "surface" ? `SurfaceArea(${shape})` : `EdgeLength(${shape})`;
	const element =
		target?.role === "face" && kind === "surface"
			? `_faceArea(Faces(${shape}).faces()[${target.index}])`
			: target?.role === "edge" && kind === "edgeLength"
				? `_edgeLength(Edges(${shape}).edges()[${target.index}])`
				: null;
		// A skipped step threads null, so its probe reports null rather than calling into the kernel.
		return `${shape} ? ${element ?? whole} : null`;
}
