// Task 10 in a browser: the panel, the four views, and a cut that reaches the kernel as a boolean.
//
// As in e2e/sketch.spec.ts, everything runs against ?kernel=fake, whose worker answers
// `combineAndRenderShapes` with a canned box and ignores `Evaluate`. So the geometry claims here are about
// what the app *sent*, never about what came back: the cut test patches `Worker` from an init script and reads
// the script the app handed the kernel, which keeps the instrumentation in the test instead of in shipped code.
import type { Page } from "@playwright/test";
import { expect, test } from "./csp.ts";

const V = `(globalThis).window`;
const rendered = (page: Page) => page.waitForFunction(() => (document.querySelector("app-main")?.shadowRoot?.childElementCount ?? 0) > 0);
const PANEL = `document.querySelector("app-main").shadowRoot.querySelector("cad-tools").shadowRoot`;

/** Record every script the app sends to the worker. A string body, interpolated: Playwright passes no
 *  arguments to a string `evaluate`, which is the trap that cost an hour in Task 9. */
const watchKernel = (page: Page) =>
	page.addInitScript(`(() => {
		const Real = globalThis.Worker;
		const sent = [];
		globalThis.__CAD_SENT__ = sent;
		globalThis.Worker = function (url, opts) {
			const w = new Real(url, opts);
			const post = w.postMessage.bind(w);
			w.postMessage = (m) => {
				if (m && m.type === "Evaluate") sent.push(String(m.payload && m.payload.code));
				return post(m);
			};
			return w;
		};
		return true;
	})()`);

const sentCode = (page: Page) => page.evaluate(`(() => (globalThis).__CAD_SENT__.slice(-1)[0] || "")()`) as Promise<string>;

/** A ring in screen px, drawn with the pen. Four corners plus the lift back on the first: enough for
 *  `toEntities` to see a closed rectangle, and deliberately not a rectangle in mm, because the shape is not
 *  what this file is about. */
const drawPx = (page: Page, points: [number, number][]): Promise<{ phases: string[] }> =>
	page.evaluate(
		`((corners) => {
		const canvas = (${V}.__CAD_VIEWER__).renderRoot.querySelector("canvas.model");
		const fire = (type, p) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: p[0], clientY: p[1] }));
		const phases = [];
		(${V}.__CAD_VIEWER__).addEventListener("cad-stroke", (e) => phases.push(e.detail.phase));
		const box = canvas.getBoundingClientRect();
		const px = corners.map((c) => [box.left + c[0] * box.width, box.top + c[1] * box.height]);
		const ring = [...px, px[0], px[0]];
		fire("pointerdown", ring[0]);
		for (const p of ring.slice(1)) fire("pointermove", p);
		fire("pointerup", ring[ring.length - 1]);
		return { phases };
	})(${JSON.stringify(points)})`,
	);

const RING_PX: [number, number][] = [
	[0.35, 0.35],
	[0.62, 0.35],
	[0.62, 0.62],
	[0.35, 0.62],
];

/** One button of the panel. A flat selector, because a chained one does not reach a custom element's shadow
 *  subtree: `page.locator("cad-tools").locator("[data-tool]")` finds nothing, while the single-step form pierces
 *  open shadow roots on its own — the pattern e2e/sketch.spec.ts already relies on. */
const tool = (page: Page, id: string) => page.locator(`[data-tool="${id}"]`);

test("the panel is registered, and its icons are actually drawn", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	// A type-only import would drop the module and its customElements.define with it — the bug that made
	// Task 9's canvas stay empty while the tag sat in the DOM un-upgraded.
	const defined = (await page.evaluate(`(() => customElements.get("cad-tools") !== undefined)()`)) as boolean;
	expect(defined, "cad-tools is defined").toBe(true);
	await expect(page.locator("cad-tools")).toBeAttached();
	// Painted, not just present: svg markup built with `html` instead of `svg` lands in the HTML namespace and
	// renders as nothing, so a test that only counted buttons would pass on an invisible panel.
	const boxes = (await page.evaluate(`(() => {
		const out = [];
		for (const b of ${PANEL}.querySelectorAll("button[data-tool]")) {
			const svg = b.querySelector("svg");
			out.push({ id: b.dataset.tool, ns: svg ? svg.namespaceURI : null, w: svg ? svg.getBoundingClientRect().width : 0 });
		}
		return out;
	})()`)) as { id: string; ns: string | null; w: number }[];
	expect(boxes.length, "the panel has buttons").toBeGreaterThan(6);
	for (const b of boxes) {
		expect(b.ns, `${b.id} has an svg in the SVG namespace`).toBe("http://www.w3.org/2000/svg");
		expect(b.w, `${b.id}'s icon has width`).toBeGreaterThan(8);
	}
});

test("the buttons follow the state, not the last thing that was clicked", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await expect(tool(page, "sketch")).toBeAttached();
	await expect(tool(page, "iso")).toBeAttached();
	// Nothing drawn: no Extrude, no Cut, no depth box.
	await expect(page.locator('[data-tool="extrude"]')).toHaveCount(0);
	await expect(page.locator('[data-tool="cut"]')).toHaveCount(0);
	await expect(page.locator("input[data-tool='depth']")).toHaveCount(0);

	const drawn = await drawPx(page, RING_PX);
	expect(drawn.phases.filter((p) => p === "move").length, "the pen reached the app").toBeGreaterThan(3);
	await expect(tool(page, "extrude")).toBeAttached();
	await expect(tool(page, "cut")).toBeAttached();
	await expect(tool(page, "extrude")).toBeEnabled();

	// And back to nothing: pressing Escape discards, which must take the buttons with it.
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-tool="extrude"]')).toHaveCount(0, "a discarded sketch leaves no button behind");
});

test("a cut goes to the kernel as a boolean, and pressing Cut twice is one step", async ({ page }) => {
	await watchKernel(page);
	await page.goto("/?kernel=fake");
	await rendered(page);
	const drawn = await drawPx(page, RING_PX);
	expect(drawn.phases).toContain("end");
	// A cut needs something to cut from. With no body yet, buildScript deliberately sends no boolean at all
	// (Task 5: a `Difference(null, …)` was the bug), so the first ring is extruded, and only the second cuts.
	await tool(page, "extrude").click();
	await expect.poll(() => page.evaluate(`(() => document.querySelector("app-main").doc.steps.length)()`)).toBe(1);
	const again = await drawPx(page, [
		[0.4, 0.4],
		[0.58, 0.4],
		[0.58, 0.58],
		[0.4, 0.58],
	]);
	expect(again.phases, "the second ring was drawn too").toContain("end");
	await tool(page, "cut").click();
	await expect.poll(() => sentCode(page), { message: "the script sent to the kernel contains a Difference" }).toContain("Difference(");
	const steps = (await page.evaluate(`(() => document.querySelector("app-main").doc.steps.length)()`)) as number;
	expect(steps, "a body and a cut").toBe(2);

	// The double-commit: with the ring already consumed there is nothing pending, so a second press must be
	// inert. The button is gone by now, so the press is made the way a stale tap or a keyup would make it.
	await page.evaluate(`(() => {
		const panel = ${PANEL}.querySelector('[data-tool="cut"]');
		if (panel) panel.click();
		return document.querySelector("app-main").dispatchEvent(new CustomEvent("cad-commit-extrude", { detail: { depth: 12000, cut: true } }));
	})()`);
	await page.waitForFunction(() => document.querySelector("app-main").doc.steps.length >= 1);
	const after = (await page.evaluate(`(() => ({ steps: document.querySelector("app-main").doc.steps.length, sent: (globalThis).__CAD_SENT__.filter((c) => c.includes("Difference(")).length }))()`)) as { steps: number; sent: number };
	expect(after.steps, "Cut pressed twice in one session is one cut").toBe(2);
	expect(after.sent, "and no second boolean went to the kernel").toBe(1);
});

test("the four views point the camera where they say", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const want: Record<string, [number, number]> = {
		front: [0, Math.PI / 2],
		right: [Math.PI / 2, Math.PI / 2],
		iso: [Math.PI / 4, Math.acos(1 / Math.sqrt(3))],
		// Top is a hair off the pole. Exactly phi = 0 is a degenerate camera: screen-right becomes the cross
		// product of two parallel vectors, which normalises to NaN and paints nothing.
		top: [0, 1e-6],
	};
	for (const id of ["front", "right", "iso", "top"]) {
		await tool(page, id).click();
		const cam = (await page.evaluate(`(() => { const v = ${V}.__CAD_VIEWER__.camera; return [v.theta, v.phi]; })()`)) as [number, number];
		expect(cam[0], `${id} azimuth`).toBeCloseTo(want[id]![0], 6);
		expect(cam[1], `${id} polar`).toBeCloseTo(want[id]![1], 6);
		expect(Number.isFinite(cam[0]) && Number.isFinite(cam[1]), `${id} leaves a finite camera`).toBe(true);
	}
	// The pole guard, where it would actually hurt: draw after Top and see whether the round trip survives.
	// A NaN camera basis means plane mm come back NaN, and a sketch that commits NaN is a solid that never was.
	const drawn = await drawPx(page, RING_PX);
	expect(drawn.phases, "the pen still reaches the app from the top view").toContain("end");
	const ok = (await page.evaluate(`(() => {
		const s = ${V}.__CAD_VIEWER__["scene"];
		const p = s.screenToPlane(400, 300, { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] });
		return { finite: Number.isFinite(p[0]) && Number.isFinite(p[1]) };
	})()`)) as { finite: boolean };
	expect(ok.finite, "screenToPlane stays finite at the top view").toBe(true);
});

test("a view is an angle, fit is a framing, and neither is the other", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const read = () => page.evaluate(`(() => { const s = ${V}.__CAD_VIEWER__["scene"]; return { d: s.view.distance, t: s.view.target }; })()`) as Promise<{ d: number; t: number[] }>;
	const before = await read();
	await tool(page, "front").click();
	const turned = await read();
	expect(turned.d, "the view buttons do not move the eye closer or further").toBeCloseTo(before.d, 9);
	await tool(page, "fit").click();
	const fitted = await read();
	expect(Math.abs(fitted.t[0]!) + Math.abs(fitted.t[1]!) + Math.abs(fitted.t[2]!), "fit centres the part on the target").toBeLessThan(1e-6);
});

test("the viewer still draws after the layout moves it", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	// Task 10 put the viewer inside a rail-plus-column layout, and the same will happen to any part of this app
	// that gets moved. Lit does not re-run firstUpdated after a re-connect, and the viewer's disconnected path
	// disposes the scene: without the reconnect hook this is a blank canvas for the rest of the page's life.
	const moved = await page.evaluate(`(() => {
		const viewer = ${V}.__CAD_VIEWER__;
		// A holder with a size, in both senses. The viewer is height:100%, so inside a plain block in normal
		// flow it collapses to zero height, every ray-plane intersection comes back NaN, and a broken layout
		// reads exactly like a broken reconnect. It also has to stay on screen for the pointer events to land.
		const holder = document.createElement("div");
		// A holder with a size that stays out of the way. The viewer is height:100%, so in a plain block it
		// collapses to zero, every ray-plane intersection returns NaN, and a broken layout reads exactly like a
		// broken reconnect. It must also not cover the rail: an inset:0 holder swallowed the clicks and this test
		// hung in the hit-target check rather than failing.
		holder.style.cssText = "position: fixed; left: 120px; top: 0; right: 0; bottom: 0; display: flex; z-index: -1;";
		document.body.append(holder);
		viewer.remove();
		holder.append(viewer);
		return customElements.get("cad-viewer") !== undefined;
	})()`);
	expect(moved, "cad-viewer is still defined after the move").toBe(true);
	await page.waitForFunction(() => {
		const v = (globalThis).__CAD_VIEWER__;
		return v.renderRoot.querySelector("canvas.model") !== null;
	});
	const drawn = await drawPx(page, RING_PX);
	expect(drawn.phases, "and it still takes the pen").toContain("end");
	await tool(page, "extrude").click();
	await expect.poll(() => page.evaluate(`(() => document.querySelector("app-main").doc.steps.length)()`)).toBe(1);
});

test("the rail's depth box arrives with a number in it", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await drawPx(page, RING_PX);
	const depth = page.locator("input[data-tool='depth']");
	await expect(depth, "the box appears with the ring").toBeVisible();
	// It arrived blank for a task and a half: the panel filled it in firstUpdated, which ran before any ring was
	// pending, so a press committed 12 mm behind an empty field.
	expect(await depth.inputValue(), "and it shows the depth a press will use").not.toBe("");
});

test("one depth, whichever door typed it", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const stepDepth = (i: number) => page.evaluate(`(() => document.querySelector("app-main").doc.steps[${i}].depth)()`);

	await drawPx(page, RING_PX);
	await page.locator("input[data-tool='depth']").fill("25");
	await tool(page, "extrude").click();
	await expect(stepDepth(0), "the rail's 25 is the document's 25").resolves.toBe(25_000);

	// The door this exposes: the E field opens with whatever the last commit cost. If the rail's number never
	// reaches app-main, the field opens at the default 12 and this second step is 12 mm while the box reads 25.
	await drawPx(page, RING_PX);
	// Out of the box first, because a mouse press on Extrude leaves focus where it was: with the caret still in
	// the number field, E belongs to the field and not to the shortcut (app-main's onKey says so), and a real
	// user's next shortcut happens after they look away from the box.
	await page.locator("input[data-tool='depth']").evaluate((el) => el.blur());
	await page.keyboard.press("e");
	await page.locator("cad-dimension-field input[type=number]").press("Enter");
	await expect(stepDepth(1), "and the keyboard path agrees with it").resolves.toBe(25_000);
});

test("Fit before anything is built says so instead of going blank", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await tool(page, "fit").click();
	// With no faces there are no bounds. Fitting a 0-box put the eye 4 mm from the origin, which on screen is
	// an empty canvas, and the spec names "a failure that reads as nothing happening" as the thing to avoid.
	await expect(page.getByRole("status"), "the press is answered").toContainText(/nothing to fit/i);
	await drawPx(page, RING_PX);
	await tool(page, "extrude").click();
	await expect.poll(() => page.evaluate(`(() => ${V}.__CAD_VIEWER__.mesh.faceCount)()`), "and the first build frames itself").toBe(6);
	await tool(page, "fit").click();
	await expect(page.getByRole("status"), "a Fit with a part on screen is not an error").not.toContainText(/nothing to fit/i);
});

test("select mode refuses the pen", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await tool(page, "select").click();
	await expect(tool(page, "select"), "the mode button shows it is on").toHaveAttribute("aria-pressed", "true");
	const drawn = await drawPx(page, RING_PX);
	expect(drawn.phases, "the viewer still sees the stroke").toContain("end");
	await expect(page.locator("input[data-tool='depth']"), "but nothing is pending, so the rail offers no commit").toHaveCount(0);
	await expect(page.locator("[data-sketch-points]"), "and no step was made").toHaveCount(0);
	await expect(page.getByRole("status"), "and the press is explained rather than swallowed").toContainText(/select mode/i);
});

test("a keystroke inside a number box is typing, not a shortcut", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await drawPx(page, RING_PX);
	const depth = page.locator("input[data-tool='depth']");
	await depth.click();
	// S is "start a new sketch" to the window and a letter to a text box. It has to be the letter: the caret is
	// in the box, and Task 10 put a box on a page that had keyboard shortcuts first.
	await depth.press("s");
	await expect(page.locator("cad-dimension-field"), "no depth field opened, because E was not a shortcut").toHaveCount(0);
	await expect(depth, "the ring is still pending, so S did not discard it").toBeVisible();
	await expect(page.locator("[data-sketch-points]"), "and nothing was committed").toHaveCount(0);
});
