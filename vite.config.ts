import { defineConfig } from "vite";
import { thatsitApp } from "./vite/app-plugin.ts";

// The kit and Lit are absolute https:// imports, which Vite leaves alone.
// spike/stage0 is a second input so `vite preview` serves it over HTTP: Stage 0's numbers have to come from the
// same build the app ships, on a device (the iPad) that cannot run a dev server. Nothing links to it.
export default defineConfig({
	plugins: [thatsitApp()],
	build: { rollupOptions: { input: ["index.html", "spike/stage0/index.html"] } },
});
