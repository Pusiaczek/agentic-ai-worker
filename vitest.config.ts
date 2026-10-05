import { defineConfig } from "vitest/config";

// Only the CLI's own tests: fixtures/ holds sample projects with their own test suites.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
