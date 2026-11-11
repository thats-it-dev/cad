// `<cad-viewer>` — the two canvases. A WebGL canvas for the solid, a 2D canvas over it for ink, and the
// pointer map that decides which one a gesture belongs to.
//
// The element owns no document and starts no kernel: a parent pushes a `Mesh` in (the thing `KernelClient`
// and `Rebuilder` produce) and the viewer draws it. `interactive` is off for a thumbnail or a preview, where
// the canvases should show geometry without taking fingers.
//
// Why two canvases rather than one: the pen draws *into the model*, so the sketch layer cannot be scene
// geometry (docs/spec.md, Architecture). It is screen-space ink over the top, cleared and redrawn every
// frame, and it stays aligned with the model because `resize` gives both canvases the same box and the same
// device-pixel ratio.
import { LitElement, css, html } from "https://kit.thatsit.app/lit.js";
import { EMPTY_MESH, type Mesh } from "../kernel/decode.ts";
import type { Entity } from "../model/types.ts";
import type { Frame2 } from "../sketch/frame.ts";
import { createOverlay, type Overlay, type Pixel } from "../view/overlay.ts";
import { Gestures, type InkPoint } from "../view/gestures.ts";
import { createScene, meshBounds, type Scene } from "../view/scene.ts";

/** The model's own sketch plane: XY through the origin, unit axes, in millimetres. */
const WORLD_XY: Frame2 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };

export class CadViewer extends LitElement {
	static properties = {
		mesh: { type: Object },
		ink: { type: Object },
		frame: { type: Object },
		interactive: { type: Boolean, reflect: true },
	};

	static styles = css`
		:host {
			display: block;
			position: relative;
			width: 100%;
			height: 100%;
			overflow: hidden;
		}
		canvas {
			display: block;
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			/* Without this the browser claims a one-finger drag for page scroll and the orbit never sees
			   the move; the pen would be cancelled the same way. */
			touch-action: none;
		}
		.ink {
			pointer-events: none;
		}
		/* Only the model canvas takes pointers, so a stroke cannot land on a layer that ignores it. */
		:host(:not([interactive])) canvas {
			pointer-events: none;
		}
	`;

	mesh: Mesh = EMPTY_MESH;
	ink: Entity[] = [];
	frame: Frame2 = WORLD_XY;
	interactive = true;

	private scene: Scene | null = null;
	private overlay: Overlay | null = null;
	private gestures: Gestures | null = null;
	private observer: ResizeObserver | null = null;
	/** Whether a whole part has ever been framed. Set only by fit(), so an orbit before the first build lands
	 *  cannot make the part arrive unframed (review P2). */
	private fitted = false;
	/** Whether the camera moved since the last fit. */
	private touched = false;
	/** The pen stroke currently on the canvas, in the ink canvas's own px. It is not ink: ink is what a stroke became. */
	private stroke: Pixel[] = [];
	private frameRequested = false;

	protected render() {
		return html`<canvas class="model" aria-hidden="true"></canvas><canvas class="ink" aria-hidden="true"></canvas>`;
	}

	protected firstUpdated(): void {
		this.start();
	}

	/** Wire up the canvases. Called once from firstUpdated, and again after a re-connect, because disposing on
	 *  disconnect and never re-creating left both canvases blank for the rest of the page's life. */
	private start(): void {
		if (this.scene) return;
		const canvases = this.renderRoot.querySelectorAll("canvas");
		const model = canvases[0] as HTMLCanvasElement;
		const ink = canvases[1] as HTMLCanvasElement;
		this.overlay = createOverlay(ink);
		this.scene = createScene(model, this.overlay);
		this.scene.frame = this.frame;
		this.gestures = new Gestures(model, {
			orbit: (dx, dy) => this.view((v) => v.orbit(dx, dy)),
			pan: (dx, dy) => this.view((v) => v.pan(dx, dy)),
			zoom: (factor, centre) => this.view((v) => v.zoom(factor, centre)),
			draw: (phase, points, pointerType) => this.strokePhase(phase, points, pointerType),
		});
		// Snap on release: the gesture map reports movement, not the end of a camera gesture, so the
		// pull-to-axis happens on the pointerup the map already consumed. The pen's pointerup is not a camera
		// gesture — snapping there would rotate the view under a sketch stroke mid-drawing.
		model.addEventListener("pointerup", this.snapped);
		model.addEventListener("pointercancel", this.snapped);
		this.observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box) this.resize(box.width, box.height);
		});
		this.observer.observe(this.renderRoot.querySelector("canvas") ?? this);
		this.invalidate();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		const model = this.renderRoot?.querySelector("canvas.model");
		model?.removeEventListener("pointerup", this.snapped);
		model?.removeEventListener("pointercancel", this.snapped);
		this.gestures?.dispose();
		this.gestures = null;
		this.observer?.disconnect();
		this.observer = null;
		this.scene?.dispose();
		this.scene = null;
		this.overlay?.dispose();
		this.overlay = null;
	}

	protected updated(): void {
		if (this.scene) this.scene.frame = this.frame;
		this.invalidate();
	}

	private readonly snapped = (event: Event): void => {
		if ((event as PointerEvent).pointerType === "pen") return;
		this.view((v) => v.snap());
	};

	/** One camera change, then a draw. The gesture map can fire several moves in one frame. */
	private view(then: (view: NonNullable<Scene["view"]>) => void): void {
		if (!this.scene) return;
		then(this.scene.view);
		this.touched = true;
		this.invalidate();
	}

	/** Live ink in the overlay's own px: the gestures report client coordinates, the canvas is positioned
	 *  wherever the host put it, and a thumbnail off (0,0) would otherwise draw its ink offset. */
	private strokePhase(phase: "start" | "move" | "end", points: InkPoint[], pointerType: string): void {
		const rect = (this.renderRoot.querySelector("canvas.ink") as HTMLCanvasElement | null)?.getBoundingClientRect();
		const local = points.map((p) => ({ x: p.x - (rect?.left ?? 0), y: p.y - (rect?.top ?? 0) }));
		if (phase === "start") this.stroke = local;
		else if (phase === "move") this.stroke = this.stroke.concat(local);
		else this.stroke = [];
		// The viewer draws the stroke; what it *means* (a sketch, a selection, a drag handle) is the active
		// tool's business, and Task 9 is the first to listen.
		this.dispatchEvent(new CustomEvent("cad-stroke", { detail: { phase, points, pointerType } }));
		this.invalidate();
	}

	private resize(width: number, height: number): void {
		this.scene?.resize(width, height);
		this.invalidate();
	}

	/** The orbit, for the tool panel's axis buttons (Task 10) and for the e2e that has to prove a drag moved
	 *  the camera. A copy: the camera belongs to the scene, and nothing outside it should steer it. */
	get camera(): { theta: number; phi: number; target: [number, number, number] } {
		const v = this.scene?.view;
		return { theta: v?.theta ?? 0, phi: v?.phi ?? 0, target: [v?.target[0] ?? 0, v?.target[1] ?? 0, v?.target[2] ?? 0] };
	}

	/** Client px → mm on `plane`, through the same camera that drew the pixel the pencil is on. The sketch tool
	 *  converts strokes with this and needs nothing else of the scene, so `scene` stays private (and the e2e's
	 *  `viewer["scene"]` reaches-in stays in the e2e). A NaN pair means the ray never meets the plane. */
	screenToPlane(clientX: number, clientY: number, plane: Frame2): [number, number] {
		return this.scene?.screenToPlane(clientX, clientY, plane) ?? [Number.NaN, Number.NaN];
	}

	/** Frames the whole part. Called the first time real geometry lands, and by the tool panel's Fit. */
	fit(): void {
		if (!this.scene) return;
		this.scene.fit(meshBounds(this.mesh));
		this.fitted = true;
		this.touched = false;
		this.invalidate();
	}

	private invalidate(): void {
		if (this.frameRequested || !this.scene) return;
		this.frameRequested = true;
		requestAnimationFrame(() => {
			this.frameRequested = false;
			this.draw();
		});
	}

	private draw(): void {
		if (!this.scene || !this.overlay) return;
		// A part that has never been framed gets framed, or the first thing the user sees is empty canvas.
		// "Never been framed" means fit() has not run, not that the camera has not moved: a flick before the
		// first build landed must still frame the part when it arrives.
		if ((!this.fitted || (this.touched && this.mesh.faceCount > 0)) && this.mesh.faceCount > 0) this.fit();
		this.scene.render(this.mesh, this.ink);
		if (this.stroke.length > 1) this.overlay.polylines([this.stroke]);
	}
}

customElements.define("cad-viewer", CadViewer);
