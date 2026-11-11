import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../vite/config.ts";

const root = new URL("../", import.meta.url);
const dist = (p: string) => readFileSync(new URL(`dist/${p}`, root), "utf8");

beforeAll(() => {
	execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "pipe" });
}, 60_000);

describe("vite build", () => {
	it("emits a manifest with the title", () => {
		expect(JSON.parse(dist("manifest.webmanifest")).name).toBe(loadConfig().title);
	});

	it("fills in index.html", () => {
		const html = dist("index.html");
		expect(html).not.toContain("%APP_");
		expect(html).not.toContain("__APPLE_TOUCH_ICON__");
		expect(html).toContain("data:image/png;base64,");
		expect(html).toContain("https://kit.thatsit.app/kit.css");
		expect(html).toContain('src="https://kit.thatsit.app/theme-init.js"');
		expect(html).toContain('data-key="app:theme"');
	});

	it("does not bundle a second Lit", () => {
		const dir = new URL("dist/assets/", root);
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
			const js = readFileSync(new URL(f, dir), "utf8");
			expect(js).not.toContain("lit-html");
			expect(js).not.toContain("LitElement.prototype");
		}
	});

	it("fills in the service worker", () => {
		const sw = dist("sw.js");
		expect(sw).not.toContain("__PRECACHE__");
		expect(sw).not.toContain("__VERSION__");
		expect(sw).toMatch(/app-\$\{"[0-9a-f]{10}"\}/);
		const files = readdirSync(new URL("dist/assets/", root));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) expect(sw).toContain(`"/assets/${f}"`);
	});
});
