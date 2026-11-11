// The CAD kernel files are committed assets, not a package dependency: nothing here installs cascade-core.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const size = (file: string) => statSync(join(root, file)).size;
const FONTS = ["Consola.ttf", "Consolas.ttf", "Papyrus.ttf", "Roboto.ttf"];

describe("kernel assets", () => {
it("ships a wasm under Cloudflare's 25 MiB per-asset cap", () => {
		// The magic number is the guard that the copy landed: scripts/get-kernel.ts throws rather than
		// shipping an empty public/kernel, and a truncated file would pass a size check alone.
		expect(readFileSync(join(root, "public/kernel/cascadestudio.wasm")).subarray(0, 4).toString("hex")).toBe("0061736d");
		expect(size("public/kernel/cascadestudio.wasm")).toBeLessThan(25 * 1024 * 1024);
});

	it("ships the worker, its fake, and every font the worker fetches", () => {
		expect(size("public/kernel/cascade-worker.js")).toBeGreaterThan(0);
		expect(size("public/kernel/fake-worker.js")).toBeGreaterThan(0); // the ?kernel=fake target in e2e
		for (const font of FONTS) expect(existsSync(join(root, "public/kernel/fonts", font)), font).toBe(true);
	});

	it("ships no source map", () => {
		// 20 MB of map for a file nobody debugs in production, and it would eat most of the asset cap.
		expect(existsSync(join(root, "public/kernel/cascade-worker.js.map"))).toBe(false);
	});

	it("keeps the kernel out of the service worker", () => {
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

	it("reaches MessageBus by relative import, so the copy needs no rewrite", () => {
		expect(read("src/kernel/vendor/CascadeEngine.js")).toContain("from './MessageBus.js'");
	});
});
