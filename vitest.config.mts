import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": src } },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: ".local/evidence/current/coverage",
      thresholds: { statements: 80, branches: 70 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/db/**", "tests/perf/**"],
        },
      },
      {
        extends: true,
        test: { name: "db", environment: "node", include: ["tests/db/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "perf",
          environment: "node",
          include: ["tests/perf/**/*.test.ts"],
          globalSetup: ["tests/perf/global-setup.ts"],
          testTimeout: 120000,
        },
      },
    ],
  },
});
