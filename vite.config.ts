import { defineConfig } from "vite";
import { thatsitApp } from "./vite/app-plugin.ts";

// The kit and Lit are absolute https:// imports, which Vite leaves alone.
// spike/stage0 is a second input, and it is opt-in: an unconditional one would ship a permanently reachable
// bench to cad.thatsit.app (stage0.md:4 calls it "a spike, not a ship"). Playwright and the iPad run build with
// CAD_SPIKE=1; a deploy build does not, so dist/ on the production host holds no spike page or chunk.
export default defineConfig({
	plugins: [thatsitApp()],
	build: {
		rollupOptions: {
			input: process.env.CAD_SPIKE ? ["index.html", "spike/stage0/index.html"] : ["index.html"],
		},
	},
});
