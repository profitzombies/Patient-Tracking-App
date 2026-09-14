import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // These use Node's built-in test runner and are run separately.
      "scripts/usda-source/**/*.test.mjs",
    ],
  },
});