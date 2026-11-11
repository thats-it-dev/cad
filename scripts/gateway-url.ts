import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "https://spark-713a.tail9274fa.ts.net";
const LINE = /^Gateway: thats-it-dev\/spark-gateway#(\d+)[ \t]*$/im;

// A PR body line `Gateway: thats-it-dev/spark-gateway#N` selects the gateway preview on port 9500+N.
export function gatewayUrlFor(prBody: string): string | undefined {
	const n = Number(prBody.replaceAll("\r", "").match(LINE)?.[1]);
	return n >= 1 && n <= 499 ? `${BASE}:${9500 + n}` : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const url = gatewayUrlFor(readFileSync(0, "utf8"));
	if (url) console.log(url);
}
