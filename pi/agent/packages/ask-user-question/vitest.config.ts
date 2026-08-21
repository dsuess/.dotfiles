import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@juicesharp/rpiv-test-utils": fileURLToPath(new URL("./test/test-utils/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: ["node_modules/**"],
    setupFiles: ["./test/setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    unstubGlobals: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
