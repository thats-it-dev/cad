import { describe, expect, it } from "vitest";
import { gatewayUrlFor } from "../scripts/gateway-url.ts";

const base = "https://spark-713a.tail9274fa.ts.net";

describe("gatewayUrlFor", () => {
	it("maps a PR number to its preview port", () => {
		expect(gatewayUrlFor("Adds notes.\n\nGateway: thats-it-dev/spark-gateway#12\n")).toBe(`${base}:9512`);
	});
	it("treats the key case-insensitively", () => {
		expect(gatewayUrlFor("gateway: thats-it-dev/spark-gateway#1")).toBe(`${base}:9501`);
	});
	it("accepts the range edges 1 and 499", () => {
		expect(gatewayUrlFor("Gateway: thats-it-dev/spark-gateway#499")).toBe(`${base}:9999`);
	});
	it.each(["#0", "#500", "#-3"])("rejects %s", (n) => {
		expect(gatewayUrlFor(`Gateway: thats-it-dev/spark-gateway${n}`)).toBeUndefined();
	});
	it("rejects other repos, inline mentions and missing lines", () => {
		expect(gatewayUrlFor("Gateway: someone/else#3")).toBeUndefined();
		expect(gatewayUrlFor("see Gateway: thats-it-dev/spark-gateway#3")).toBeUndefined();
		expect(gatewayUrlFor("")).toBeUndefined();
	});
});
