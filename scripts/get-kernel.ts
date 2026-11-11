// Copies the CAD kernel assets from a cascade-core extract into public/kernel/. Run it by hand once per
// kernel upgrade:  npm run get-kernel [path/to/cascade-core/dist]
// cascade-core stays out of package.json on purpose: as a dependency it drags opencascade.js from GitHub
// and its whole build, and we only ever ship the worker, the wasm and the fonts the worker fetches.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "/tmp/cadcheck/package/dist";
const source = process.argv[2] ?? SOURCE;
const dest = join(import.meta.dirname, "..", "public", "kernel");

if (!existsSync(join(source, "cascadestudio.wasm"))) {
	throw new Error(`No cascade-core dist at ${source}. Pass the directory holding cascadestudio.wasm as the argument. Nothing was copied.`);
}
for (const file of ["cascade-worker.js", "fonts"]) {
	if (!existsSync(join(source, file))) throw new Error(`${source} has no ${file}; the copy would ship a kernel that cannot start.`);
}

mkdirSync(join(dest, "fonts"), { recursive: true });
for (const file of ["cascadestudio.wasm", "cascade-worker.js"]) {
	copyFileSync(join(source, file), join(dest, file));
	console.log(`${file}: ${statSync(join(dest, file)).size} bytes`);
}
cpSync(join(source, "fonts"), join(dest, "fonts"), { recursive: true });
// A 20 MB source map for a file nobody debugs in production, and most of Cloudflare's per-asset cap.
rmSync(join(dest, "cascade-worker.js.map"), { force: true });

const fonts = join(dest, "fonts");
for (const font of readdirSync(fonts)) console.log(`fonts/${font}: ${statSync(join(fonts, font)).size} bytes`);
