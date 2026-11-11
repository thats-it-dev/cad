// Task 10's keyboard rules, in Node, with no DOM. The two rules this file exists to hold still are the ones a
// browser test can only catch by accident: which keystrokes belong to the app, and which belong to a box the
// user is typing in.
import { describe, expect, it } from "vitest";
import { isTyping, shortcutFor, type KeyLike } from "../src/app/shortcuts.ts";

/** A keydown, as far as this module cares. `path` stands in for composedPath's first entry. */
const key = (k: string, opts: { meta?: boolean; ctrl?: boolean; alt?: boolean; path?: unknown[] } = {}): KeyLike => ({
	key: k,
	metaKey: !!opts.meta,
	ctrlKey: !!opts.ctrl,
	altKey: !!opts.alt,
	composedPath: () => opts.path ?? [{}],
});

/** Something that behaves like an `<input>`: duck-typed, because `instanceof HTMLInputElement` is a global this
 *  runtime does not have — which is exactly why shortcuts.ts does not use it. */
const input = (value = "", disabled = false): unknown => ({ tagName: "INPUT", value, disabled });

describe("what the keys mean", () => {
	it("maps the spec's row: N and S start, E dimensions, Escape abandons", () => {
		expect(shortcutFor(key("n"))).toBe("new");
		expect(shortcutFor(key("s"))).toBe("new");
		expect(shortcutFor(key("e"))).toBe("depth");
		expect(shortcutFor(key("Escape"))).toBe("cancel");
	});

	it("is case-blind, because the shift key is not a different command", () => {
		expect(shortcutFor(key("E")), "the letter arrives capitalised with Shift held").toBe("depth");
		expect(shortcutFor(key("S"))).toBe("new");
	});

	it("leaves the browser's chords alone", () => {
		// Cmd-S would otherwise be the user losing their work in another app to "start a new sketch", and the
		// one keystroke a tablet user's keyboard shortcut layer cannot survive is the reload.
		expect(shortcutFor(key("s", { meta: true }))).toBeNull();
		expect(shortcutFor(key("n", { ctrl: true }))).toBeNull();
		expect(shortcutFor(key("e", { alt: true }))).toBeNull();
	});

	it("does not claim keys it has no use for", () => {
		expect(shortcutFor(key("x"))).toBeNull();
		expect(shortcutFor(key("ArrowLeft"))).toBeNull();
		// A bare Shift or Option must not read as a command through the lower-casing of a non-character key.
		expect(shortcutFor(key("Shift"))).toBeNull();
	});
});

describe("who a keystroke belongs to", () => {
	it("is not typing when the window has focus", () => {
		expect(isTyping(key("e")), "the body is the target, and it holds no text").toBe(false);
	});

	it("is typing when an editable box is the real target", () => {
		expect(isTyping(key("e", { path: [input("25")] }))).toBe(true);
		expect(isTyping(key("e", { path: [input("")] })), "an empty box still owns the next character").toBe(true);
	});

	it("looks at the composed path, not the target", () => {
		// This is the bug the e2e cannot point at: retargeting hands the window <cad-tools>, and a guard written
		// against `event.target` reads as "nobody is typing" for every box inside every shadow root.
		const host = { tagName: "CAD-TOOLS" };
		expect(isTyping(key("e", { path: [input("25"), host] })), "the first entry is the input").toBe(true);
		expect(isTyping(key("e", { path: [host] })), "the host alone is not an editor").toBe(false);
	});

	it("a disabled box owns nothing", () => {
		// A greyed depth box during a build must not swallow E; the shortcut is the only way left to it.
		expect(isTyping(key("e", { path: [input("25", true)] }))).toBe(false);
	});

	it("counts a contenteditable as typing", () => {
		expect(isTyping(key("e", { path: [{ isContentEditable: true }] }))).toBe(true);
	});

	it("survives an event with no path", () => {
		// A synthetic KeyboardEvent constructed outside a document answers composedPath() with [].
		expect(isTyping(key("e", { path: [] }))).toBe(false);
	});
});
