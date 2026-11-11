// The dimension field: one `<input>`, and the only element the spec allows to float over the canvas
// (docs/spec.md, Decided: "no floating 2D panels over the canvas except the value field while a dimension is
// being set"). It is deliberately not a panel — no title, no buttons, no chrome. The number is the whole
// interaction and Enter is the whole commit, so this file is about focus, not layout: where it sits is the
// parent's business (a style attribute on the host), and nothing here reads the camera or the document.
//
// Millimetres are the unit on the wire because millimetres are what a person types; the caller converts with
// `um()` before the number enters the document, so no float from this field survives into the model.
import { LitElement, css, html } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";

export class CadDimensionField extends LitElement {
	static properties = {
		open: { type: Boolean, reflect: true },
		mm: { type: Number },
		label: { type: String },
	};

	static styles = [
		sharedStyles,
		css`
			:host {
				position: absolute;
				/* Centred on the point it was opened at, which is where the hand already is. */
				transform: translate(-50%, -50%);
			}
			input {
				font: inherit;
				/* 16px or iOS zooms the page to focus a field (README, tablets). */
				font-size: 16px;
				width: 7ch;
				text-align: right;
				padding: 4px 6px;
				border: 2px solid currentColor;
				background: Canvas;
				color: CanvasText;
			}
		`,
	];

	open = false;
	/** The number on show while the field is open; undefined leaves it empty. */
	mm: number | undefined = undefined;
	label = "Depth in millimetres";

	private input: HTMLInputElement | null = null;

	protected firstUpdated(): void {
		this.input = this.renderRoot.querySelector("input");
		this.syncValue();
		// A tablet user's next tap is the keyboard they have not opened yet: the field takes focus as it appears.
		if (this.open) this.input?.focus();
	}

	protected updated(): void {
		this.syncValue();
	}

	/** Show the depth the host remembers, but never over what is being typed. */
	private syncValue(): void {
		// Why this is not just in firstUpdated: Lit runs a child's first update while the child is still detached,
		// and the parent's `.mm=${…}` property part lands after. Task 10 made the remembered depth flow in — a rail
		// commit of 25 mm followed by E used to open a blank box, and Enter then reported "type a depth" because
		// the number the field handed back was Number("").
		const input = this.input ?? (this.input = this.renderRoot.querySelector("input"));
		if (input && this.mm !== undefined && input.value.trim() === "") input.value = String(this.mm);
	}

	/** Focus the number, for the parent that just opened us. Lit runs a child's first update while the child is
	 *  still detached from the document, and focus on a detached input is a no-op — so the parent's `updated()`
	 *  hook, which runs after the element is in the tree, is where the caret actually lands. */
	focusField(): void {
		const input = this.input ?? (this.input = this.renderRoot.querySelector("input"));
		if (input && this.shadowRoot?.activeElement !== input) input.focus();
	}

	protected render() {
		// The value is set once, in firstUpdated, and never bound here. A `.value=${…}` part is an
		// attribute-part that Lit re-commits whenever the element updates, so every keystroke that triggered a
		// render (the `@keydown` handler's `take()`) wrote `undefined` back over what had just been typed. The
		// browser inserted the character, then Lit erased it in the same task: `beforeinput` and `input` both
		// fired, `value` stayed "", and Enter committed a zero depth. `page.keyboard.type()` cannot pass this;
		// `locator.fill()` sets the value property directly and never could notice.
		//
		// Enter is the whole commit, deliberately with no `@change` alongside it: `@change` fires on Enter *and*
		// on blur, so a commit that removes the field blurs the input, which asks for the same commit a second
		// time against an emptied session. The first won, the second overwrote its status with "nothing to
		// sketch".
		return html`<input
			type="number"
			inputmode="decimal"
			step="any"
			aria-label=${this.label}
			@keydown=${(e: KeyboardEvent) => {
				if (e.key !== "Enter") return;
				// A page that later wraps this in a form would otherwise submit it.
				e.preventDefault();
				this.take();
			}}
		/>`;
	}

	private take(): void {
		const text = this.input?.value.trim() ?? "";
		this.dispatchEvent(new CustomEvent("cad-dimension", { detail: { mm: Number(text) } }));
	}
}

customElements.define("cad-dimension-field", CadDimensionField);
