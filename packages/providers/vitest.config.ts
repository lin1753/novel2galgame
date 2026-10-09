import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // S10a tests sleep real Retry-After delays (~2s each)
    testTimeout: 30_000,
  },
});
