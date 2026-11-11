import { LitElement, html, css } from "https://kit.thatsit.app/lit.js";
import { sharedStyles, toast } from "https://kit.thatsit.app/kit.js";

// Starter for an app with navigation. See README "Layouts": keep the shell for nav apps, or replace the whole render for a single page.
export class AppMain extends LitElement {
	static properties = { sheetOpen: { state: true } };
	static styles = [
		sharedStyles,
		css`
			nav { display: grid; gap: 10px; padding: 18px; }
			section { padding: 18px; display: grid; gap: 14px; align-content: start; overflow-y: auto; }
			.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
		`,
	];

	sheetOpen = false;

	render() {
		return html`
			<tk-shell nav-label="Pages" store-key=${`${__APP_NAME__}:panels`}>
				<nav slot="nav"><a class="u on" href="">Home</a></nav>
				<tk-header menu-label="Open menu"><h1 slot="title">${__APP_TITLE__}</h1></tk-header>
				<section>
					<p>This app was made from the thatsit.app template.</p>
					<div class="row">
						<button class="btn" @click=${() => (this.sheetOpen = true)}>Open sheet</button>
						<button class="btn ghost" @click=${() => toast("Saved")}>Show toast</button>
					</div>
				</section>
			</tk-shell>
			<tk-sheet heading="Sheet" .open=${this.sheetOpen} @tk-close=${() => (this.sheetOpen = false)}><p>Slotted content.</p></tk-sheet>
			<tk-toasts></tk-toasts>
		`;
	}
}
customElements.define("app-main", AppMain);
