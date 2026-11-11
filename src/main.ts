/// <reference path="./global.d.ts" /> // the __CAD_KERNEL__ declaration, for when this entry is checked alone
// The kernel worker URL, read once here so nothing else has to know about the switch. A plain string, never
// new URL("./x", import.meta.url): Vite would emit it as /assets/<hash>.js and ?kernel=fake would point at
// nothing. e2e uses the fake worker to start up without pulling 21 MB of wasm.
window.__CAD_KERNEL__ = new URLSearchParams(location.search).get("kernel") === "fake" ? "/kernel/fake-worker.js" : "/kernel/cascade-worker.js";

// Dynamic imports, because a failed static import can't be caught and would leave a blank page.
let kit: typeof import("https://kit.thatsit.app/kit.js") | undefined;
try {
	[kit] = await Promise.all([import("https://kit.thatsit.app/kit.js"), import("./app-main.ts")]);
} catch (err) {
	console.error(err);
	const p = document.createElement("p");
	p.textContent = "Couldn't load the kit. Check your connection and reload.";
	document.body.replaceChildren(p);
}
if (kit) {
	kit.trackViewport();
	if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
}
