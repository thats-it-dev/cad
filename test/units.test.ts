import { describe, expect, it } from "vitest";
import { MM_PER_UM, mm, um } from "../src/model/units.ts";

describe("units", () => {
	it("converts at 1000 µm per mm", () => {
		expect(MM_PER_UM).toBe(0.001);
		expect(mm(40_000)).toBe(40); // a 40 mm edge is stored as 40_000 µm
		expect(mm(12_000)).toBe(12); // the 12 mm depth the kernel sees as [0,0,12]
		expect(mm(12)).toBe(0.012); // a 12 µm feature
		expect(um(0.04)).toBe(40);
		expect(um(40)).toBe(40_000);
		expect(um(12)).toBe(12_000);
	});

	it("rounds a fractional distance instead of storing it", () => {
		expect(um(1 / 3)).toBe(333);
		expect(um(1 / 3000)).toBe(0); // 0.33 µm: below the document's resolution
		expect(um(-1 / 3)).toBe(-333);
	});

	it("keeps whole µm exact across sizes, in sign and order of magnitude", () => {
		for (const v of [-25_000, -1, 0, 1, 7, 40, 999, 1000, 12_000, 40_000, 123_457, 1_000_000, 2_147_483]) {
			expect(um(mm(v)), `${v} µm`).toBe(v);
		}
	});

	it("never hands back a fractional µm for a float mm value", () => {
		for (let i = 0; i < 500; i++) {
			const v = um(i * 0.000_999_999 + 0.4);
			expect(Number.isInteger(v), `mm ${i * 0.000_999_999 + 0.4}`).toBe(true);
		}
	});

	it("does not let one large value distort the next conversion", () => {
		const small = mm(12);
		mm(1_000_000_000); // a far larger distance, converted first
		expect(mm(12)).toBe(small);
		expect(um(40)).toBe(40_000);
	});
});
