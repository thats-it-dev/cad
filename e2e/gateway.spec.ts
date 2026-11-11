import { loadConfig } from "../vite/config.ts";
import { expect, test } from "./csp.ts";

// Runs only in apps that set "gateway": true. The gateway is never reached from CI: requests are aborted,
// which is what an off-tailnet device sees. Apps stub successful replies with page.route the same way.
test.skip(!loadConfig().gateway, "app does not use the gateway");

test("off the tailnet the app can show <tk-tailnet-only>", async ({ page }) => {
	const blocked: string[] = [];
	await page.route("https://*.ts.net:*/**", (r) => {
		blocked.push(r.request().url());
		return r.abort();
	});
	await page.goto("/");
	await page.waitForFunction(() => customElements.get("tk-tailnet-only") !== undefined);
	// A gateway call from the page fails like an off-tailnet fetch and is not blocked by the CSP.
	const failed = await page.evaluate(() => fetch(`${new URL("https://spark-713a.tail9274fa.ts.net:9443")}health`).then(() => false, () => true));
	expect(failed).toBe(true);
	await page.evaluate(() => document.body.append(document.createElement("tk-tailnet-only")));
	const el = page.locator("tk-tailnet-only");
	await expect(el.getByText("Only works on the tailnet")).toBeVisible();
	await expect(el.getByText("Connect this device to Michael's tailnet, then try again. If you are on the tailnet, the gateway may not know this app yet.")).toBeVisible();
	await expect(el.getByRole("button", { name: "Try again" })).toBeVisible();
	expect(blocked.length).toBeGreaterThan(0);
});
