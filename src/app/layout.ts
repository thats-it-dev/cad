import { css } from "https://kit.thatsit.app/lit.js";

/**
 * The shell's own geometry: a rail on the thumb edge, a bar across the top, and a stage that takes the rest.
 *
 * It lives here, beside history-strip.ts's `historyStyles`, for the reason that file exists: app-main.ts was at
 * 405 lines against this repo's 400-line guardrail, and CSS is the part of it with no logic to keep nearby. The
 * comments stay with the rules they explain, because every number in here was found the hard way.
 */
export const layoutStyles = css`
	:host {
		display: flex;
		flex-direction: row;
		position: fixed;
		inset: 0;
	}
	/* The panel is a rail, not a nav drawer: on an iPad in the hands the thumb owns the left edge, and the
	   pen owns the middle of the window (spec anti-goal: nothing floating over the canvas). TkShell's nav
	   slot slides over the content it is next to, which is the one thing this layout may not do.
	   The width is fixed and narrow on purpose: an unconstrained rail measured 221 px on a 390 px phone,
	   which left the canvas 169 px wide, and e2e/viewer.spec.ts found it. */
	.rail {
		flex: none;
		width: 64px;
		border-right: 1px solid var(--line);
		overflow-y: auto;
	}
	.column {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
		padding: 4px 8px;
	}
	.status {
		margin: 0 0 0 auto;
		font-size: 13px;
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	cad-viewer {
		display: block;
		width: 100%;
		height: 100%;
	}
`;
