import type { Page } from "@playwright/test";
import { expect, test } from "./csp.ts";

const kernelUrl = () => (globalThis as unknown as { window: { __CAD_KERNEL__: string } }).window.__CAD_KERNEL__;

// Layout-agnostic "the app is up", same condition as app.spec.ts: a single page has no tk-shell.
const rendered = (page: Page) => page.waitForFunction(() => (document.querySelector("app-main")?.shadowRoot?.childElementCount ?? 0) > 0);

const kernelRequests = (page: Page) => {
	const urls: string[] = [];
	page.on("request", (r) => urls.push(r.url()));
	return urls;
};

test("names the kernel worker in public/kernel", async ({ page }) => {
	await page.goto("/");
	await rendered(page);
	expect(await page.evaluate(kernelUrl)).toBe("/kernel/cascade-worker.js");
});

test("?kernel=fake starts the app without the wasm", async ({ page }) => {
	const requested = kernelRequests(page);
	await page.goto("/?kernel=fake");
	await rendered(page);
	expect(await page.evaluate(kernelUrl)).toBe("/kernel/fake-worker.js");
	// The 21 MB kernel must never be fetched on this path, nor the worker that instantiates it.
	expect(requested.filter((u) => u.includes("/kernel/"))).toEqual([]);
});
