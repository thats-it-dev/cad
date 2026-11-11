/**
 * Which keystrokes the app owns, and which belong to something else on the page.
 *
 * Task 9 put the shortcuts in app-main as a chain of `else if`s, and Task 10 put a number box on the same page.
 * The two interact in ways that are invisible from inside the handler, so both rules live here where a test can
 * hold one still:
 *
 * 1. A keystroke typed into an editable box is typing. `event.target` cannot answer that — a keydown from an
 *    input inside a shadow root reaches the window retargeted to the host, so the target is `<cad-tools>`, not
 *    the input. `composedPath()[0]` is the input.
 * 2. Claiming a keystroke means preventing it. Without `preventDefault` the browser finishes the keydown after
 *    the handler returns and inserts the character into whichever input the handler just focused. E used to open
 *    the depth field *and* type "e" into it, and a number box whose raw value is "e" reads back as "", which
 *    came out of the app as "type a depth in millimetres, above zero".
 */
export type Shortcut = "new" | "depth" | "cancel";

/** The shape of the event this module needs, so a Node test can hand it a literal instead of a jsdom. */
export type KeyLike = {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	composedPath(): unknown[];
};

/** The keys, mapped. `isTyping` is checked by the caller, because whether a field is open is app state. */
export function shortcutFor(event: KeyLike): Shortcut | null {
	// A browser or OS chord first: Cmd-S saves the page, Ctrl-N opens a window. Taking those would be rude and
	// would not survive the user's next reload.
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	const key = event.key.toLowerCase();
	// S and N both start a sketch: N for "new", S for "sketch", from the spec's keyboard row.
	if (key === "s" || key === "n") return "new";
	if (key === "e") return "depth";
	if (key === "escape") return "cancel";
	return null;
}

/** True when the keystroke belongs to a text field the user is editing, not to the app. */
export function isTyping(event: KeyLike): boolean {
	const target = event.composedPath()[0] as { tagName?: string; value?: unknown; disabled?: boolean; isContentEditable?: boolean } | undefined;	if (!target || typeof target !== "object") return false;
	// Duck-typed, not `instanceof HTMLInputElement`: this file is imported by a Node test where that global
	// does not exist, and a module that cannot be tested without a browser is a module that does not get tested.
	if (typeof target.value === "string" && !target.disabled) return true;
	return !!target.isContentEditable;
}
