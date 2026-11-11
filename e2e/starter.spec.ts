import { loadConfig } from "../vite/config.ts";
import { expect, test } from "./csp.ts";

const { name, title } = loadConfig();

// Tests the starter shell and <section>; delete this file when you replace it.
test("renders the kit shell", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("tk-shell")).toBeVisible();
	await expect(page.locator("tk-header")).toContainText(title);
	await expect(page.locator("tk-sheet")).toBeAttached();
	await expect(page.locator("tk-toasts")).toBeAttached();
});

test("the shell remembers hidden panels per app", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("tk-shell")).toHaveAttribute("store-key", `${name}:panels`);
});

test("starter sheet and toast work", async ({ page }) => {
	await page.goto("/");
	const sheet = page.locator("tk-sheet");
	const isOpen = () => sheet.evaluate((el) => (el as unknown as { open: boolean }).open);
	await page.locator(".btn", { hasText: "Open sheet" }).click();
	await expect.poll(isOpen).toBe(true);
	await sheet.evaluate((el) => el.dispatchEvent(new CustomEvent("tk-close", { bubbles: true, composed: true })));
	await expect.poll(isOpen).toBe(false);
	await page.locator(".btn", { hasText: "Show toast" }).click();
	await expect(page.locator("tk-toasts").getByText("Saved")).toBeVisible();
});
