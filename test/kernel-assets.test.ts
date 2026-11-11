// The CAD kernel files are committed assets, not a package dependency: nothing here installs cascade-core.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const size = (file: string) => statSync(join(root, file)).size;
const FONTS = ["Consola.ttf", "Roboto.ttf"]; // the licence-clean two; see scripts/get-kernel.ts
const VENDOR_SHA = { "CascadeEngine.js": "ca796d702a33879b", "MessageBus.js": "984bd5de66b0c1ad" };

describe("kernel assets", () => {
it("ships a wasm under Cloudflare's 25 MiB per-asset cap", () => {
		// The magic number is the guard that the copy landed: scripts/get-kernel.ts throws rather than
		// shipping an empty public/kernel, and a truncated file would pass a size check alone.
		expect(readFileSync(join(root, "public/kernel/cascadestudio.wasm")).subarray(0, 4).toString("hex")).toBe("0061736d");
		expect(size("public/kernel/cascadestudio.wasm")).toBeLessThan(25 * 1024 * 1024);
});

	it("ships the worker, its fake, and the fonts the worker may fetch", () => {
		expect(size("public/kernel/cascade-worker.js")).toBeGreaterThan(0);
		expect(size("public/kernel/fake-worker.js")).toBeGreaterThan(0); // the ?kernel=fake target in e2e
		for (const font of FONTS) expect(existsSync(join(root, "public/kernel/fonts", font)), font).toBe(true);
		// The worker's own list names Microsoft-proprietary fonts we do not ship. It loads them through a
		// callback that only logs a failure, so a missing font cannot poison the kernel — but if a future
		// kernel starts fetching something else, that has to be a licensing decision, not a surprise.
		const wants = [...read("public/kernel/cascade-worker.js").matchAll(/\.\/fonts\/([A-Za-z.]+ttf)/g)].map((m) => m[1]);
		for (const font of wants) expect(FONTS, `worker wants ${font}`).toContain(font);
	});

	it("ships no source map", () => {
		// 20 MB of map for a file nobody debugs in production, and it would eat most of the asset cap.
		expect(existsSync(join(root, "public/kernel/cascade-worker.js.map"))).toBe(false);
	});

	it("keeps the kernel out of the service worker", () => {
		// public/sw.js is the template with an unfilled placeholder, so grepping it proves nothing about the
		// list that actually ships; test/build.test.ts checks dist/sw.js after a real build. What is worth
		// asserting here is that the template never names the kernel directory at all.
		expect(read("public/sw.js").includes("kernel")).toBe(false);
	});

	it("keeps the CSP that lets the kernel instantiate wasm", () => {
		expect(read("public/_headers")).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
	});
});

describe("vendored client", () => {
	it("carries the source and licence of both files", () => {
		for (const name of ["CascadeEngine", "MessageBus"]) {
			const text = read(`src/kernel/vendor/${name}.js`);
			expect(text, name).toContain("cascade-core@2.0.6");
			expect(text, name).toContain("MIT");
			expect(text, name).toContain(`export { ${name} }`);
		}
	});

	it("is verbatim source, not an edited copy", () => {
		// Provenance strings can survive a hand-edit; a hash cannot. Body = everything after the 4 header lines.
		for (const [name, sha] of Object.entries(VENDOR_SHA)) {
			const body = read(`src/kernel/vendor/${name}`).split("\n").slice(4).join("\n");
			expect(createHash("sha256").update(body).digest("hex").slice(0, 16), name).toBe(sha);
		}
	});

	it("reaches MessageBus by relative import, so the copy needs no rewrite", () => {
		expect(read("src/kernel/vendor/CascadeEngine.js")).toContain("from './MessageBus.js'");
	});
});
