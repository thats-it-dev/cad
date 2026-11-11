// The history strip: one chip per step. Task 11 turns this into the real history panel (names, inline depth
// edit, broken-step marks), which is why it is a module and not a line of app-main's template — the
// composition root is the file that has to stay a list of parts, and this one had pushed it over the 400-line
// guardrail.
import { css, html, type TemplateResult } from "https://kit.thatsit.app/lit.js";
import type { Step } from "../model/types.ts";

export const historyStyles = css`
	.steps {
		display: flex;
		gap: 6px;
		list-style: none;
		margin: 0;
		padding: 0;
		overflow: hidden;
	}
	.chip {
		white-space: nowrap;
		font-size: 13px;
		padding: 2px 8px;
		border: 1px solid currentColor;
		border-radius: 999px;
	}
`;

/** The history, in order. `data-sketch-points` is what Task 9's e2e reads to prove a six-point stroke became a
 *  four-corner ring: the number is the corner count the document stored, not the sample count. */
export function stepChips(steps: Step[]): TemplateResult {
	return html`${steps.map((step, i) => html`<li class="chip" data-sketch-points=${corners(step)}>${step.kind === "extrude" ? step.name : step.type} ${i + 1}</li>`)}`;
}

/** A row of the history strip: the step's own name, numbered by its place, and how many corners its sketch
 *  has. A circle is one corner: it has no vertices to count, and "1" reads truer than "0". */
function corners(step: Step): number {
	if (step.kind !== "extrude") return 0;
	return step.sketch.entities.reduce((n, e) => {
		if (e.kind === "circle") return n + 1;
		const closed = e.points.length > 1 && samePoint(e.points[0], e.points[e.points.length - 1]);
		return n + e.points.length - (closed ? 1 : 0);
	}, 0);
}

const samePoint = (a: [number, number] | undefined, b: [number, number] | undefined): boolean => !!a && !!b && a[0] === b[0] && a[1] === b[1];
