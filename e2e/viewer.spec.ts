// The viewer, in a real browser: two canvases, the ink layer on top, and the gestures that decide which
// layer a pointer belongs to. Everything here runs against ?kernel=fake, whose worker answers
// `combineAndRenderShapes` with one canned 40 × 30 × 12 mm box (public/kernel/fake-worker.js). It computes
// nothing, so what these tests can honestly claim is "a mesh-shaped reply reaches the canvas and is drawn",
// not "the kernel built a box" — that claim belongs to e2e/kernel.spec.ts.
import type { Page } from "@playwright/test";
import { expect, test } from "./csp.ts";
import { decodeMesh, type Mesh } from "../src/kernel/decode.ts";

const rendered = (page: Page) => page.waitForFunction(() => (document.querySelector("app-main")?.shadowRoot?.childElementCount ?? 0) > 0);

const V = `(globalThis).window`;
const CANVAS = (cls: string) => `${V}.__CAD_VIEWER__.renderRoot.querySelector("canvas.${cls}")`;
// Every page.evaluate string here is a parenthesised expression: Playwright evaluates a bare function
// literal without calling it, and an `return` at the top of a bare block is a syntax error.
const CAMERA = `(${V}.__CAD_VIEWER__).camera`;

/** One canvas's box in CSS px plus its backing-store size. A string body, because a Playwright callback is
 *  compiled against Node's globals and `window` is not one of them. */
const geometryOf = (cls: string) =>
	`(() => { const c = ${CANVAS(cls)}; const b = c.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), px: c.width, py: c.height }; })()`;

/** Painted pixels on the ink layer. 2D readback is exact, where a WebGL buffer may already be swapped. */
const inkPixels = `(() => { const c = ${CANVAS("ink")}; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++; return painted; })()`;

/** Asks the worker on the same envelope KernelClient uses, and decodes the reply here in Node.
 *  There is no client import: this runs against a built page, where a raw /src/*.ts URL is not fetchable. */
async function stubMesh(page: Page): Promise<Mesh> {
	const raw = (await page.evaluate(`(() => {
		const w = new Worker(${V}.__CAD_KERNEL__, { type: "module" });
		const reply = new Promise((resolve) => { w.onmessage = (e) => { if (e.data?.type === "combineAndRenderShapes") resolve(e.data.payload); }; });
		w.postMessage({ type: "combineAndRenderShapes", payload: { maxDeviation: 0.1, sceneOptions: {} }, requestId: 1 });
		return reply;
	})()`)) as [[{ face_index: number }[], { edge_index: number }[]], unknown];
	return decodeMesh({ faces: raw[0][0] as never, edges: raw[0][1] as never });
}

/** Hands a mesh to the viewer. Typed arrays do not survive the trip to the page as themselves, so the JSON
 *  comes back as arrays and is rebuilt on the other side. */
async function showMesh(page: Page, mesh: Mesh): Promise<void> {
	// A Float32Array serialises as {"0":…, "1":…}, not as an array, so the arrays are made explicit here and
	// rebuilt into typed arrays on the other side. This round trip is also how the harness can say "the viewer
	// was handed 72 floats" rather than trusting that a JSON blob survived the trip to the page.
	const json = JSON.stringify({
		...mesh,
		positions: Array.from(mesh.positions),
		normals: Array.from(mesh.normals),
		indices: Array.from(mesh.indices),
		edgePositions: Array.from(mesh.edgePositions),
		edgeIndices: Array.from(mesh.edgeIndices),
	});
	await page.evaluate(
		(s: string) => {
			let m: Record<string, unknown>;
			try {
				m = JSON.parse(s) as Record<string, unknown>;
			} catch (e) {
				throw new Error(`the mesh did not survive the trip to the page: ${String(e)}`);
			}
			const v = (globalThis["window" as never] as unknown as { __CAD_VIEWER__: { mesh: unknown; fit(): void } }).__CAD_VIEWER__;
			v.mesh = {
				...m,
				positions: Float32Array.from(m.positions as number[]),
				normals: Float32Array.from(m.normals as number[]),
				indices: Uint32Array.from(m.indices as number[]),
				edgePositions: Float32Array.from(m.edgePositions as number[]),
				edgeIndices: Int32Array.from(m.edgeIndices as number[]),
			} as Mesh;
			v.fit();
		},
		json,
	);
	await page.evaluate(`(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
}

test("<cad-viewer> fills the page with two aligned canvases", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	expect(await page.evaluate(`(() => ${V}.__CAD_VIEWER__ != null)()`), "the viewer is mounted").toBe(true);

	const model = (await page.evaluate(geometryOf("model"))) as { w: number; h: number; px: number; py: number };
	const ink = (await page.evaluate(geometryOf("ink"))) as typeof model;
	expect(model.w, "the model canvas spans the viewport").toBeGreaterThanOrEqual(300);
	expect(model.h).toBeGreaterThanOrEqual(300);
	expect(ink, "the ink layer is the same box, so ink cannot drift off the model").toEqual(model);
});

test("both canvases refuse the browser's own gestures", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const rules = (await page.evaluate(
		`(() => { const v = ${V}.__CAD_VIEWER__; return [...v.renderRoot.adoptedStyleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\\n"); })()`,
	)) as string;
	expect(rules, "a one-finger drag would otherwise be claimed by the browser for page scroll").toContain("touch-action: none");
	const computed = (await page.evaluate(
		`[...${V}.__CAD_VIEWER__.renderRoot.querySelectorAll("canvas")].map((c) => getComputedStyle(c).touchAction)`,
	)) as string[];
	expect(computed, "and it is in effect on both canvases").toEqual(["none", "none"]);
});

test("a mesh from the stub kernel reaches a canvas that is not blank", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const mesh = await stubMesh(page);
	expect(mesh.faceCount, "the canned box has six faces, and six is what the viewer is handed").toBe(6);
	expect(mesh.edgeCount).toBeGreaterThan(0);
	await showMesh(page, mesh);

	const painted = (await page.evaluate(`(() => {
		const v = ${V}.__CAD_VIEWER__;
		const c = ${CANVAS("model")};
		const b = c.getBoundingClientRect();
		const gl = c.getContext("webgl2") ?? c.getContext("webgl");
		if (!gl) return { ok: false, distinct: 0, samples: 0, preserved: false };
		const px = new Uint8Array(c.width * c.height * 4);
		gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
		let distinct = 0;
		const stride = 4 * 997;
		for (let i = stride; i < px.length; i += stride) if (px[i] !== px[0] || px[i + 3] !== px[3]) distinct++;
		return { ok: true, distinct, samples: Math.floor(px.length / stride) - 1, preserved: gl.getContextAttributes()?.preserveDrawingBuffer === true, rect: [b.width, b.height], store: [c.width, c.height], glerr: gl.getError(), dpr: devicePixelRatio, floats: v.mesh.positions.length, faces: v.mesh.faceCount };
	})()`)) as { ok: boolean; distinct: number; samples: number; preserved: boolean; rect: number[]; store: number[]; glerr: number; dpr: number; floats: number; faces: number };
	expect(painted.ok, "the model canvas has a WebGL context").toBe(true);
	expect(painted.faces, "the page holds a six-face mesh").toBe(6);
	expect(painted.floats, "with every vertex in it (6 faces x 4 corners x 3 axes)").toBe(6 * 4 * 3);
	expect(painted.preserved, "the drawing buffer survives to be read back").toBe(true);
	expect(painted.distinct, `a shaded solid differs from a cleared buffer over ${painted.samples} samples`).toBeGreaterThan(2);
});

test("the pen's stroke lands on the ink layer, and reports its phases", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const before = (await page.evaluate(inkPixels)) as number;
	const down = await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		const seen = [];
		${V}.__CAD_VIEWER__.addEventListener("cad-stroke", (e) => seen.push(e.detail.phase + ":" + e.detail.pointerType));
		// page.mouse cannot report pointerType "pen", so the pen's events are dispatched, not synthesised.
		const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: x, clientY: y }));
		const ring = [[40, 40], [140, 60], [160, 160], [60, 150], [40, 40]];
		fire("pointerdown", ...ring[0]);
		for (const p of ring.slice(1)) fire("pointermove", ...p);
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ seen, painted: ${inkPixels} }))));
	})()`);
	expect(down.seen.slice(0, 5), "a pen stroke starts and moves, and says what drew it").toEqual(["start:pen", "move:pen", "move:pen", "move:pen", "move:pen"]);
	expect(down.painted, "ink is drawn on the 2D layer while the stroke is live").toBeGreaterThan(before);
	const after = await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: 40, clientY: 40 }));
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(${inkPixels}))));
	})()`);
	expect(after, "the live stroke is transient ink: it clears when the pen lifts, and what remains is entities").toBe(before);
});

test("a mouse drag orbits, and release snaps only when the camera is near an axis", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const camera = async () => (await page.evaluate(CAMERA)) as { theta: number; phi: number };
	const quarter = Math.PI / 2;
	const nearAxis = (v: number) => Math.abs(v / quarter - Math.round(v / quarter)) < 0.02;
	const drag = async (dx: number, dy: number) => {
		await page.mouse.move(220, 220);
		await page.mouse.down();
		await page.mouse.move(220 + dx, 220 + dy, { steps: 6 });
		const during = await camera();
		await page.mouse.up();
		return { during, after: await camera() };
	};

	const first = await camera();
	// The browser's half of the snap contract, which is the part a unit test cannot make: whatever the release
	// decides, the camera must not teleport. A 6° pull is the most snapCamera is allowed to move a view that is
	// not near an axis; anything larger is the camera lying about where the user left it. The arithmetic of
	// which axis is nearest, and the 6° window itself, are test/view.test.ts's job.
	const small = await drag(30, 0);
	expect(small.during.theta, "mouse parity: 30 px of drag is 0.052 rad").toBeCloseTo(first.theta - 30 * (Math.PI / 2 / 300), 6);
	expect(Math.abs(small.after.theta - small.during.theta), "release moves the camera by at most the snap window").toBeLessThanOrEqual((6 * Math.PI) / 180 + 1e-9);
	expect(Math.abs(small.after.phi - small.during.phi), "in both angles").toBeLessThanOrEqual((6 * Math.PI) / 180 + 1e-9);

	// 240 px is a 72° swing, which is nowhere near an axis; snapping it would be the camera lying about
	// where the user left it.
	const big = await drag(240, 0);
	expect(Math.abs(big.after.theta - big.during.theta), "a far release leaves the camera where it was put").toBeLessThan(1e-9);
	expect(nearAxis(big.after.theta), "and it really is off-axis").toBe(false);
});
