// Copies the CAD kernel assets from a cascade-core extract into public/kernel/. Run it by hand once per
// kernel upgrade:  npm run get-kernel [path/to/cascade-core/dist]
// cascade-core stays out of package.json on purpose: as a dependency it drags opencascade.js from GitHub
// and its whole build, and we only ever ship the worker, the wasm and the fonts the worker fetches.
// Fonts are an allowlist, not a copy of the directory: the CascadeStudio dist carries Consolas.ttf and
// Papyrus.ttf, which are Microsoft proprietary, and an MIT licence on the package does not relicense a font.
// The worker loads its three fonts asynchronously and only logs a failure, so shipping without them costs
// text rendering (unused in v1.0) and nothing else.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "/tmp/cadcheck/package/dist";
const source = process.argv[2] ?? SOURCE;
const dest = join(import.meta.dirname, "..", "public", "kernel");
const FONTS = ["Roboto.ttf", "Consola.ttf"]; // Apache-2.0 and freeware

if (!existsSync(join(source, "cascadestudio.wasm"))) {
	throw new Error(`No cascade-core dist at ${source}. Pass the directory holding cascadestudio.wasm as the argument. Nothing was copied.`);
}
for (const file of ["cascade-worker.js", "fonts"]) {
	if (!existsSync(join(source, file))) throw new Error(`${source} has no ${file}; the copy would ship a kernel that cannot start.`);
}
for (const font of FONTS) {
	if (!existsSync(join(source, "fonts", font))) throw new Error(`${source}/fonts has no ${font}; the worker fetches it at startup.`);
}
const unexpected = readdirSync(join(source, "fonts")).filter((f) => !FONTS.includes(f) && !["Consolas.ttf", "Papyrus.ttf"].includes(f));
if (unexpected.length) throw new Error(`${source}/fonts holds ${unexpected.join(", ")} — not in the allowlist. Check its licence, then add it to FONTS in this script.`);

mkdirSync(join(dest, "fonts"), { recursive: true });
for (const file of ["cascadestudio.wasm"]) copyFileSync(join(source, file), join(dest, file));
// A 20 MB source map for a file nobody debugs in production, and most of Cloudflare's per-asset cap. The
// worker still points at it, so strip the trailer or devtools fetches a 404 for 20 MB of nothing.
const worker = readFileSync(join(source, "cascade-worker.js"), "utf8")
	.split("\n")
	.filter((line) => !line.startsWith("//# sourceMappingURL="))
	.join("\n");
writeFileSync(join(dest, "cascade-worker.js"), worker);
for (const file of ["cascadestudio.wasm", "cascade-worker.js"]) console.log(`${file}: ${statSync(join(dest, file)).size} bytes`);
for (const font of FONTS) {
	copyFileSync(join(source, "fonts", font), join(dest, "fonts", font));
	console.log(`fonts/${font}: ${statSync(join(dest, "fonts", font)).size} bytes`);
}
for (const stale of readdirSync(join(dest, "fonts")).filter((f) => !FONTS.includes(f))) rmSync(join(dest, "fonts", stale));
rmSync(join(dest, "cascade-worker.js.map"), { force: true });

