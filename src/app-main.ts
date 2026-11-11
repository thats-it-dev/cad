// The CAD workspace is one surface: the pen owns the whole window, so nothing else may take the middle of it.
//
// This file is composition, and until Task 10 it is also the whole tool: a strip of buttons, the pending
// sketch's ink, the step chips that stand in for the history panel, and the one floating element the spec
// allows — the dimension field. The rules live elsewhere: `app/sketch-tool.ts` turns pixels into a document,
// `app/viewport.ts` draws, and the rebuild is `kernel/rebuild.ts`'s.
import { LitElement, css, html, nothing } from "https://kit.thatsit.app/lit.js";
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
import type { InkPoint } from "./view/gestures.ts";
import { insertExtrude, newDocument } from "./model/doc.ts";
import { um } from "./model/units.ts";
import type { CadDocument, PlaneRef, Step } from "./model/types.ts";
import { KernelClient } from "./kernel/client.ts";
import { Rebuilder } from "./kernel/rebuild.ts";

/** v1.0's only sketch plane until the tool panel offers the others (Task 10). */
const XY: PlaneRef = { kind: "axis", axis: "XY", offset: 0 };

/** A row of the history strip: the step's own name, numbered by its place, and how many corners its sketch
 *  has — the number Task 9's e2e reads to prove a six-point stroke became a four-corner ring. */
function corners(step: Step): number {
	if (step.kind !== "extrude") return 0;
	return step.sketch.entities.reduce((n, e) => {
		if (e.kind === "circle") return n + 1;
		const closed = e.points.length > 1 && samePoint(e.points[0], e.points[e.points.length - 1]);
		return n + e.points.length - (closed ? 1 : 0);
	}, 0);
}

const samePoint = (a: [number, number] | undefined, b: [number, number] | undefined): boolean => !!a && !!b && a[0] === b[0] && a[1] === b[1];

export class AppMain extends LitElement {
	static properties = {
		doc: { type: Object },
		status: { state: true },
		field: { state: true },
	};

	static styles = [
		sharedStyles,
		css`
			:host {
				display: flex;
				flex-direction: column;
				position: fixed;
				inset: 0;
			}
			.bar {
				display: flex;
				align-items: center;
				gap: 8px;
				flex: none;
				padding: 4px 8px;
			}
			.steps {
				display: flex;
				gap: 6px;
				list-style: none;
				margin: 0;
				padding: 0;
				overflow: hidden;
			}
			.chip {
				white-space: nowrap;
				font-size: 13px;
				padding: 2px 8px;
				border: 1px solid currentColor;
				border-radius: 999px;
			}
			.status {
				margin: 0 0 0 auto;
				font-size: 13px;
			}
			.stage {
				position: relative;
				flex: 1;
				min-height: 0;
			}
			cad-viewer {
				display: block;
				width: 100%;
				height: 100%;
			}
		`,
	];

	/** The document, as the app holds it. e2e reads it straight off the element: under `?kernel=fake` the mesh
	 *  on screen is the worker's canned box, so the only geometry claim a browser test can make is about what
	 *  this document stored. */
	doc: CadDocument = newDocument();

	private viewer!: CadViewer;
	private session: SketchSession | null = null;
	/** The stroke the pen is on right now, in client px, with the coalesced tails already deduped. */
	private buffer: InkPoint[] = [];
	private last: InkPoint | null = null;
	field: { mm?: number } | null = null;
	status = "";
	private kernel: KernelClient | null = null;
	private rebuilder: Rebuilder | null = null;

	protected firstUpdated(): void {
		this.viewer = this.renderRoot.querySelector("cad-viewer") as CadViewer;
		window.__CAD_VIEWER__ = this.viewer;
		this.viewer.addEventListener("cad-stroke", this.onStroke);
		addEventListener("keydown", this.onKey);
		this.newSketch();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		this.viewer?.removeEventListener("cad-stroke", this.onStroke);
		removeEventListener("keydown", this.onKey);
	}

	/** A fresh sketch on the XY plane: the tool's own frame is the viewer's ink frame, or committed entities
	 *  would be drawn in a plane the pencil was not on. */
	private newSketch(): void {
		this.session = startSketch(XY, undefined, this.viewer);
		this.viewer.frame = this.session.frame;
		this.viewer.ink = [];
		this.buffer = [];
		this.field = null;
		this.requestUpdate();
	}

	private readonly onStroke = (event: Event): void => {
		const detail = (event as CustomEvent<{ phase: string; points: InkPoint[] }>).detail;
		if (detail.phase === "start") this.buffer = detail.points;
		else this.buffer = appendInk(this.buffer, detail.points);
		if (detail.phase !== "end") return;
		// `move` and `end` both carry the coalesced tail, so the lift is appended, not counted again.
		this.last = this.buffer[this.buffer.length - 1] ?? this.last;
		this.session?.stroke(this.buffer);
		this.buffer = [];
		this.viewer.ink = this.session?.entities() ?? [];
	};

	private readonly onKey = (event: KeyboardEvent): void => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		// While the field is open the keyboard belongs to it: a typed digit is not a shortcut.
		if (this.field) {
			if (event.key === "Escape") this.cancel();
			return;
		}
		const key = event.key.toLowerCase();
		if (key === "s" || key === "n") this.newSketch();
		else if (key === "e") this.openDepth();
		else if (key === "escape") this.cancel();
	};

	private cancel(): void {
		this.session?.cancel();
		this.viewer.ink = [];
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
		this.field = null;
		if (!Number.isFinite(mm) || mm <= 0) {
			this.status = "type a depth in millimetres, above zero";
			return;
		}
		const session = this.session;
		if (!session) return;
		let step: Step;
		try {
			step = session.commit(um(mm), false);
		} catch (e) {
			// A refused sketch stays drawn as ink, and the reason is said out loud: the spec's one anti-goal
			// that a tool can fall into by omission is a failure that reads as nothing happening.
			this.status = e instanceof Error ? e.message : String(e);
			this.viewer.ink = session.entities();
			return;
		}
		this.viewer.ink = session.entities();
		this.doc = insertExtrude(this.doc, null, step.sketch, step.depth, step.cut).doc;
		this.status = `${step.name} ${this.doc.steps.length} added`;
		void this.rebuild();
	};

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
		try {
			const result = await this.rebuilder?.request(this.doc);
			if (result) this.viewer.mesh = result.mesh;
			if (result && !result.ok) this.status = result.error;
		} catch (e) {
			this.status = e instanceof Error ? e.message : String(e);
		}
		this.requestUpdate();
	}

	render() {
		return html`
			<div class="bar">
				<button class="btn" @click=${this.newSketch}>Sketch</button>
				<button class="btn" @click=${this.openDepth}>Extrude</button>
				<ol class="steps">
					${this.doc.steps.map((step, i) => html`<li class="chip" data-sketch-points=${corners(step)}>${step.kind === "extrude" ? step.name : step.type} ${i + 1}</li>`)}
				</ol>
				<p class="status" role="status">${this.status}</p>
			</div>
			<div class="stage"><cad-viewer></cad-viewer></div>
			${this.field === null
				? nothing
				: html`<cad-dimension-field
						open
						.mm=${this.field.mm}
						style=${`left:${this.last?.x ?? 0}px; top:${this.last?.y ?? 0}px`}
						@cad-dimension=${this.fieldAt}
					></cad-dimension-field>`}
		`;
	}
}

customElements.define("app-main", AppMain);
