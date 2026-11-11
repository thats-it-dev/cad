import { LitElement, html } from "https://kit.thatsit.app/lit.js";
import { sharedStyles } from "https://kit.thatsit.app/kit.js";

// Show this when a gateway call rejects with OffTailnetError. Listen for `retry` to run the call again.
export class TkTailnetOnly extends LitElement {
	static styles = [sharedStyles];

	render() {
		return html`
			<div class="card">
				<h2>Only works on the tailnet</h2>
				<p>Connect this device to Michael's tailnet, then try again. If you are on the tailnet, the gateway may not know this app yet.</p>
				<button class="btn" @click=${() => this.dispatchEvent(new CustomEvent("retry", { bubbles: true, composed: true }))}>Try again</button>
			</div>
		`;
	}
}
customElements.define("tk-tailnet-only", TkTailnetOnly);
