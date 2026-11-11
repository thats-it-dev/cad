import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { type AppConfig, loadConfig } from "./config.ts";
import { gatewayHeaders, gatewayUrl } from "./gateway.ts";
import { parseHeaders } from "./headers.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url));

export function manifestFor(c: AppConfig): object {
	const icon = (src: string, size: number, purpose: string) => ({ src, sizes: `${size}x${size}`, type: "image/png", purpose });
	return {
		id: "/",
		name: c.title,
		short_name: c.title,
		description: c.description,
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#171717",
		theme_color: "#171717",
		icons: [
			icon("/apple-touch-icon.png", 180, "any"),
			icon("/icons/icon-192.png", 192, "any"),
			icon("/icons/icon-512.png", 512, "any"),
			icon("/icons/icon-maskable-512.png", 512, "maskable"),
		],
	};
}

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function fillHtml(html: string, c: AppConfig): string {
	return html
		.replaceAll("%APP_TITLE%", escapeHtml(c.title))
		.replaceAll("%APP_DESCRIPTION%", escapeHtml(c.description))
		.replaceAll("%APP_NAME%", escapeHtml(c.name));
}

export function thatsitApp(): Plugin[] {
	const config = loadConfig();
	const headersText = () => gatewayHeaders(read("../public/_headers").toString("utf8"), config, process.env.GATEWAY_URL);
	const manifest = JSON.stringify(manifestFor(config), null, "\t") + "\n";
	return [
		{
			name: "thatsit-app",
			config: () => ({
				define: {
					__APP_TITLE__: JSON.stringify(config.title),
					__APP_NAME__: JSON.stringify(config.name),
					__GATEWAY_URL__: JSON.stringify(gatewayUrl(config, process.env.GATEWAY_URL)),
				},
			}),
			// Static headers for `vite preview`; Pages enforces the same file in production.
			configurePreviewServer: (server) => {
				const h = parseHeaders(headersText())["/*"] ?? {};
				server.middlewares.use((_req, res, next) => {
					for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
					next();
				});
			},
			configureServer: (server) => {
				server.middlewares.use("/manifest.webmanifest", (_req, res) => {
					res.setHeader("content-type", "application/manifest+json");
					res.end(manifest);
				});
			},
			generateBundle() {
				this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
			},
			// public/ is copied after generateBundle, so dist/sw.js is rewritten once it exists. Hashed
			// file names make the list (and so the version) change whenever any asset's content does.
			writeBundle(options, bundle) {
				const assets = Object.keys(bundle).filter((f) => f.startsWith("assets/")).sort();
				const precache = ["/", "/manifest.webmanifest", "/icons/icon.svg", ...assets.map((f) => `/${f}`)];
				const html = bundle["index.html"];
				const version = createHash("sha256")
					.update(JSON.stringify(precache))
					.update(html && "source" in html ? String(html.source) : "")
					.update(manifest)
					.digest("hex")
					.slice(0, 10);
				const file = join(options.dir ?? "dist", "sw.js");
				const sw = readFileSync(file, "utf8");
				if (config.gateway) writeFileSync(join(options.dir ?? "dist", "_headers"), headersText());
				writeFileSync(file, sw.replace("__VERSION__", version).replace('"__PRECACHE__"', precache.map((p) => JSON.stringify(p)).join(", ")));
			},
			// iOS 27's Add to Home Screen sheet fetches the apple-touch-icon with its own
			// loader, which fails on a network URL and leaves a letter tile; an icon
			// embedded as a data: URI works. The 180px PNG (2 KB) is inlined from the
			// same file the icon script writes, so there is one source of truth.
			transformIndexHtml: (html) =>
				fillHtml(html, config).replace("__APPLE_TOUCH_ICON__", `data:image/png;base64,${read("../public/apple-touch-icon.png").toString("base64")}`),
		},
	];
}
