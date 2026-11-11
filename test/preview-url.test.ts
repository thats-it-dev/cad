import { describe, expect, it } from "vitest";
import { previewUrl } from "../scripts/preview-url.ts";

const PROD = "✨ Deployment complete! Take a peek over at https://45c4626d.thatsit-kit.pages.dev\n";
const ALIAS = "✨ Deployment alias URL: https://feat-foo-bar.app-template.pages.dev\n";

describe("previewUrl", () => {
	it("returns the hash URL for a production deploy", () => {
		expect(previewUrl(`Uploading...\n${PROD}`)).toBe("https://45c4626d.thatsit-kit.pages.dev");
	});
	it("prefers the branch alias when wrangler prints one", () => {
		expect(previewUrl(PROD + ALIAS)).toBe("https://feat-foo-bar.app-template.pages.dev");
	});
	it("returns null for unrelated text", () => {
		expect(previewUrl("nothing to see\n")).toBeNull();
	});
	it("survives ANSI color codes", () => {
		const out = `\x1b[32m✨ Deployment complete! Take a peek over at \x1b[36mhttps://45c4626d.x.pages.dev\x1b[0m\n`;
		expect(previewUrl(out)).toBe("https://45c4626d.x.pages.dev");
	});
});
