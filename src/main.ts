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
