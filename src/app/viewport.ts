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
	/** The pen stroke currently on the canvas, in CSS px. It is not ink: ink is what a stroke became. */
	private stroke: Pixel[] = [];
	private fitted = false;
	private frameRequested = false;

	protected render() {
		return html`<canvas class="model" aria-hidden="true"></canvas><canvas class="ink" aria-hidden="true"></canvas>`;
	}

	protected firstUpdated(): void {
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
		// pull-to-axis happens on the pointerup the map already consumed.
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

	private readonly snapped = (): void => {
		this.view((v) => v.snap());
	};

	/** One camera change, then a draw. The gesture map can fire several moves in one frame. */
	private view(then: (view: NonNullable<Scene["view"]>) => void): void {
		if (!this.scene) return;
		then(this.scene.view);
		this.fitted = true;
		this.invalidate();
	}

	private strokePhase(phase: "start" | "move" | "end", points: InkPoint[], pointerType: string): void {
		if (phase === "start") this.stroke = points.map((p) => ({ x: p.x, y: p.y }));
		else if (phase === "move") this.stroke = this.stroke.concat(points.map((p) => ({ x: p.x, y: p.y })));
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
	get camera(): { theta: number; phi: number } {
		return { theta: this.scene?.view.theta ?? 0, phi: this.scene?.view.phi ?? 0 };
	}

	/** Frames the whole part. Called the first time real geometry lands, and by the tool panel's Fit. */
	fit(): void {
		if (!this.scene) return;
		this.scene.fit(meshBounds(this.mesh));
		this.fitted = true;
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
		if (!this.fitted && this.mesh.faceCount > 0) this.fit();
		this.scene.render(this.mesh, this.ink);
		if (this.stroke.length > 1) this.overlay.polylines([this.stroke]);
	}
}

customElements.define("cad-viewer", CadViewer);
