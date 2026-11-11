// The CAD workspace is one surface: the pen owns the whole window, so nothing else may take the middle of it.
//
// This file is composition, and until Task 10 it is also the whole tool: a strip of buttons, the pending
// sketch's ink, the step chips that stand in for the history panel, and the one floating element the spec
// allows — the dimension field. The rules live elsewhere: `app/sketch-tool.ts` turns pixels into a document,
// `app/viewport.ts` draws, and the rebuild is `kernel/rebuild.ts`'s.
import { LitElement, html, nothing } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";
// The viewer must be imported for its side effect, not for the name: `customElements.define("cad-viewer", …)`
// lives at the bottom of that file, and a value import the bundler can drop leaves the tag registered by
// nobody — the element sits in the DOM un-upgraded, `renderRoot` empty, and `cad-viewer {}` CSS is the only
// proof anything was there. dist/ showed `defined: false` while `cad-dimension-field`, imported for its side
// effect one line down, was fine.
import "./app/viewport.ts";
import type { CadViewer } from "./app/viewport.ts";
import "./app/dimension-field.ts";
import type { CadDimensionField } from "./app/dimension-field.ts";
import { appendInk, startSketch, type SketchSession } from "./app/sketch-tool.ts";
// VIEWS is a value, so the module survives bundling. The element's registration is a different matter:
// customElements.define("cad-tools", …) sits at the bottom of tools-panel.ts, and an import that only takes a
// type can be dropped by the bundler — the lesson Task 9 learned with cad-viewer. So the element is imported
// for its side effect on its own line, and e2e/tools.spec.ts asserts the tag is defined.
import "./app/tools-panel.ts";
import { VIEWS } from "./app/tools-model.ts";
import type { Mode } from "./app/tools-model.ts";
import { removeStep } from "./model/doc.ts";
import { DocState, commitPending } from "./app/doc-state.ts";
import { historyStyles, stepChips } from "./app/history-strip.ts";
import { layoutStyles } from "./app/layout.ts";
import { isTyping, shortcutFor } from "./app/shortcuts.ts";
import type { InkPoint } from "./view/gestures.ts";
import { mm, um } from "./model/units.ts";
import type { CadDocument, PlaneRef } from "./model/types.ts";
import type { Umm } from "./model/units.ts";
import { KernelClient } from "./kernel/client.ts";
import { Rebuilder } from "./kernel/rebuild.ts";

/** v1.0's only sketch plane until the tool panel offers the others (Task 10). */
const XY: PlaneRef = { kind: "axis", axis: "XY", offset: 0 };

export class AppMain extends LitElement {
	static properties = {
		status: { state: true },
		field: { state: true },
		building: { state: true },
	};

	static styles = [sharedStyles, historyStyles, layoutStyles];

	/** The document, as the app holds it. e2e reads it straight off the element: under `?kernel=fake` the mesh
	 *  on screen is the worker's canned box, so the only geometry claim a browser test can make is about what
	 *  this document stored. */
	/** The model, the pending sketch and the selection, in one place. e2e reads `doc` straight off the element:
	 *  under ?kernel=fake the mesh on screen is the worker's canned box, so the only geometry claim a browser
	 *  test can make is about what this document stored. */
	private state = new DocState();

	private viewer!: CadViewer;
	private session: SketchSession | null = null;
	/** The stroke the pen is on right now, in client px, with the coalesced tails already deduped. */
	private buffer: InkPoint[] = [];
	private last: InkPoint | null = null;
	field: { mm?: number } | null = null;
	status = "";
	/** True while a build is in flight: what greys the panel's mutating buttons out. */
	building = false;
	private mode: Mode = "sketch";
	/** The depth the last commit used, in mm, so the field and the panel agree on what is in the box. */
	private depthMm = 12;
	private kernel: KernelClient | null = null;
	private rebuilder: Rebuilder | null = null;
	/** Builds in flight. The panel's mutating buttons are disabled while it is above zero. */
	private inflight = 0;

	protected firstUpdated(): void {
		this.wire();
		this.newSketch();
	}

	connectedCallback(): void {
		super.connectedCallback();
		// `disconnectedCallback` took the window's keydown listener and the viewer's cad-stroke listener away,
		// and Lit will not run `firstUpdated` again after a re-connect: a moved app-main came back deaf to the
		// keyboard. Only the listeners are re-armed — the session is left alone, so an in-progress sketch is
		// not silently thrown away by a re-parent. `hasUpdated` keeps the first connect as firstUpdated's.
		if (this.hasUpdated) this.wire();
	}

	private wire(): void {
		this.viewer = this.renderRoot.querySelector("cad-viewer") as CadViewer;
		window.__CAD_VIEWER__ = this.viewer;
		this.viewer.addEventListener("cad-stroke", this.onStroke);
		addEventListener("keydown", this.onKey);
		this.state.addEventListener("change", this.onDocChange);
		// A pending sketch is not an edit: it must repaint the panel without starting a build. Missing this is
		// how the Extrude and Cut buttons never appeared, even though the ring had closed and the state held it.
		this.state.addEventListener("pending", this.onPending);
		this.state.addEventListener("select", this.onPending);
		if (this.session) this.viewer.frame = this.session.frame;
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		this.viewer?.removeEventListener("cad-stroke", this.onStroke);
		removeEventListener("keydown", this.onKey);
		this.state.removeEventListener("change", this.onDocChange);
		this.state.removeEventListener("pending", this.onPending);
		this.state.removeEventListener("select", this.onPending);
	}

	private readonly onPending = (): void => {
		this.requestUpdate();
	};

	/** The document's own getter, kept for the tests: the model belongs to `state` now. */
	get doc(): CadDocument {
		return this.state.doc;
	}

	/** One door out of the model, and one door into the kernel: panels never start a build themselves, or a
	 *  failed rebuild leaves the history row and the canvas describing different documents. */
	private readonly onDocChange = (): void => {
		this.building = true;
		this.requestUpdate();
		void this.rebuild();
	};

	/** A fresh sketch on the XY plane: the tool's own frame is the viewer's ink frame, or committed entities
	 *  would be drawn in a plane the pencil was not on. */
	private newSketch(): void {
		this.session = startSketch(XY, undefined, this.viewer);
		this.viewer.frame = this.session.frame;
		this.viewer.ink = [];
		this.state.setPending(null);
		this.buffer = [];
		this.field = null;
		this.requestUpdate();
	}

	private readonly onStroke = (event: Event): void => {
		const detail = (event as CustomEvent<{ phase: string; points: InkPoint[] }>).detail;
		// Only the pen draws, and only in sketch mode: in select mode a stroke points at something, and Task 12
		// is what gives it something to point at. The comment said this for a task before the code did.
		if (this.mode !== "sketch") {
			if (detail.phase === "end") this.status = "select mode picks a face in Task 12; the pencil draws in sketch mode";
			return;
		}
		if (detail.phase === "start") this.buffer = detail.points;
		else this.buffer = appendInk(this.buffer, detail.points);
		if (detail.phase !== "end") return;
		// `move` and `end` both carry the coalesced tail, so the lift is appended, not counted again.
		this.last = this.buffer[this.buffer.length - 1] ?? this.last;
		this.session?.stroke(this.buffer);
		this.buffer = [];
		// The ink stays as the sketch's entities, and the panel gains its Extrude and Cut buttons from the same
		// snapshot: one source, so a half-finished drawing cannot show a button that has nothing to build.
		const pending = this.session?.pending() ?? null;
		this.state.setPending(pending);
		this.viewer.ink = pending?.entities ?? [];
	};

	private readonly onKey = (event: KeyboardEvent): void => {
		// While the field is open the keyboard belongs to it: a typed digit is not a shortcut. This is the one
		// rule that needs app state; the rest of the key map and the "is someone typing" test are in
		// src/app/shortcuts.ts, where a Node test can hold them still.
		if (this.field) {
			if (event.key === "Escape") this.cancel();
			return;
		}
		if (isTyping(event)) return;
		const shortcut = shortcutFor(event);
		if (!shortcut) return;
		// Claiming the keystroke means preventing it; see shortcuts.ts for what E used to type into the field it
		// had just opened.
		event.preventDefault();
		if (shortcut === "new") this.newSketch();
		else if (shortcut === "depth") this.openDepth();
		else this.cancel();
	};

	/** Whatever the panel pressed that was not a commit: the two modes, the four views, and fit. */
	private readonly onTool = (event: Event): void => {
		const tool = (event as CustomEvent<{ tool: string }>).detail.tool;
		if (tool === "sketch" || tool === "select") {
			this.mode = tool;
			// Only the pen draws, and only in sketch mode: in select mode a stroke is a way of pointing at
			// something, and Task 12 is what gives it something to point at.
			if (tool === "sketch") this.newSketch();
			// `mode` is a plain field, not @state, so nothing here would repaint and the pressed ring on the button
			// would stay on whichever mode the page loaded in. Lit cannot see a plain assignment.
			this.requestUpdate();
			return;
		}
		if (tool === "fit") {
			// A part that has never been built has no bounds, and fitting a 0-box parks the eye 4 mm from the
			// origin: the canvas reads as empty, which is the failure the spec calls out by name. Say so instead.
			if (!this.viewer.fit()) this.status = "nothing to fit yet";
			this.requestUpdate();
			return;
		}
		if (tool in VIEWS) this.viewer.setView(VIEWS[tool as keyof typeof VIEWS]);
	};

	private readonly onCancel = (event: Event): void => {
		const tool = (event as CustomEvent<{ tool: string }>).detail.tool;
		if (tool === "delete") {
			const picked = this.state.selection;
			if (picked) this.state.apply((doc) => removeStep(doc, picked.id));
			return;
		}
		this.cancel();
	};

	private cancel(): void {
		this.session?.cancel();
		this.viewer.ink = [];
		this.state.setPending(null);
		this.buffer = [];
		this.field = null;
		this.requestUpdate();
	}

	private openDepth(): void {
		this.field = {};
		this.status = "";
		// Lit renders this on the next microtask. Focus happens in `updated()`, once the element exists, not
		// here and not in the field's own `firstUpdated`: a Lit child is constructed and its first update runs
		// while it is still detached from the document, and focusing an input inside a detached shadow tree is
		// a no-op that leaves the caret on `<body>`. `page.keyboard.type("12")` then typed into nothing and the
		// commit read an empty field — "type a depth in millimetres, above zero".
		this.requestUpdate();
	}

	protected updated(): void {
		if (!this.field) return;
		// The field's own shadow root, not ours: `querySelector` does not walk into a nested shadow tree, and a
		// one-level search from app-main finds the host element but never the `<input>` inside it.
		(this.renderRoot.querySelector("cad-dimension-field") as CadDimensionField | null)?.focusField();
	}

	private readonly fieldAt = (event: Event): void => {
		const mm = (event as CustomEvent<{ mm: number }>).detail.mm;
		if (!Number.isFinite(mm) || mm <= 0) {
			// The field stays open, because the number in it is the thing that was wrong and the user is one
			// edit away from fixing it. Closing it here made a mistyped depth cost a second press of E.
			this.status = "type a depth in millimetres, above zero";
			this.requestUpdate();
			return;
		}
		this.depthMm = mm;
		this.commit(false);
	};

	/** The panel's Extrude and Cut. Same path as the field and the keyboard, which is the point: a press and a
	 *  keystroke must not be able to disagree about what a commit costs. */
	private readonly panelCommit = (event: Event): void => {
		const detail = (event as CustomEvent<{ depth: number; cut: boolean }>).detail;
		this.commit(detail.cut, detail.depth);
	};

	/** A commit, with the rules that are not the document's business: what the sketch was, and what to say. */
	private commit(cut: boolean, depthUmm?: Umm): void {
		this.field = null;
		if (!this.session) return;
		// One depth, remembered. Without this the rail's box and the E field disagree: the panel converts what it
		// typed and app-main never stores it, so a 25 mm press followed by E+Enter builds a 12 mm part while the
		// box still reads 25 — the invariant this file states two lines above the handler, broken in practice.
		if (depthUmm !== undefined) {
			if (!Number.isFinite(depthUmm) || depthUmm <= 0) {
				// The rail's box holds what the browser accepted, and a number input with a raw value of "e" reads
				// back as "". Converting that gave um(NaN) = 0, so the press answered with "the depth must be a whole
				// positive number of micrometres" — true, and about a number nobody typed. The box stays open.
				this.status = "type a depth in millimetres, above zero";
				this.requestUpdate();
				return;
			}
			this.depthMm = mm(depthUmm);
		}
		try {
			this.state.setPending(this.session.sketch());
			if (!commitPending(this.state, { depth: depthUmm ?? um(this.depthMm), cut })) {
				this.status = "nothing to sketch";
				return;
			}
			// The ring has become a step, so the pencil forgets it. Order matters: the panel's pending sketch is
			// cleared by commitPending, and if the session still held the stroke a second press could rebuild it.
			this.session.consume();
			this.state.setPending(this.session.pending());
			this.viewer.ink = this.state.pending?.entities ?? [];
			this.status = `${cut ? "Cut" : "Extrude"} ${this.state.doc.steps.length} added`;
		} catch (e) {
			// A refused sketch stays drawn as ink, and the reason is said out loud: the spec's one anti-goal
			// that a tool can fall into by omission is a failure that reads as nothing happening.
			this.status = e instanceof Error ? e.message : String(e);
			this.viewer.ink = this.session.entities();
			this.requestUpdate();
		}
	}

	/** One kernel, started on the first build rather than on load: the page must not pull 21 MB to say hello. */
	private async rebuild(): Promise<void> {
		if (!this.kernel) {
			this.kernel = new KernelClient({
				workerUrl: window.__CAD_KERNEL__,
				onError: (e) => {
					this.status = e.message;
					this.requestUpdate();
				},
			});
			this.rebuilder = new Rebuilder(this.kernel);
		}
		this.inflight += 1;
		this.building = true;
		try {
			const result = await this.rebuilder?.request(this.doc);
			if (result) this.viewer.mesh = result.mesh;
			if (result && !result.ok) this.status = result.error;
		} catch (e) {
			this.status = e instanceof Error ? e.message : String(e);
		} finally {
			// A counter, not a boolean: two edits in the same frame start two requests, and the first one
			// finishing must not unlock the panel while the second is still in the kernel. Without this the
			// panel greyed itself out for good after the first build, which is how "Cut" sat disabled.
			this.inflight -= 1;
			this.building = this.inflight > 0;
		}
		this.requestUpdate();
	}

	render() {
		return html`
			<nav class="rail">
				<cad-tools
					.mode=${this.mode}
					.pending=${this.state.pending}
					.selection=${this.state.selection}
					.steps=${this.state.doc.steps.length}
					.busy=${this.building}
					.depthMm=${this.depthMm}
					@cad-commit-extrude=${this.panelCommit}
					@cad-tool=${this.onTool}
					@cad-cancel=${this.onCancel}
				></cad-tools>
			</nav>
			<div class="column">
				<div class="bar">
					<ol class="steps">
						${stepChips(this.state.doc.steps)}
					</ol>
					<p class="status" role="status">${this.status}</p>
				</div>
				<div class="stage"><cad-viewer></cad-viewer></div>
			</div>
			${this.field === null
				? nothing
				: html`<cad-dimension-field
						open
						.mm=${this.field.mm ?? this.depthMm}
						style=${`left:${this.last?.x ?? 0}px; top:${this.last?.y ?? 0}px`}
						@cad-dimension=${this.fieldAt}
					></cad-dimension-field>`}
		`;
	}
}

customElements.define("app-main", AppMain);
