import { expect, test as base } from "@playwright/test";

// Fails any test that sees a CSP violation. The recorder is installed before load so startup violations count too.
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			const w = window as unknown as { __csp: string[] };
			w.__csp = [];
			document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
		});
		await use(page);
		const violations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []);
		expect(violations).toEqual([]);
	},
});
export { expect };
