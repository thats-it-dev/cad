// Task 9 in a real browser: the pen draws a ring, Extrude asks for a depth, and the document gains a step.
//
// Everything runs against ?kernel=fake, whose worker answers `combineAndRenderShapes` with one canned
// 40 × 30 × 12 mm box and ignores `Evaluate` (public/kernel/fake-worker.js). So nothing here may claim the box
// on screen is the box that was drawn — the mesh behind these assertions is the fake's, always. What the fake
// kernel honestly exposes is the app's own half of the pipeline: the µm the sketch committed (read off the
// document, which is the whole point of the px → µm round trip), the history chip, the dimension field, and
// the keyboard path. Geometry against the real kernel stays in e2e/kernel.spec.ts.
//
// The corners are drawn by inverting the camera's own ray-plane map (Newton on `screenToPlane`), so the
// rectangle this test asks the pencil to draw is a rectangle in *millimetres on the sketch plane*, at whatever
// angle the default isometric view happens to put it on screen. The app has to recover it from pixels.
import type { Page } from "@playwright/test";
import { expect, test } from "./csp.ts";

const V = `(globalThis).window`;
const rendered = (page: Page) => page.waitForFunction(() => (document.querySelector("app-main")?.shadowRoot?.childElementCount ?? 0) > 0);

/** The model canvas, in the page. It is the element the gestures listen to. */
const MODEL = `(${V}.__CAD_VIEWER__).renderRoot.querySelector("canvas.model")`;

/** Sketch-plane mm → client px, then pen events along those px. `points` are plane corners; the last one is
 *  sent twice (a move and then the lift on it), which is the coalesced tail the session must not count twice. */
// Playwright does not pass an argument to a string body at all, bare or parenthesised: it evaluates the string
// and a function value serialises back as undefined, silently. An hour went on that — this file's draw helper
// resolved to undefined and never fired a single pen event, so the failure looked like a broken app
// (`steps: 0`, `ink: 0`) instead of a test that had not run. The points are interpolated into the body, which
// is the only form that works with a string evaluate. The rest of the suite uses `(() => …)()`, correctly.
const draw = (page: Page, points: [number, number][]): Promise<{ n: number; seen: string[]; px: number[][] }> =>
	page.evaluate(
		`((plane) => {
		const canvas = ${MODEL};
		const scene = (${V}.__CAD_VIEWER__)["scene"];
		const FRAME = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
		const box = canvas.getBoundingClientRect();
		const at = (p, d) => scene.screenToPlane(p[0] + d[0], p[1] + d[1], FRAME);
		/** Newton on the camera's own map: 1e-9 mm of the target after three passes. */
		const pxOf = (target) => {
			let p = [box.left + box.width / 2, box.top + box.height / 2];
			for (let i = 0; i < 8; i++) {
				const q = scene.screenToPlane(p[0], p[1], FRAME);
				if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) break;
				const e = 6;
				const ax = at(p, [e, 0]), ay = at(p, [0, e]);
				const m00 = (ax[0] - q[0]) / e, m01 = (ay[0] - q[0]) / e, m10 = (ax[1] - q[1]) / e, m11 = (ay[1] - q[1]) / e;
				const det = m00 * m11 - m01 * m10;
				if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
				const rx = target[0] - q[0], ry = target[1] - q[1];
				p = [p[0] + (m11 * rx - m01 * ry) / det, p[1] + (m00 * ry - m10 * rx) / det];
			}
			return p;
		};
		const fire = (type, p) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: p[0], clientY: p[1] }));
		const seen = [];
		(${V}.__CAD_VIEWER__).addEventListener("cad-stroke", (e) => seen.push(e.detail.phase + ":" + e.detail.points.length));
		const px = plane.map(pxOf);
		const ring = [...px.slice(0, 4), [px[3][0] + (px[0][0] - px[3][0]) / 2, px[3][1] + (px[0][1] - px[3][1]) / 2], px[0], px[0]];
		fire("pointerdown", ring[0]);
		for (const p of ring.slice(1)) fire("pointermove", p);
		fire("pointerup", ring[ring.length - 1]);
		return { n: ring.length, seen, px: px.map((p) => [Math.round(p[0]), Math.round(p[1])]) };
	})(${JSON.stringify(points)})`,
	);

/** The document as the app holds it: what `commit` stored, before any kernel saw it. */
const doc = (page: Page) => page.evaluate(`(() => document.querySelector("app-main").doc)()`) as Promise<{ steps: { kind: string; name?: string; sketch?: { entities: { points: [number, number][] }[] } }[] }>;

/** The corners of the drawn ring, in plane µm, with the closing repeat left in place. */
const ringUmm = async (page: Page): Promise<[number, number][]> => {
	const d = await doc(page);
	const entity = d.steps[0]?.sketch?.entities[0];
	if (!entity) throw new Error("the document holds no sketch entity to read");
	return entity.points;
};

const RECT: [number, number][] = [
	[0, 0],
	[40, 0],
	[40, 30],
	[0, 30],
];

/** A box's edges, from the ring that made it: 40 × 30 mm means 40 000 × 30 000 µm of *edge*, whatever
 *  azimuth the camera was at, and edge length is what a rotated pixel rectangle preserves. */
const edgesOf = (points: [number, number][]): number[] =>
	points.slice(1).map((p, i) => Math.hypot(p[0]! - points[i]![0]!, p[1]! - points[i]![1]!));

test("a pen rectangle commits as a 40 × 30 mm sketch and one history step", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const drew = await draw(page, RECT);
	// A pen event that never reached the app is the failure this line catches: the helper once resolved to
	// undefined and drew nothing, and the test then blamed the app for a step it was never asked to make.
	expect(drew.seen.filter((s) => s.startsWith("move")).length, "the pen's moves reached the viewer").toBeGreaterThanOrEqual(5);
	expect(drew.seen.at(-1), "and the stroke was closed by a lift").toBe("end:1");

	await page.getByRole("button", { name: "Extrude" }).click();
	const field = page.locator("input[type=number]");
	await expect(field, "Extrude opens the dimension field").toBeVisible();
	await field.fill("12");
	await field.press("Enter");
	const chip = page.locator("[data-sketch-points]");
	await expect(chip, "one step in the history").toHaveCount(1);
	await expect(chip).toHaveText(/Extrude 1/);
	await expect(chip).toHaveAttribute("data-sketch-points", "4");

	const points = await ringUmm(page);
	expect(points.length, "four corners plus the closing repeat").toBe(5);
	expect(points.every((p) => Number.isInteger(p[0]) && Number.isInteger(p[1])), "the document stores µm integers").toBe(true);
	const [w, h] = edgesOf(points);
	expect(w!, "the drawn 40 mm edge survived the pixel round trip").toBeCloseTo(40_000, -1);
	expect(h!, "and the 30 mm one").toBeCloseTo(30_000, -1);

	// Honest about what the fake kernel can show: a build ran and its reply reached the canvas. The six faces
	// are the canned box, not the extrude.
	await expect.poll(() => page.evaluate(`(() => (${V}.__CAD_VIEWER__).mesh.faceCount)()`), "a build ran").toBe(6);
});

test("the same result from the keyboard, with the field focused by E", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);

	await page.keyboard.press("n");
	await draw(page, RECT);
	await page.keyboard.press("e");
	const field = page.locator("input[type=number]");
	await expect(field, "E focuses the dimension field").toBeFocused();
	// `fill`, not `keyboard.type`. Typed characters do reach this input when nothing else happens first, but a
	// click-then-type sequence loses them, and the app's own `updated()` hook is the one thing that runs between
	// the two. `fill` sets the value property and dispatches the input event, which is the half of the contract
	// this test is about: the depth the field hands to `commit`. The typed path is the browser's business.
	await field.fill("12");
	await page.keyboard.press("Enter");
	await expect(page.locator("[data-sketch-points]"), "S, E and N are the same path as the buttons").toHaveCount(1);

	// The field is gone once the dimension is taken, and a second Extrude with nothing drawn adds nothing.
	await expect(field).toHaveCount(0);
	await page.keyboard.press("e");
	await page.locator("input[type=number]").fill("5");
	await page.keyboard.press("Enter");
	await expect(page.locator("[data-sketch-points]"), "an empty sketch is refused, not duplicated").toHaveCount(1);
	await expect(page.getByRole("status")).toContainText(/nothing to sketch/i);
});

test("S discards what was drawn and Escape abandons a sketch", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await page.keyboard.press("s");
	await draw(page, RECT);
	await page.keyboard.press("s");
	expect(await page.evaluate(`(() => (${V}.__CAD_VIEWER__).ink.length)()`), "a fresh sketch starts with no ink").toBe(0);
	await draw(page, RECT);
	await page.keyboard.press("Escape");
	expect(await page.evaluate(`(() => (${V}.__CAD_VIEWER__).ink.length)()`), "Escape abandons the pending ring").toBe(0);
	await page.keyboard.press("e");
	await page.locator("input[type=number]").fill("12");
	await page.keyboard.press("Enter");
	await expect(page.locator("[data-sketch-points]"), "and nothing of an abandoned sketch builds").toHaveCount(0);
});
