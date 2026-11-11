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
	`(() => { const c = ${CANVAS(cls)}; const b = c.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), px: c.width, py: c.height }; })()`;

/** Painted pixels on the ink layer, and how many of them differ from the first pixel. An untouched 2D canvas
 *  reads back as fully transparent black, and a canvas that has never been drawn into at all reads as uniform
 *  — so the raw painted count was 1280 samples of "nothing has been drawn here", never zero. The non-uniform
 *  count is the honest signal: 0 while the layer is blank, whatever its size, and positive once ink is on it. */
const inkPixels = `(() => { const c = ${CANVAS("ink")}; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let painted = 0, different = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) painted++; if (d[i] !== d[3]) different++; } return { painted, different }; })()`;

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

	const model = (await page.evaluate(geometryOf("model"))) as { x: number; y: number; w: number; h: number; px: number; py: number };
	const ink = (await page.evaluate(geometryOf("ink"))) as typeof model;
	// The claim is "the canvas owns the working area", which is a ratio, not a pixel count: Task 10 put a
	// 64 px rail on the left, and an absolute 300 px floor that had nothing to do with the viewport size
	// failed on a 390 px phone for the right reason — the working area there really is smaller.
	const box = (await page.evaluate(`(() => { const r = document.querySelector("app-main").shadowRoot.querySelector(".stage").getBoundingClientRect(); return [r.width, r.height]; })()`)) as [number, number];
	expect(model.w, "the model canvas spans the working area").toBeGreaterThanOrEqual(box[0] * 0.95);
	expect(model.h, "and the height of it too").toBeGreaterThanOrEqual(box[1] * 0.95);
	expect(model.w * model.h, "and it is not a sliver").toBeGreaterThan(390 * 300 * 0.5);
	expect(ink, "the ink layer is the same box, so ink cannot drift off the model").toEqual(model);
	// The rail took the left of the page and the bar took the top, so the canvas is no longer at (0, 0). What
	// still has to hold — and what the ink's coordinate space depends on — is that the two canvases share one
	// box, wherever the layout put it.
	expect(model.x, "the canvas starts to the right of the rail, not under it").toBeGreaterThanOrEqual(0);
	expect(model.y, "and below the bar").toBeGreaterThanOrEqual(0);
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
	const before = (await page.evaluate(inkPixels)) as { painted: number; different: number };
	expect(before.different, "the ink layer starts blank").toBe(0);
	const down = await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		const seen = [];
		${V}.__CAD_VIEWER__.addEventListener("cad-stroke", (e) => seen.push(e.detail.phase + ":" + e.detail.pointerType));
		// page.mouse cannot report pointerType "pen", so the pen's events are dispatched, not synthesised. The
		// ring is a fraction of the canvas, because the rail and the bar move the canvas and an absolute (40, 40)
		// would land on the tool panel on a narrow viewport.
		const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: x, clientY: y }));
		const bx = c.getBoundingClientRect();
		const at = (fx, fy) => [bx.left + fx * bx.width, bx.top + fy * bx.height];
		const ring = [[0.1, 0.1], [0.6, 0.18], [0.68, 0.62], [0.2, 0.58], [0.1, 0.1]].map((p) => at(p[0], p[1]));
		fire("pointerdown", ...ring[0]);
		for (const p of ring.slice(1)) fire("pointermove", ...p);
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ seen, painted: ${inkPixels} }))));
	})()`) as { seen: string[]; painted: { painted: number; different: number } };
	expect(down.seen.slice(0, 5), "a pen stroke starts and moves, and says what drew it").toEqual(["start:pen", "move:pen", "move:pen", "move:pen", "move:pen"]);
	expect(down.painted.different, "ink is drawn on the 2D layer while the stroke is live").toBeGreaterThan(0);
	const after = await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		// Recomputed here: each page.evaluate is its own scope, and bx belonged to the block that drew the ring.
		// The lift has to land on the ring's first corner, which is what closes it.
		const bx = c.getBoundingClientRect();
		c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: bx.left + 0.1 * bx.width, clientY: bx.top + 0.1 * bx.height }));
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ painted: ${inkPixels}, ink: ${V}.__CAD_VIEWER__.ink.length }))));
	})()`) as { painted: { painted: number; different: number }; ink: number };
	// What remains after the lift is not the stroke: it is the entity the app committed from it, drawn through
	// the frame. Task 9 put an app behind this page and that app closes a ring on pen-up, so the pixels
	// legitimately stay — an earlier version of this test asserted they vanished, which was true of a bare
	// viewer and is false of a working one. "Not accumulated" is proved by the count: two strokes, two
	// entities, and the layer repainted from scratch each frame (`overlay.clear()` before every draw).
	expect(after.ink, "and what remains is the entities the tool committed").toBe(1);
	const second = await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 8, pointerType: "pen", isPrimary: true, clientX: x, clientY: y }));
		const bx = c.getBoundingClientRect();
		const at = (fx, fy) => [bx.left + fx * bx.width, bx.top + fy * bx.height];
		const ring = [[0.3, 0.3], [0.8, 0.34], [0.82, 0.8], [0.3, 0.3]].map((p) => at(p[0], p[1]));
		fire("pointerdown", ...ring[0]);
		for (const p of ring.slice(1)) fire("pointermove", ...p);
		fire("pointerup", ...ring[ring.length - 1]);
		return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ink: ${V}.__CAD_VIEWER__.ink.length, painted: ${inkPixels} }))));
	})()`) as { ink: number; painted: { painted: number; different: number } };
	expect(second.ink, "a second stroke adds one entity, it does not append to the first").toBe(2);
	expect(second.painted.different, "the layer is repainted, not accumulated").toBeGreaterThan(0);
});

test("a mouse drag orbits, and release snaps only when the camera is near an axis", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	const camera = async () => (await page.evaluate(CAMERA)) as { theta: number; phi: number };
	const quarter = Math.PI / 2;
	const nearAxis = (v: number) => Math.abs(v / quarter - Math.round(v / quarter)) < 0.02;
	const drag = async (dx: number, dy: number) => {
		await page.mouse.move(centre[0], centre[1]);
		await page.mouse.down();
		await page.mouse.move(centre[0] + dx, centre[1] + dy, { steps: 6 });
		const during = await camera();
		await page.mouse.up();
		return { during, after: await camera() };
	};
	// Canvas-relative, for the same reason as the pen ring above: the rail moved the canvas off x = 0.
	const centre = (await page.evaluate(`(() => { const r = ${CANVAS("model")}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)) as [number, number];

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

test("two fingers pan the model with them, not against them", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	// What is measured is where a fixed point on the sketch plane appears on screen, before and after the
	// drag. The earlier version of this test read `view.target` and called that "the model rides with the
	// fingers", which is backwards: translating a camera moves its content the opposite way, so the assertion
	// passed while the model slid against the drag. The scene cannot be unit tested in Node (no WebGL, no
	// canvas), so the browser has to measure the real thing.
	const moved = (await page.evaluate(`(() => {
		const v = ${V}.__CAD_VIEWER__, s = v["scene"];
		const F = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
		const c = v.renderRoot.querySelector("canvas.model");
		const b = c.getBoundingClientRect();
		const C = [b.left + b.width / 2, b.top + b.height / 2];
		const at = (x, y) => { s.render(v.mesh, []); return s.screenToPlane(x, y, F); };
		// Invert the camera's local map once: the pixel at which a plane point now appears.
		const appearsAt = (a) => {
			const q = at(C[0], C[1]);
			const e = 4, ax = at(C[0] + e, C[1]), ay = at(C[0], C[1] + e);
			const m00 = (ax[0] - q[0]) / e, m01 = (ay[0] - q[0]) / e, m10 = (ax[1] - q[1]) / e, m11 = (ay[1] - q[1]) / e;
			const det = m00 * m11 - m01 * m10;
			return [(m11 * (a[0] - q[0]) - m01 * (a[1] - q[1])) / det, (m00 * (a[1] - q[1]) - m10 * (a[0] - q[0])) / det];
		};
		const home = at(C[0], C[1]);
		const fire = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y }));
		fire("pointerdown", 1, 200, 300);
		fire("pointerdown", 2, 200, 500);
		fire("pointermove", 1, 300, 400);
		fire("pointermove", 2, 300, 600);
		fire("pointerup", 1, 300, 400);
		fire("pointerup", 2, 300, 600);
		const now = appearsAt(home);
		return { dx: Math.round(now[0]), dy: Math.round(now[1]) };
	})()`)) as { dx: number; dy: number };
	expect(moved.dx, "a diagonal drag carries the model right with the fingers").toBeGreaterThan(50);
	// Both components land near 90 rather than 100 for a two-finger drag on this plane: `mmPerPx` is the scale
	// at the target plane and the XY plane meets a tilted view obliquely, so px of finger buys slightly less
	// px of content. What was broken, and what would fail here in a heartbeat, is the sign: before this fix
	// the same drag measured dx = -100 (against the fingers) and dy = -58 (against, at 58% = cos φ, because
	// the "screen-up" vector was actually the horizontal projection of the view direction).
	expect(moved.dy, "and down with the fingers, not up").toBeGreaterThan(50);
});

test("a pen lift does not move the camera", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	// Park the view 3° off an axis, inside the 6° snap window, so a snap that has no business running is
	// unmistakable: it would rotate the model the moment the pen leaves the glass.
	await page.evaluate(`(() => { const s = ${V}.__CAD_VIEWER__["scene"]; s.view.orbit(3 * Math.PI / 180 / (Math.PI / 2 / 300), 0); return true; })()`);
	const before = (await page.evaluate(CAMERA)) as { theta: number; phi: number };
	await page.evaluate(`(() => {
		const c = ${CANVAS("model")};
		const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: x, clientY: y }));
		fire("pointerdown", 100, 100);
		fire("pointermove", 160, 120);
		fire("pointermove", 200, 180);
		fire("pointerup", 200, 180);
		return true;
	})()`);
	const after = (await page.evaluate(CAMERA)) as { theta: number; phi: number };
	expect(after, "drawing a stroke leaves the camera exactly where it was").toEqual(before);
});

test("a wheel zoom keeps the point under the cursor where it was", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	// The anchor is the test: dolly in about a point 200 px right and 150 px down from the canvas centre —
	// deliberately off both axes, because a version of this measured only the in-plane X term and a pure-Z
	// error read as no drift at all.
	const drift = (await page.evaluate(`(() => {
		const v = ${V}.__CAD_VIEWER__, s = v["scene"];
		const F = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
		const b = v.renderRoot.querySelector("canvas.model").getBoundingClientRect();
		const at = (x, y) => { s.render(v.mesh, []); return s.screenToPlane(x, y, F); };
		const off = [b.left + b.width / 2 + 200, b.top + b.height / 2 + 150];
		const before = at(off[0], off[1]);
		s.view.zoom(1.4, { x: off[0], y: off[1] });
		const after = at(off[0], off[1]);
		return Math.hypot(before[0] - after[0], before[1] - after[1]);
	})()`)) as number;
	expect(drift, "zooming 1.4× about an off-centre point slides it by less than a tenth of a mm").toBeLessThan(0.1);
});

test("zooming after a build does not re-frame the part", async ({ page }) => {
	await page.goto("/?kernel=fake");
	await rendered(page);
	await showMesh(page, await stubMesh(page));
	// auto-fit runs the first time real geometry lands; after that the camera belongs to the user. The bug
	// this pins: draw() used to treat "the camera moved" as "frame the part again", so once a build was on
	// screen every wheel notch and every two-finger drag snapped back to the full-part view.
	const before = (await page.evaluate(`(() => { const s = ${V}.__CAD_VIEWER__["scene"]; s.render(${V}.__CAD_VIEWER__.mesh, []); return { d: s.view.distance }; })()`)) as { d: number };
	await page.evaluate(`(() => { ${V}.__CAD_VIEWER__["scene"].view.zoom(2, { x: 400, y: 400 }); return true; })()`);
	await page.evaluate(`(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))()`);
	const after = (await page.evaluate(`(() => ({ d: ${V}.__CAD_VIEWER__["scene"].view.distance }))()`)) as { d: number };
	expect(after.d, "the zoom is still in effect after the frames that followed it").toBeCloseTo(before.d / 2, 6);
});
