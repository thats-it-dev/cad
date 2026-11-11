import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://kit.thatsit.app";

// Follow relative re-exports/imports; "./x.js" and "./x.ts" both mean x.d.ts.
// Bare specifiers (lit) come from the lit devDependency, not the kit.
export async function collectTypes(
	fetchText: (path: string) => Promise<string>,
	entry = "kit.d.ts",
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const queue = [entry];
	while (queue.length) {
		const path = queue.shift() as string;
		if (out.has(path)) continue;
		const text = await fetchText(path);
		out.set(path, text);
		for (const m of text.matchAll(/(?:from|import)\s*["'](\.[^"']*)["']/g)) {
			const target = posix.join(posix.dirname(path), m[1]).replace(/\.(?:js|ts)$/, "") + ".d.ts";
			if (!out.has(target)) queue.push(target);
		}
	}
	return out;
}

async function main(): Promise<void> {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const final = join(root, ".kit");
	const tmp = join(root, ".kit.tmp");
	try {
		const get = async (p: string): Promise<string> => {
			const res = await fetch(`${ORIGIN}/${p}`);
			if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
			return res.text();
		};
		// lit.d.ts isn't reachable from kit.d.ts (the kit exports no Lit), so it is a second entry.
		const files = await collectTypes(get);
		for (const [p, text] of await collectTypes(get, "types/lit.d.ts")) files.set(p, text);
		rmSync(tmp, { recursive: true, force: true });
		for (const [p, text] of files) {
			mkdirSync(dirname(join(tmp, p)), { recursive: true });
			writeFileSync(join(tmp, p), text);
		}
		// Rename last so a failed fetch never leaves a half-written .kit.
		rmSync(final, { recursive: true, force: true });
		renameSync(tmp, final);
		console.log(`kit types: ${files.size} files in .kit/`);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		if (existsSync(join(final, "kit.d.ts"))) {
			console.warn(`kit types: ${(err as Error).message}; using cached kit types`);
			return;
		}
		console.error(`kit types: ${(err as Error).message}; no cache`);
		process.exit(1);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
