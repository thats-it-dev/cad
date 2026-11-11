import { describe, expect, it } from "vitest";
import { fillHtml, manifestFor } from "../vite/app-plugin.ts";

const config = { name: "demo", title: "Demo app", description: "A demo", color: "#112233" };

describe("manifestFor", () => {
	const m = manifestFor(config) as Record<string, any>;

	it("maps the config fields", () => {
		expect(m.name).toBe("Demo app");
		expect(m.short_name).toBe("Demo app");
		expect(m.description).toBe("A demo");
		expect(m).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", background_color: "#171717", theme_color: "#171717" });
	});

	it("lists four icons, one maskable, without cache busters", () => {
		expect(m.icons).toHaveLength(4);
		expect(m.icons.filter((i: any) => i.purpose === "maskable")).toHaveLength(1);
		for (const i of m.icons) expect(i.src).not.toContain("?");
	});
});

describe("fillHtml", () => {
	const tricky = { ...config, title: `Mike's "list" & co`, description: `<b>"x"</b> & y` };
	const out = fillHtml('<title>%APP_TITLE%</title><meta content="%APP_DESCRIPTION%"><i data-n="%APP_NAME%">', tricky);

	it("escapes & < > and quotes", () => {
		expect(out).toContain("<title>Mike's &quot;list&quot; &amp; co</title>");
		expect(out).toContain('content="&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y"');
		expect(out).toContain('data-n="demo"');
	});
});
