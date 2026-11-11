// App-shell service worker. Navigations: network first, cached shell offline.
// Hashed assets (/assets/*): cache first, since their URL changes with their content.
// Everything else (icons, the manifest): network first, cached copy offline.
// The kit (kit.thatsit.app) is network first too, because it is always-latest; its
// files are cached at install so the app starts offline. Those requests use CORS mode:
// an opaque response can't be checked with res.ok, so a failure could be cached.
// Other cross-origin requests are not touched.
// The build fills in VERSION and PRECACHE (vite/app-plugin.ts): every emitted file under
// assets/ plus the shell, cached at install because the first load runs before this worker
// controls the page. sw.js changes with every build, which is what makes clients update.
// Lookups ignore Vary: module scripts send Origin, precached requests don't, and a
// "Vary: Origin" response would then never match offline.
// Kit files are requested no-cors by the page (a stylesheet link, a classic script); an
// opaque response can't be checked, so the worker fetches them itself in CORS mode.
// Bumping CACHE drops every older cache on activation.
const CACHE = `app-${"__VERSION__"}`;
const PRECACHE = ["__PRECACHE__"];
const MATCH = { ignoreVary: true };
const KIT_ORIGIN = "https://kit.thatsit.app";
const KIT = ["kit.css", "kit.js", "lit.js", "theme-init.js"].map((f) => `${KIT_ORIGIN}/${f}`);

const kitRequest = (url) => new Request(url, { mode: "cors", credentials: "omit" });

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE).then(async (c) => {
			await c.addAll(PRECACHE);
			await Promise.all(KIT.map((u) => c.add(kitRequest(u))));
		}),
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	const kit = url.origin === KIT_ORIGIN;
	if (req.method !== "GET" || (url.origin !== self.location.origin && !kit)) return;
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					// Never let an error page (a 502 from a proxy, say) replace the cached shell.
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put("/", copy));
					}
					return res;
				})
				.catch(() => caches.match("/")),
		);
		return;
	}
	const fromNetwork = () =>
		fetch(kit ? kitRequest(req.url) : req).then((res) => {
			// A host's SPA fallback answers unknown /assets/ paths with 200 HTML; never keep that.
			if (res.ok && !(res.headers.get("content-type") || "").includes("text/html")) {
				const copy = res.clone();
				caches.open(CACHE).then((c) => c.put(req.url, copy));
			}
			return res;
		});
	// Caveat: an old open page that lazily loads a chunk after a new deploy gets no file here
	// (the old hash is gone and Pages answers with HTML). Apps that code-split should reload
	// the page when a dynamic import fails.
	if (!kit && url.pathname.startsWith("/assets/")) {
		event.respondWith(caches.match(req, MATCH).then((hit) => hit || fromNetwork()));
		return;
	}
	event.respondWith(fromNetwork().catch(() => caches.match(req, MATCH).then((hit) => hit || Response.error())));
});
