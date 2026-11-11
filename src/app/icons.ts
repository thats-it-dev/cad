import { svg } from "https://kit.thatsit.app/lit.js";

// Icons, inlined rather than depended on: the app's CSP keeps the bundle self-contained, and svg markup
// inside a shadow root must be built with lit's `svg` tag — `html` puts the nodes in the HTML namespace and
// they paint nothing. e2e/tools.spec.ts measures each one's box for exactly that reason: a panel of invisible
// buttons looks like a panel of buttons to a test that only counts them.
//
// The geometry is Lucide's (ISC, https://lucide.dev) where a Lucide path is 24×24 and obvious, and hand-squared
// where it is not, so that every glyph here can be checked by reading the numbers.
const frame = (paths: ReturnType<typeof svg>) => svg`
	<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
		stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
		aria-hidden="true" style="display:block">${paths}`;

/** The pencil: a shaft on the diagonal with its tip at the bottom left, where the ink lands. */
export const iconPencil = frame(svg`
	<path d="M4 20l4-1 11-11-3-3L5 16z" />
	<path d="M15 5l3 3" />
`);

/** Select: an arrow, tip at the top left. */
export const iconPointer = frame(svg`
	<path d="M5 3l14 8-6.5 1.5L9 19z" />
`);

/** Extrude: a solid, drawn as the box the kernel makes from a face. */
export const iconBox = frame(svg`
	<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
	<path d="m3.3 7 8.7 5 8.7-5" />
	<path d="M12 22V12" />
`);

/** Cut: material taken away, drawn as the box with the hole's line through it. */
export const iconCut = frame(svg`
	<path d="M4 8h16" />
	<path d="M6 8v8h12V8" />
	<path d="M4 12h16" />
`);

export const iconTrash = frame(svg`
	<path d="M10 11v6" />
	<path d="M14 11v6" />
	<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
	<path d="M3 6h18" />
	<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
`);

/** The four camera faces. Each is the unit cube seen from that direction, so the difference between them is
 *  readable at 18 px, which a labelled list would be safer about but a tool panel has no room for. */
export const iconFront = frame(svg`
	<path d="M4 6h16v12H4z" />
	<path d="M12 9v6" />
	<path d="M9 12h6" />
`);

export const iconTop = frame(svg`
	<path d="M4 10h16v10H4z" />
	<path d="M12 3v5" />
	<path d="m9 6 3-3 3 3" />
`);

export const iconRight = frame(svg`
	<path d="M10 6h10v12h-10z" />
	<path d="M3 12h5" />
	<path d="m6 9 3 3-3 3" />
`);

export const iconIso = frame(svg`
	<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
	<path d="M12 12l8-4.5" />
	<path d="M12 12v9" />
	<path d="M12 12L4 7.5" />
`);

/** Fit to part: the four corners the framing pulls in to. */
export const iconFit = frame(svg`
	<path d="M8 3H5a2 2 0 0 0-2 2v3" />
	<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
	<path d="M3 16v3a2 2 0 0 0 2 2h3" />
	<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
`);
