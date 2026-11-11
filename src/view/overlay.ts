// The 2D layer over the model canvas: ink and nothing else. Strokes, snap markers and dimension fields are
// screen-space drawing (spec Architecture: "not scene geometry"), so they get their own canvas and their own
// clear, and never a three.js object.
//
// The canvas is sized in device pixels and scaled back to CSS pixels so callers draw in the same coordinates
// the pointer events carry.
export type Pixel = { x: number; y: number };

export type Overlay = {
	/** Strokes a polyline per argument, in CSS px, on top of whatever is already there. Does not clear. */
	polylines(lines: Pixel[][]): void;
	/** Wipes the layer. The viewer calls it once per frame, before anything is drawn on it. */
	clear(): void;
	/** CSS px. Matches the model canvas so the two stay registered to the pixel. */
	resize(width: number, height: number): void;
	dispose(): void;
};

/** Ink is a fixed width and the page's own text colour, so it reads the same in either theme and never
 *  competes with the solid's edges. */
const INK_WIDTH = 2;

export function createOverlay(canvas: HTMLCanvasElement): Overlay {
	const ctx = canvas.getContext("2d");
	let colour = "black";

	const readColour = (): void => {
		colour = globalThis.getComputedStyle?.(canvas).color || colour;
	};
	readColour();

	const size = (width: number, height: number): void => {
		const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
		canvas.width = Math.max(1, Math.round(width * ratio));
		canvas.height = Math.max(1, Math.round(height * ratio));
		// Re-read on every layout change: a theme flip that changes the page's text colour shows up here
		// without the viewer having to be rebuilt.
		readColour();
		ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
	};

	return {
		polylines(lines: Pixel[][]): void {
			if (!ctx) return;
			ctx.strokeStyle = colour;
			ctx.lineWidth = INK_WIDTH;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			for (const line of lines) {
				if (line.length < 2) continue;
				ctx.beginPath();
				ctx.moveTo(line[0]!.x, line[0]!.y);
				for (const p of line.slice(1)) ctx.lineTo(p.x, p.y);
				ctx.stroke();
			}
		},
		clear(): void {
			if (!ctx) return;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.restore();
		},
		resize: size,
		dispose(): void {
			ctx?.setTransform(1, 0, 0, 1, 0, 0);
		},
	};
}
