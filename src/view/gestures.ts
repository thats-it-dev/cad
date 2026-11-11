// The pointer map: one stream of pointer events in, four camera/ink callbacks out.
//
// The rule this file exists to enforce (spec "Gesture map"): one pen draws, one finger or the mouse orbits,
// two or more fingers pan and pinch, and the fingers must never interrupt the pen. That means routing by
// pointerId, not by "the last pointer that moved": a stroke is keyed to its own pointer from pointerdown to
// pointerup, and a `draw("end")` is emitted exactly once however the pointer leaves (an up, a cancel, or a
// capture that ended without either).
//
// Two details the browser will not do for us. `setPointerCapture` is called per pointerId because capture is
// per-pointer: without it, the implicit touch capture can retarget the pen's events to another element and
// the stroke dies mid-shape. And a fast pen reports most of its positions through `getCoalescedEvents()`
// rather than as separate moves, so ink that reads only `clientX`/`clientY` loses the curves between frames.
export type InkPoint = { x: number; y: number; t: number };

export type GestureHandlers = {
	/** A finger or the mouse dragged across the model: radians per pixel is the listener's business. */
	orbit(dx: number, dy: number): void;
	/** Two or more fingers dragged the model bodily, by the centroid of the group. */
	pan(dx: number, dy: number): void;
	/** Two fingers spread or pinched, `factor` > 1 meaning "show it bigger", about their midpoint. */
	zoom(factor: number, centre: { x: number; y: number }): void;
	/** The pen's own stream. `points` is every coalesced position since the last call, in order. */
	draw(phase: "start" | "move" | "end", points: InkPoint[], pointerType: string): void;
};

/** Wheel notches are coarse: one click of the wheel is ~1.2×, so a two-finger pinch and a wheel feel alike. */
const WHEEL_FACTOR = 0.0018;

/** One live pointer, and where it was last seen. */
type Live = { pen: boolean; x: number; y: number; type: string };

type EventLike = { target: EventTarget | null; pointerId?: number };

export class Gestures {
	private readonly handlers: GestureHandlers;
	private readonly live = new Map<number, Live>();
	private readonly target: EventTarget;
	private readonly bound: [string, (e: Event) => void][] = [];

	constructor(target: EventTarget, handlers: GestureHandlers) {
		this.target = target;
		this.handlers = handlers;
		this.on("pointerdown", (e) => this.down(e as PointerEvent));
		this.on("pointermove", (e) => this.move(e as PointerEvent));
		this.on("pointerup", (e) => this.release(e as PointerEvent));
		this.on("pointercancel", (e) => this.release(e as PointerEvent));
		// A pen that leaves the window, or loses capture some other way, never sees pointerup: its stroke
		// still has to end, or the sketch session waits forever for a shape nobody is drawing.
		this.on("lostpointercapture", (e) => this.release(e as PointerEvent));
		this.on("wheel", (e) => this.wheel(e as WheelEvent));
	}

	dispose(): void {
		for (const [type, fn] of this.bound) this.target.removeEventListener(type, fn);
		this.bound.length = 0;
		this.live.clear();
	}

	private on(type: string, fn: (e: Event) => void): void {
		this.bound.push([type, fn]);
		this.target.addEventListener(type, fn);
	}

	private down(e: PointerEvent): void {
		// A right-drag or a pen barrel button is somebody else's gesture; only the primary button orbits.
		if (e.button !== 0) return;
		capture(e);
		this.live.set(e.pointerId, { pen: e.pointerType === "pen", x: e.clientX, y: e.clientY, type: e.pointerType });
		if (e.pointerType === "pen") this.handlers.draw("start", [point(e)], e.pointerType);
	}

	private move(e: PointerEvent): void {
		const held = this.live.get(e.pointerId);
		// A move with no pointer of ours behind it is a hovering mouse, and a hovering mouse does nothing.
		if (!held) return;
		if (held.pen) {
			const ink = inkOf(e);
			held.x = ink[ink.length - 1]!.x;
			held.y = ink[ink.length - 1]!.y;
			this.handlers.draw("move", ink, e.pointerType);
			return;
		}
		// Pens are excluded from the finger group, so the pair below is unaffected by where the pen is.
		const fingers = [...this.live.entries()].filter(([, v]) => !v.pen);
		if (fingers.length >= 2) this.group(fingers, e);
		else {
			this.handlers.orbit(e.clientX - held.x, e.clientY - held.y);
			held.x = e.clientX;
			held.y = e.clientY;
		}
	}

	/** The centroid of the finger group carries the pan; the spread of the group carries the pinch. */
	private group(fingers: [number, Live][], e: PointerEvent): void {
		const before = centre(fingers);
		const held = this.live.get(e.pointerId);
		if (!held) return;
		held.x = e.clientX;
		held.y = e.clientY;
		const after = centre(fingers);
		this.handlers.pan(after.x - before.x, after.y - before.y);
		// One finger of a pair moving changes the spread too, so this zooms on real spread only: a pinch
		// that halves or doubles the gap, never the wobble of a two-finger drag.
		if (before.spread > 1 && Math.abs(after.spread / before.spread - 1) > 0.08) {
			this.handlers.zoom(after.spread / before.spread, { x: after.x, y: after.y });
		}
	}

	private release(e: PointerEvent): void {
		const held = this.live.get(e.pointerId);
		if (!held) return;
		this.live.delete(e.pointerId);
		if (held.pen) this.handlers.draw("end", [point(e)], e.pointerType);
	}

	private wheel(e: WheelEvent): void {
		e.preventDefault();
		this.handlers.zoom(Math.exp(-e.deltaY * WHEEL_FACTOR), { x: e.clientX, y: e.clientY });
	}
}

/**
 * Capture belongs to one pointer, so capturing the pen's pointer keeps its moves and its up coming to this
 * element even after a finger lands. `hasPointerCapture` guards a re-entrant down; a pointer that has already
 * gone up throws, which means nothing worth reporting.
 */
function capture(e: EventLike & { pointerId: number }): void {
	const el = e.target as (Element & { hasPointerCapture?(id: number): boolean }) | null;
	if (!el || typeof el.setPointerCapture !== "function") return;
	if (el.hasPointerCapture?.(e.pointerId)) return;
	try {
		el.setPointerCapture(e.pointerId);
	} catch {
		/* the pointer is already up */
	}
}

const point = (e: PointerEvent): InkPoint => ({ x: e.clientX, y: e.clientY, t: e.timeStamp });

/** Every position the engine folded into this move, oldest first, falling back to the event's own point. */
function inkOf(e: PointerEvent): InkPoint[] {
	const coalesced = e.getCoalescedEvents?.() ?? [];
	if (coalesced.length === 0) return [point(e)];
	return coalesced.map((c) => ({ x: c.clientX, y: c.clientY, t: c.timeStamp }));
}

function centre(fingers: [number, Live][]): { x: number; y: number; spread: number } {
	const x = fingers.reduce((s, [, v]) => s + v.x, 0) / fingers.length;
	const y = fingers.reduce((s, [, v]) => s + v.y, 0) / fingers.length;
	const spread = fingers.reduce((s, [, v]) => s + Math.hypot(v.x - x, v.y - y), 0) / fingers.length;
	return { x, y, spread };
}
