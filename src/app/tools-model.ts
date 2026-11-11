// The panel's rules, with no Lit and no kit in sight. That is not tidiness: vitest's ESM loader only accepts
// file: and data: URLs, so a module that imports `https://kit.thatsit.app/lit.js` cannot be loaded by a unit
// test at all — the whole `toolsFor` contract would be untestable outside a browser. So the rules live here,
// the rendering lives in tools-panel.ts, and the icons are the element's business, not the model's.
import type { Pending, Selection } from "./doc-state.ts";

export type Mode = "sketch" | "select";

export type ToolId = "sketch" | "select" | "extrude" | "cut" | "delete" | "cancel" | "front" | "top" | "right" | "iso" | "fit" | "depth";

export type ToolsState = { mode: Mode; pending: Pending | null; selection: Selection; steps: number; busy: boolean };

export type Tool = {
	id: ToolId;
	/** `depth` is the one part that is not a button: a number box, because v1 types dimensions (spec Decided). */
	kind: "button" | "depth";
	label: string;
	/** True for the mode button the app is in, so the panel says what the tool is doing without a caption. */
	pressed: boolean;
	enabled: boolean;
	/** Whether pressing it changes the document. Everything that does is dead while a build is running. */
	mutates: boolean;
};

/** What a fresh sketch is extruded to, and what the depth box opens with. 12 mm is the plan's example part. */
export const DEFAULT_DEPTH_MM = 12;

/**
 * The panel's contents, in the order they appear.
 *
 * The rule this exists to make testable is "no Extrude button without a sketch". A panel that kept its own
 * copy of whether a sketch was pending would disagree with the canvas the first time a build failed, and the
 * disagreement would read as a button that does nothing — the spec's one anti-goal a tool falls into by
 * omission.
 */
export function toolsFor(state: ToolsState): Tool[] {
	const idle = !state.busy;
	const hasSketch = state.pending !== null && state.pending.entities.length > 0;
	const out: Tool[] = [
		{ id: "sketch", kind: "button", label: "Sketch", pressed: state.mode === "sketch", enabled: true, mutates: false },
		{ id: "select", kind: "button", label: "Select", pressed: state.mode === "select", enabled: true, mutates: false },
	];
	// The depth box belongs to the sketch, not to the panel: with nothing drawn there is no number to act on,
	// and a box that sits there doing nothing is the "failure that reads as nothing happening" the spec calls
	// out. It appears, along with Extrude and Cut, the moment a ring closes. (plan Task 10 step 1)
	if (hasSketch) {
		out.push({ id: "depth", kind: "depth", label: "Depth", pressed: false, enabled: idle, mutates: true });
		out.push({ id: "extrude", kind: "button", label: "Extrude", pressed: false, enabled: idle, mutates: true });
		out.push({ id: "cut", kind: "button", label: "Cut", pressed: false, enabled: idle, mutates: true });
	}
	// Delete needs a step to delete. Selection is Task 11's, so until then the button is there and inert,
	// which is honest: it shows the app knows about steps without pretending to have picked one.
	if (state.steps > 0) out.push({ id: "delete", kind: "button", label: "Delete step", pressed: false, enabled: idle && state.selection !== null, mutates: true });
	// The views are not a menu and they are not floating over the canvas either (spec anti-goal), so they live
	// here. They are camera angles only: `fit` is the one button that changes framing.
	out.push(
		{ id: "front", kind: "button", label: "Front", pressed: false, enabled: true, mutates: false },
		{ id: "top", kind: "button", label: "Top", pressed: false, enabled: true, mutates: false },
		{ id: "right", kind: "button", label: "Right", pressed: false, enabled: true, mutates: false },
		{ id: "iso", kind: "button", label: "Isometric", pressed: false, enabled: true, mutates: false },
		{ id: "fit", kind: "button", label: "Fit to part", pressed: false, enabled: true, mutates: false },
	);
	return out;
}

/**
 * The four camera angles, one source for the panel, the keyboard and the e2e. φ is the polar angle from +Z,
 * which is the spherical convention `src/view/scene.ts` reads.
 *
 * `top` is a hair off the pole rather than on it: at φ = 0 the eye sits on +Z, parallel to `camera.up`, so
 * `cross(up, eye)` is the zero vector and `normalize()` returns NaN — a camera that renders nothing and a
 * sketch plane nothing can be drawn on. three.js' own controls clamp φ to the same 1e-6 for the same reason.
 */
export const VIEWS: Record<"front" | "top" | "right" | "iso", { theta: number; phi: number }> = {
	front: { theta: 0, phi: Math.PI / 2 },
	top: { theta: 0, phi: 1e-6 },
	right: { theta: Math.PI / 2, phi: Math.PI / 2 },
	iso: { theta: Math.PI / 4, phi: Math.acos(1 / Math.sqrt(3)) },
};
