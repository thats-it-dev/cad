import { defineConfig } from "vitest/config";

// Only unit tests; e2e/ belongs to Playwright.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
