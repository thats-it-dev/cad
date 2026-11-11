import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

	it("keeps the stage 0 spike out of the deploy build, and in when it is asked for", () => {
		// beforeAll built with no CAD_SPIKE, which is what the deploy job runs (deploy.yml:85).
		expect(existsSync(new URL("dist/spike", root)), "a reachable bench page on cad.thatsit.app").toBe(false);
		// The flag has to actually work, or the iPad row of stage0.md is unmeasurable: the fix for the finding
		// above must not become a new silent failure. try/finally so a failed assertion does not leave a second
		// build tree in the working copy.
		try {
			execFileSync("npx", ["vite", "build", "--outDir", ".spike-dist", "--emptyOutDir"], {
				cwd: root,
				stdio: "pipe",
				env: { ...process.env, CAD_SPIKE: "1" },
			});
			expect(existsSync(new URL(".spike-dist/spike/stage0/index.html", root))).toBe(true);
		} finally {
			rmSync(new URL(".spike-dist", root), { recursive: true, force: true });
		}
	}, 120_000);

	it("keeps the kernel worker URL out of the hashed assets", () => {
		// A plain string in src/main.ts, so Vite never rewrites it and never emits a second worker copy
		// under /assets/ (which the service worker would precache). Quote style is the minifier's choice.
		const files = readdirSync(new URL("dist/assets/", root));
		expect(files.filter((f) => f.includes("cascade"))).toEqual([]);
		const js = files.filter((f) => f.endsWith(".js")).map((f) => dist(`assets/${f}`));
		expect(js.some((s) => s.includes("/kernel/cascade-worker.js"))).toBe(true);
		expect(dist("sw.js")).not.toContain("kernel");
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
