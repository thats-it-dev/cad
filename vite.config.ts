import { defineConfig } from "vite";
import { thatsitApp } from "./vite/app-plugin.ts";

// The kit and Lit are absolute https:// imports, which Vite leaves alone.
export default defineConfig({ plugins: [thatsitApp()] });
