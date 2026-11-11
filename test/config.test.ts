import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../vite/config.ts";

const ok = { name: "app-template", title: "App template", description: "Starter", color: "#FFAA00" };

describe("parseConfig", () => {
	it("round-trips a valid config", () => {
		expect(parseConfig(ok)).toEqual(ok);
	});
	it.each(["App", "-x", "x-", "a_b", "a".repeat(31)])("rejects name %s", (name) => {
		expect(() => parseConfig({ ...ok, name })).toThrow(/name/);
	});
	it("rejects an empty title", () => {
		expect(() => parseConfig({ ...ok, title: "" })).toThrow(/title/);
	});
	it.each(["red", "#FFF", "#GGGGGG", "FFAA00"])("rejects color %s", (color) => {
		expect(() => parseConfig({ ...ok, color })).toThrow(/color/);
	});
});

describe("loadConfig", () => {
	// Shape only: apps copied from the template edit this file.
	it("parses the committed app.config.json", () => {
		expect(() => loadConfig()).not.toThrow();
	});
});

describe("gateway flag", () => {
	const ok = { name: "app-template", title: "App template", description: "Starter", color: "#FFAA00" };
	it("is optional and true enables it", () => {
		expect(parseConfig(ok).gateway).toBeUndefined();
		expect(parseConfig({ ...ok, gateway: true }).gateway).toBe(true);
		expect(parseConfig({ ...ok, gateway: false }).gateway).toBeUndefined();
	});
	it.each(["yes", 1, null])("rejects %s", (gateway) => {
		expect(() => parseConfig({ ...ok, gateway })).toThrow(/gateway/);
	});
});
