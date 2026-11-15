import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import noSupabaseInTests from "./eslint-rules/no-supabase-in-tests.mjs";

export default tseslint.config(
  {
    ignores: [
      ".next/**", "node_modules/**", ".local/**", "coverage/**", "next-env.d.ts",
      // Vendored, unchanged third-party files (checked by vendor:verify instead).
      "public/runtime/**", "public/preview-assets/**", "tools/agentic-web/**",
      "spikes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks, retrofit: { rules: { "no-supabase-in-tests": noSupabaseInTests } } },
    settings: { react: { version: "19" } },
    rules: {
      "react/no-danger": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "retrofit/no-supabase-in-tests": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Every browser spec must use the CSP fixture.
    files: ["e2e/**/*.spec.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [{ name: "@playwright/test", message: "Import test and expect from ./fixtures/csp so the CSP checks run." }] }] },
  },
  {
    files: ["**/*.{mjs,js}"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly", fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly", window: "readonly", document: "readonly", location: "readonly" } },
  },
);
