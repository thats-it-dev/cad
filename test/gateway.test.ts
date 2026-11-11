import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, type Gpu, type KvList, OffTailnetError, gatewayFetch, kv, system } from "../src/gateway.ts";

const fetchMock = vi.fn();
beforeEach(() => {
	vi.stubGlobal("__GATEWAY_URL__", "https://gw.example:9443");
	vi.stubGlobal("__APP_NAME__", "notes-app");
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("gatewayFetch", () => {
	it("turns a rejected fetch into OffTailnetError", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(gatewayFetch("/system/gpu")).rejects.toBeInstanceOf(OffTailnetError);
	});
	it("turns a non-2xx into GatewayError with status and the body's error", async () => {
		fetchMock.mockResolvedValue(json(403, { error: "x" }));
		const err = (await gatewayFetch("/system/gpu").catch((e: unknown) => e)) as GatewayError;
		expect(err).toBeInstanceOf(GatewayError);
		expect(err).not.toBeInstanceOf(OffTailnetError);
		expect(err.status).toBe(403);
		expect(err.message).toBe("x");
	});
	it("survives a non-JSON error body", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
		const err = (await gatewayFetch("/x").catch((e: unknown) => e)) as GatewayError;
		expect(err).toBeInstanceOf(GatewayError);
		expect(err.status).toBe(502);
	});
	it("prefixes the gateway url and sends json bodies", async () => {
		fetchMock.mockResolvedValue(json(200, { ok: true }));
		await expect(gatewayFetch("/x", { method: "POST", body: JSON.stringify({ a: 1 }) })).resolves.toEqual({ ok: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://gw.example:9443/x");
		expect(new Headers(init.headers).get("content-type")).toBe("application/json");
	});
	it("refuses to run when the app did not opt in", async () => {
		vi.stubGlobal("__GATEWAY_URL__", "");
		await expect(gatewayFetch("/x")).rejects.toThrow('set "gateway": true in app.config.json');
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("turns a non-JSON 2xx body into GatewayError", async () => {
		fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
		const err = (await gatewayFetch("/x").catch((e: unknown) => e)) as GatewayError;
		expect(err).toBeInstanceOf(GatewayError);
		expect(err.status).toBe(200);
		expect(err.message).toBe("invalid JSON from gateway");
	});
	it("returns undefined for 204", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(gatewayFetch("/x", { method: "DELETE" })).resolves.toBeUndefined();
	});
});

describe("helpers", () => {
	beforeEach(() => fetchMock.mockImplementation(async () => json(200, {})));
	const last = () => {
		const [url, init] = fetchMock.mock.calls.at(-1)!;
		return { url: url as string, method: (init?.method ?? "GET") as string, body: init?.body };
	};
	it("kv.put PUTs under the app's own store", async () => {
		await kv.put("notes", "n1", { a: 1 });
		expect(last()).toEqual({ url: "https://gw.example:9443/apps/notes-app/kv/notes/n1", method: "PUT", body: '{"a":1}' });
	});
	it("kv.get, kv.del", async () => {
		await kv.get("notes", "n1");
		expect(last().method).toBe("GET");
		await kv.del("notes", "n1");
		expect(last()).toMatchObject({ url: "https://gw.example:9443/apps/notes-app/kv/notes/n1", method: "DELETE" });
	});
	it("kv.list passes limit and cursor", async () => {
		await kv.list("notes", { limit: 5, cursor: "a b" });
		expect(last().url).toBe("https://gw.example:9443/apps/notes-app/kv/notes?limit=5&cursor=a+b");
		await kv.list("notes");
		expect(last().url).toBe("https://gw.example:9443/apps/notes-app/kv/notes");
	});
	it("typed results", async () => {
		fetchMock.mockImplementation(async () => json(200, { items: [{ id: "n1", value: { title: "T" }, updatedAt: "2026-10-25T00:00:00.000Z" }] }));
		const list: KvList<{ title: string }> = await kv.list<{ title: string }>("notes");
		expect(list.items[0]?.value.title).toBe("T");
		expect(list.cursor).toBeUndefined();
		fetchMock.mockImplementation(async () => json(200, { gpus: [{ name: "GB10", utilizationPercent: null }], memory: { totalBytes: 1, availableBytes: 1 } }));
		const gpu: Gpu = await system.gpu();
		expect(gpu.gpus[0]?.utilizationPercent).toBeNull();
	});
	it("kv.get on a missing id is a 404 GatewayError", async () => {
		fetchMock.mockImplementation(async () => json(404, { error: "not found" }));
		const err = (await kv.get("notes", "nope").catch((e: unknown) => e)) as GatewayError;
		expect(err).toBeInstanceOf(GatewayError);
		expect(err.status).toBe(404);
	});
	it("system helpers", async () => {
		await system.models();
		expect(last().url).toBe("https://gw.example:9443/system/models");
		await system.gpu();
		expect(last().url).toBe("https://gw.example:9443/system/gpu");
		await system.sessions();
		expect(last().url).toBe("https://gw.example:9443/system/sessions");
	});
});
