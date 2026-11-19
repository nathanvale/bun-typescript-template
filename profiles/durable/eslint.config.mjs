import js from "@eslint/js";
import antiSlop, { chainedTypeAssertions } from "./config/anti-slop-rules.mjs";
import payloadRules from "./config/payload-rules.mjs";
import platformRules from "./config/platform-rules.mjs";
import templateRules from "./config/template-rules.mjs";
import localRules from "./eslint-rules.mjs";
import tseslint from "typescript-eslint";

const repository = {
  rules: {
    ...localRules.rules,
    ...templateRules.rules,
    ...platformRules.rules,
    ...payloadRules.rules,
  },
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".fallow/**",
      ".worktrees/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": "error",
    },
  },
  {
    files: ["src/cli.ts"],
    rules: { "no-console": ["error", { allow: ["log"] }] },
  },

  {
    files: ["src/domains/**/*.ts"],
    plugins: { repository },
    rules: { "repository/no-domain-output": "error" },
  },
  {
    files: ["**/*.{ts,mts,cts,mjs}"],
    plugins: { repository },
    rules: {
      "repository/no-comments": "error",
      "repository/no-host-path-literal": "error",
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { repository },
    rules: {
      "repository/no-locale-compare": "error",
      "repository/no-in-operator": "error",
    },
  },
  {
    files: ["tests/**/*.{ts,mts,cts}", "**/*.test.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/require-to-throw-message": "error",
      "repository/tests-use-test-folder": "error",
      "repository/tests-no-sleep": "error",
    },
  },
  {
    files: ["**/*.{mts,cts,tsx,jsx}"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    plugins: { "anti-slop": antiSlop },
    rules: {
      "no-restricted-syntax": ["error", ...chainedTypeAssertions],
      "anti-slop/no-accumulating-spread": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
    },
  },
);
