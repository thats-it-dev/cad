// The one door through which the document changes. Task 10's whole reason for existing: before it, `app-main`
// held `doc` as a private field and every panel kept its own idea of what was on screen, so a failed build
// left the history chip row and the canvas disagreeing about how many steps there were.
import { brokenSteps, insertExtrude, newDocument, newId } from "../model/doc.ts";
import type { Umm } from "../model/units.ts";
import type { CadDocument, Entity, PlaneRef, Sketch } from "../model/types.ts";

/** What the pencil has drawn and the model has not taken yet: a sketch without an id, in the frame it was drawn in. */
export type Pending = { plane: PlaneRef; origin: [Umm, Umm]; axes: [[Umm, Umm, Umm], [Umm, Umm, Umm]]; entities: Entity[] };

export type Selection = { kind: "step"; id: string } | null;

export type CommitOptions = { depth: Umm; cut: boolean };

/** Why `change` is worth a class rather than a field: the reason is reported on the event, and the panels
 *  that render from it cannot see a document that is half-applied. */
export class DocState extends EventTarget {
	private current: CadDocument;
	private sketch: Pending | null = null;
	private picked: Selection = null;
	private broke: ReturnType<typeof brokenSteps> = [];

	constructor(doc: CadDocument = newDocument()) {
		super();
		this.current = doc;
		this.broke = brokenSteps(this.current);
	}

	get doc(): CadDocument {
		return this.current;
	}

	get pending(): Pending | null {
		return this.sketch;
	}

	get selection(): Selection {
		return this.picked;
	}

	/** Steps the document cannot build, recomputed from the document on every change, never cached by a panel. */
	get broken(): ReturnType<typeof brokenSteps> {
		return this.broke;
	}

	/** Every mutation goes here. The mutator returns the document it wants — the same object means "nothing
	 *  happened", and then nothing is announced either, which is what keeps a no-op Edit from rebuilding. */
	apply(mut: (doc: CadDocument) => CadDocument): void {
		const next = mut(this.current);
		if (next === this.current) return;
		this.current = next;
		this.broke = brokenSteps(next);
		this.dispatchEvent(new CustomEvent("change", { detail: next }));
	}

	/** The ink the pencil left, or null once it has become a step or been discarded. */
	setPending(sketch: Pending | null): void {
		this.sketch = sketch;
		this.dispatchEvent(new CustomEvent("pending"));
	}

	select(picked: Selection): void {
		this.picked = picked;
		this.dispatchEvent(new CustomEvent("select"));
	}
}

/**
 * Turn what is pending into a step.
 *
 * Returns false rather than throwing when there is nothing pending, because that is the double-press: the
 * button is already gone from the panel, but a queued click, a keyup and a second tap on the iPad all reach
 * here, and a step must not appear twice. The check is here, not in the panel, so the keyboard path is held to
 * the same rule as the button.
 *
 * A depth that builds nothing throws with its reason, and the pending sketch survives: the drawing is the
 * expensive thing, and losing it to a mistyped number is how a tool gets switched off.
 */
export function commitPending(state: DocState, options: CommitOptions): boolean {
	const sketch = state.pending;
	if (!sketch || sketch.entities.length === 0) return false;
	assertDepth(options.depth);
	// Drop the pending sketch *before* the document changes. `apply` dispatches `change` synchronously, and a
	// listener that throws — the kernel client it starts on the first build is one — would otherwise unwind
	// here with the step already in the document and the ring still pending, which is two steps for one gesture
	// on the next press. The bad half of that is losing a drawing, not duplicating a solid.
	state.setPending(null);
	const step = insertSketch(state.doc, sketch, options);
	state.apply(() => step.doc);
	return true;
}

/** Shared with the session's own commit, so the two paths cannot drift apart on what a legal depth is. */
export function assertDepth(depth: Umm): void {
	if (!Number.isInteger(depth) || depth <= 0) throw new Error("the depth must be a whole positive number of micrometres");
}

function insertSketch(doc: CadDocument, sketch: Pending, options: CommitOptions): { doc: CadDocument; id: string } {
	const full: Sketch = { id: newId("sketch"), plane: sketch.plane, origin: sketch.origin, axes: sketch.axes, entities: sketch.entities };
	// The document module makes the step, because the name ("Extrude"/"Cut") and the id rule live there — and
	// it is appended, not inserted after the selection: in v1 a step always lands on the end of the history,
	// and Task 11 is what lets a selected step become an anchor.
	return insertExtrude(doc, null, full, options.depth, options.cut);
}
