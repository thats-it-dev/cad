// `<cad-tools>`: the panel, rendered. Its rules are in `tools-model.ts` — a module that imports the kit's Lit
// cannot be loaded by vitest (its ESM loader only takes file: and data: URLs), so if the rules lived here they
// could only be tested in a browser.
//
// The element turns a press into an event and nothing else. It never touches a document: it has no idea how to
// build one, which is what keeps it from disagreeing with the canvas about what is on screen.
import { css, html, LitElement } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";
import { iconBox, iconCut, iconFit, iconFront, iconIso, iconPencil, iconPointer, iconRight, iconTop, iconTrash } from "./icons.ts";
import { um } from "../model/units.ts";
import { DEFAULT_DEPTH_MM, toolsFor, type Mode, type Tool, type ToolId } from "./tools-model.ts";
import type { Pending, Selection } from "./doc-state.ts";

export type { Mode } from "./tools-model.ts";

/** The icon for each id. Hand-drawn geometry, inlined: see src/app/icons.ts for why not a dependency. */
const ICONS: Partial<Record<ToolId, typeof iconPencil>> = {
	sketch: iconPencil,
	select: iconPointer,
	extrude: iconBox,
	cut: iconCut,
	delete: iconTrash,
	front: iconFront,
	top: iconTop,
	right: iconRight,
	iso: iconIso,
	fit: iconFit,
};

/** Rail order: the tool, then what it can do to the document, then the camera. */
const GROUPS: ToolId[][] = [
	["sketch", "select"],
	["depth", "extrude", "cut", "delete"],
	["front", "top", "right", "iso", "fit"],
];

/**
 * `<cad-tools>` — the nav-slot panel. It renders `toolsFor` and turns a press into an event; it never touches
 * a document, because it has no idea how to build one.
 */
export class CadTools extends LitElement {
	static properties = {
		mode: { state: true },
		pending: { state: true },
		selection: { state: true },
		busy: { state: true },
		steps: { state: true },
		depthMm: { state: true },
	};

	static styles = css`
		${sharedStyles}
		/* 64 px of rail, so the groups stack: a row of five 36 px buttons would not fit, and the rail is what
		   gives the pen the rest of the window. */
		:host { display: flex; flex-direction: column; gap: 12px; padding: 8px 6px; align-items: stretch; }
		.group { display: flex; flex-direction: column; gap: 6px; align-items: center; }
		button[aria-pressed="true"] { color: var(--accent); }
		label { display: flex; flex-direction: column; gap: 2px; align-items: center; color: var(--text-secondary); font-size: 0.6rem; }
		input { width: 3.4rem; font: inherit; padding: 3px 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text-primary); }
	`;

	declare mode: Mode;
	declare pending: Pending | null;
	declare selection: Selection;
	declare busy: boolean;
	declare steps: number;
	declare depthMm: number;

	constructor() {
		super();
		this.mode = "sketch";
		this.pending = null;
		this.selection = null;
		this.busy = false;
		this.steps = 0;
		this.depthMm = DEFAULT_DEPTH_MM;
	}

	render() {
		const tools = toolsFor({ mode: this.mode, pending: this.pending, selection: this.selection, steps: this.steps, busy: this.busy });
		const inGroup = (ids: ToolId[]) => tools.filter((t) => ids.includes(t.id));
		return html`${GROUPS.map((ids) => html`<div class="group">${inGroup(ids).map((t) => this.cell(t))}</div>`)}`;
	}

	/** One cell of the panel. A depth box or an icon button, decided by the model, never by the element. */
	private cell(t: Tool) {
		if (t.kind === "depth") {
			return html`<label>${t.label}<input type="number" min="0.001" step="any" data-tool="depth" ?disabled=${!t.enabled} @input=${this.onDepth} /></label>`;
		}
		return html`<button
			class="icon-btn"
			data-tool=${t.id}
			title=${t.label}
			aria-label=${t.label}
			aria-pressed=${String(t.pressed)}
			?disabled=${!t.enabled}
			@click=${() => this.press(t.id)}
		>
			${ICONS[t.id]}
		</button>`;
	}

	protected firstUpdated(): void {
		this.syncDepth();
	}

	protected updated(): void {
		// Synced on every update, not once in firstUpdated: `toolsFor` only offers the box when a ring is pending,
		// so at first render there was no input to fill. The rail showed an empty box while a press committed
		// app-main's default 12 mm, which is a lie in a number field.
		this.syncDepth();
	}

	private syncDepth(): void {
		const input = this.renderRoot.querySelector("input[data-tool='depth']") as HTMLInputElement | null;
		if (!input) return;
		// Never bound with `.value=${…}`: a Lit part re-commits on every render and erases what the user typed,
		// which is how Task 9's dimension field lost each keystroke. Writing it only when empty is the same
		// guarantee with the box still able to appear already filled.
		if (input.value.trim() === "") input.value = String(this.depthMm);
	}

	private readonly onDepth = (event: Event): void => {
		const raw = (event.target as HTMLInputElement).value;
		this.depthMm = raw.trim() === "" ? Number.NaN : Number(raw);
	};

	private press(id: ToolId): void {
		if (id === "extrude" || id === "cut") {
			// The mm→µm conversion happens here, at the only place that knows a depth was typed in millimetres.
			// A panel that sent mm and let the host multiply is one refactor away from a part 1000× too big.
			this.dispatchEvent(new CustomEvent("cad-commit-extrude", { detail: { depth: um(this.depthMm), cut: id === "cut" }, bubbles: true, composed: true }));
			return;
		}
		if (id === "delete") {
			// The name the plan gave this exit: a press that takes something away, not a build. app-main listens
			// for it on this element, so a cancel dispatched anywhere else would never reach it.
			this.dispatchEvent(new CustomEvent("cad-cancel", { detail: { tool: "delete" }, bubbles: true, composed: true }));
			return;
		}
		this.dispatchEvent(new CustomEvent("cad-tool", { detail: { tool: id }, bubbles: true, composed: true }));
	}
}

customElements.define("cad-tools", CadTools);
