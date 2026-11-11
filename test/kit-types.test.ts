import { describe, expect, it } from "vitest";
import { collectTypes } from "../scripts/kit-types.ts";

const fake = (files: Record<string, string>) => async (p: string) => {
	if (!(p in files)) throw new Error(`404 ${p}`);
	return files[p];
};

describe("collectTypes", () => {
	it("follows relative .js/.ts specifiers to .d.ts, skipping bare ones", async () => {
		const out = await collectTypes(
			fake({
				"kit.d.ts": 'export * from "./types/index.js";',
				"types/index.d.ts": 'export { a } from "./styles.ts";\nexport * from "./lit.ts";',
				"types/styles.d.ts": 'import "lit";\nexport const a: 1;',
				"types/lit.d.ts": 'export * from "lit";',
			}),
		);
		expect([...out.keys()].sort()).toEqual(["kit.d.ts", "types/index.d.ts", "types/lit.d.ts", "types/styles.d.ts"]);
	});
	it("terminates on cycles", async () => {
		const out = await collectTypes(
			fake({ "kit.d.ts": 'export * from "./b.js";', "b.d.ts": 'export * from "./kit.js";' }),
		);
		expect(out.size).toBe(2);
	});
	it("propagates a rejected fetch", async () => {
		await expect(collectTypes(fake({ "kit.d.ts": 'export * from "./missing.js";' }))).rejects.toThrow(/missing/);
	});
});
