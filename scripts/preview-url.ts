import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wrangler's output is the only source of truth: branch aliases are slugified, never rebuild them.
const ANSI = /\x1b\[[0-9;]*m/g;
const find = (text: string, label: RegExp) => text.match(new RegExp(`${label.source}\\s*(https://\\S+)`))?.[1] ?? null;

export function previewUrl(output: string): string | null {
	const text = output.replace(ANSI, "");
	return find(text, /Deployment alias URL:/) ?? find(text, /Take a peek over at/);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const url = previewUrl(readFileSync(0, "utf8"));
	if (!url) {
		console.error("No deployment URL found in wrangler output");
		process.exit(1);
	}
	console.log(url);
}
