import { normalize } from "./doc.ts";
import type { CadDocument } from "./types.ts";

/** The stored form. Every field a step carries is written out, including ones this version ignores. */
export function serialize(doc: CadDocument): string {
	return JSON.stringify(doc);
}

/** Reads stored text back. Throws on text that is not JSON, so a corrupt project cannot read as empty. */
export function deserialize(text: string): CadDocument {
	return normalize(JSON.parse(text) as unknown).doc;
}
