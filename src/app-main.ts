import { LitElement, css, html } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";
import "./app/viewport.ts";

// The CAD workspace is one surface: the pen owns the whole window, so nothing else may take the middle of it.
export class AppMain extends LitElement {
	static styles = [
		sharedStyles,
		css`
			:host {
				display: block;
				position: fixed;
				inset: 0;
			}
			cad-viewer {
				display: block;
				width: 100%;
				height: 100%;
			}
		`,
	];

	protected firstUpdated(): void {
		window.__CAD_VIEWER__ = this.renderRoot.querySelector<HTMLElement>("cad-viewer") ?? undefined;
	}

	render() {
		return html`<cad-viewer></cad-viewer>`;
	}
}
customElements.define("app-main", AppMain);
