import type { CadDocument, Entity, PlaneRef, Sketch, Step } from "./types.ts";
import type { Umm } from "./units.ts";

/** Counted while a document is repaired, so a rounded distance can be reported rather than hidden. */
type Repair = { rounded: number };

/** A document's placeholder title, so one that lost its name never reads as blank in a list. */
const UNTITLED = "Untitled";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAxis = (v: unknown): v is "XY" | "XZ" | "YZ" => v === "XY" || v === "XZ" || v === "YZ";
const isRole = (v: unknown): v is "face" | "edge" => v === "face" || v === "edge";

/** A distance in µm: rounded to a whole µm, and dropped when the document cannot hold that number. */
const dist = (v: unknown, repair: Repair): number | null => {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const r = Math.round(v);
	if (!Number.isSafeInteger(r)) return null;
	if (r !== v) repair.rounded += 1;
	return r;
};

/** An index into one operation's output order: not a distance, so it is never rounded. */
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

const pair = (v: unknown, repair: Repair): [Umm, Umm] | null => {
	if (!Array.isArray(v) || v.length !== 2) return null;
	const x = dist(v[0], repair);
	const y = dist(v[1], repair);
	return x === null || y === null ? null : [x, y];
};

const triple = (v: unknown, repair: Repair): [Umm, Umm, Umm] | null => {
	if (!Array.isArray(v) || v.length !== 3) return null;
	const x = dist(v[0], repair);
	const y = dist(v[1], repair);
	const z = dist(v[2], repair);
	return x === null || y === null || z === null ? null : [x, y, z];
};

export function newId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

export function newDocument(name = UNTITLED): CadDocument {
	return { schema: 1, name, steps: [] };
}

export function stepById(doc: CadDocument, id: string): Step | undefined {
	return doc.steps.find((s) => s.id === id);
}

export function indexOfStep(doc: CadDocument, id: string): number {
	return doc.steps.findIndex((s) => s.id === id);
}

/** Adds an extrude after `afterId`, or at the end when there is no anchor to read. */
export function insertExtrude(
	doc: CadDocument,
	afterId: string | null,
	sketch: Sketch,
	depth: Umm,
	cut: boolean,
): { doc: CadDocument; id: string } {
	const id = newId("step");
	const step: Step = { id, kind: "extrude", name: cut ? "Cut" : "Extrude", sketch, depth, cut };
	const anchor = afterId === null ? -1 : indexOfStep(doc, afterId);
	const at = anchor < 0 ? doc.steps.length : anchor + 1;
	return { doc: { ...doc, steps: [...doc.steps.slice(0, at), step, ...doc.steps.slice(at)] }, id };
}

export function replaceStep(doc: CadDocument, id: string, step: Step): CadDocument {
	// The row keeps the id it already had: dependents point at it through sketch.plane.face.step.
	return { ...doc, steps: doc.steps.map((s) => (s.id === id ? { ...step, id } : s)) };
}

export function removeStep(doc: CadDocument, id: string): CadDocument {
	// Dependents keep the reference they had, which is what makes them show as broken rather than move.
	return { ...doc, steps: doc.steps.filter((s) => s.id !== id) };
}

/**
 * Why a step cannot build, as a short machine-readable reason plus the offending kind. A step is broken
 * when its parent is gone, later in the history than it is, or broken itself: the script builder walks the
 * steps in document order, so anything that does not resolve to an earlier healthy operation cannot build.
 */
export function brokenSteps(doc: CadDocument): { id: string; reason: "unknown kind" | "parent removed"; type?: string }[] {
	const found: { id: string; reason: "unknown kind" | "parent removed"; type?: string }[] = [];
	const row = new Map(doc.steps.map((s, i) => [s.id, i]));
	const broken = new Set<string>();
	doc.steps.forEach((step, i) => {
		if (step.kind === "unknown") {
			broken.add(step.id);
			found.push({ id: step.id, reason: "unknown kind", type: step.type });
			return;
		}
		const plane = step.sketch.plane;
		if (plane.kind !== "face") return;
		const parent = plane.face.step;
		const at = row.get(parent);
		if (at === undefined || at >= i || broken.has(parent)) {
			broken.add(step.id);
			found.push({ id: step.id, reason: "parent removed" });
		}
	});
	return found;
}

/**
 * Reads stored JSON into a document, reporting every repair. A step this version cannot read keeps its
 * fields and comes back as `unknown`, so re-saving a document written by a later version loses nothing.
 */
export function normalize(json: unknown): { doc: CadDocument; problems: string[] } {
	const problems: string[] = [];
	let value = json;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return { doc: newDocument(), problems: ["document: not valid JSON"] };
		}
	}
	if (!isObject(value)) return { doc: newDocument(), problems: ["document: not an object"] };
	if (value.schema !== 1) problems.push(`document: schema ${String(value.schema)} is not 1`);
	let name: string;
	if (typeof value.name === "string" && value.name !== "") {
		name = value.name;
	} else {
		problems.push("document: missing name");
		name = UNTITLED;
	}
	const list = Array.isArray(value.steps) ? value.steps : null;
	if (!list) problems.push("document: steps is not an array");
	const seen = new Set<string>();
	const steps = (list ?? []).map((entry, i) => normalizeStep(entry, i, problems, seen));
	return { doc: { schema: 1, name, steps }, problems };
}

function normalizeStep(entry: unknown, index: number, problems: string[], seen: Set<string>): Step {
	if (!isObject(entry)) {
		problems.push(`step ${index}: not an object`);
		return { id: newId("step"), kind: "unknown", type: "invalid" };
	}
	let id: string;
	if (typeof entry.id === "string" && entry.id !== "") {
		id = entry.id;
	} else {
		problems.push(`step ${index}: missing id`);
		id = newId("step");
	}
	// Two rows sharing an id cannot be told apart by removeStep or replaceStep, so the second becomes its own step.
	if (seen.has(id)) {
		problems.push(`step ${id}: duplicate id`);
		id = newId("step");
	}
	seen.add(id);
	if (entry.kind === "extrude") return normalizeExtrude(entry, id, problems);
	if (entry.kind === "unknown") {
		return { ...entry, id, kind: "unknown", type: typeof entry.type === "string" ? entry.type : "unknown" };
	}
	// The kind we could not read becomes the step's type, so the row can still say what it was.
	if (typeof entry.kind !== "string") problems.push(`step ${id}: missing kind`);
	else problems.push(`step ${id}: unknown kind ${entry.kind}`);
	return { ...entry, id, kind: "unknown", type: typeof entry.kind === "string" ? entry.kind : "unknown" };
}

function normalizeExtrude(raw: Record<string, unknown>, id: string, problems: string[]): Step {
	const repair: Repair = { rounded: 0 };
	const sketch = normalizeSketch(raw.sketch, repair);
	const depth = dist(raw.depth, repair);
	const cut = typeof raw.cut === "boolean" ? raw.cut : null;
	// A zero-depth extrude builds no solid, so it reads as a broken step instead of an empty one.
	if (!sketch || depth === null || depth === 0 || cut === null) {
		problems.push(`step ${id}: invalid extrude step`);
		return { ...raw, id, kind: "unknown", type: "extrude" };
	}
	if (repair.rounded > 0) {
		problems.push(`step ${id}: ${repair.rounded} distance${repair.rounded > 1 ? "s" : ""} rounded to µm`);
	}
	const name = typeof raw.name === "string" ? raw.name : "";
	return { ...raw, id, kind: "extrude", name, sketch, depth, cut };
}

function normalizeSketch(raw: unknown, repair: Repair): Sketch | null {
	if (!isObject(raw) || !Array.isArray(raw.entities)) return null;
	const plane = normalizePlane(raw.plane, repair);
	const origin = pair(raw.origin, repair);
	const axes = Array.isArray(raw.axes) && raw.axes.length === 2 ? raw.axes : null;
	const u = axes ? triple(axes[0], repair) : null;
	const v = axes ? triple(axes[1], repair) : null;
	if (!plane || !origin || !u || !v) return null;
	const entities: Entity[] = [];
	for (const entity of raw.entities) {
		const kept = normalizeEntity(entity, repair);
		if (!kept) return null;
		entities.push(kept);
	}
	const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : newId("sketch");
	return { ...raw, id, plane, origin, axes: [u, v], entities };
}

function normalizePlane(raw: unknown, repair: Repair): PlaneRef | null {
	if (!isObject(raw)) return null;
	if (raw.kind === "axis") {
		// An axis plane written without an offset is that plane through the origin.
		const offset = raw.offset === undefined ? 0 : dist(raw.offset, repair);
		return isAxis(raw.axis) && offset !== null ? { kind: "axis", axis: raw.axis, offset } : null;
	}
	const face = isObject(raw.face) ? raw.face : null;
	if (raw.kind !== "face" || !face) return null;
	const index = whole(face.index);
	return typeof face.step === "string" && isRole(face.role) && index !== null
		? { kind: "face", face: { step: face.step, role: face.role, index } }
		: null;
}

function normalizeEntity(raw: unknown, repair: Repair): Entity | null {
	if (!isObject(raw)) return null;
	if (raw.kind === "poly") {
		if (!Array.isArray(raw.points)) return null;
		const points: [Umm, Umm][] = [];
		for (const point of raw.points) {
			const kept = pair(point, repair);
			if (!kept) return null;
			points.push(kept);
		}
		return { ...raw, kind: "poly", points };
	}
	if (raw.kind === "circle") {
		const centre = pair(raw.centre, repair);
		const radius = dist(raw.radius, repair);
		// A circle that encloses nothing has no face to extrude.
		return centre && radius !== null && radius > 0 ? { ...raw, kind: "circle", centre, radius } : null;
	}
	return null;
}
