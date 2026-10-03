import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Stage-1 tests intentionally avoid network: fake providers + fake timers
    testTimeout: 15_000,
  },
});
