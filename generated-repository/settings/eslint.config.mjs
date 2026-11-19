import { readFileSync } from "node:fs";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import antiSlop, { chainedTypeAssertions } from "./config/anti-slop-rules.mjs";
import { kernelLint } from "./config/kernel/eslint.mjs";
import kernelRules from "./config/kernel/eslint-rules.mjs";
import payloadRules from "./config/payload-rules.mjs";
import platformRules from "./config/platform-rules.mjs";
import templateRules from "./config/template-rules.mjs";

const stampRecord = JSON.parse(
  readFileSync(new URL(".kernel-stamp.json", import.meta.url), "utf8"),
);
const stamped = [
  ...stampRecord.roots.map(({ path }) => `${path}/**`),
  stampRecord.stampChecker.path,
];
const repository = {
  rules: {
    ...templateRules.rules,
    ...platformRules.rules,
    ...payloadRules.rules,
    ...kernelRules.rules,
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
      stampRecord.stampChecker.path,
    ],
  },
  ...kernelLint({
    rootDir: import.meta.dirname,
    srcDir: "src",
    testDirs: [],
    addons: stampRecord.addons,
    plugin: repository,
  }),
  {
    files: ["tests/**/*.ts"],
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
    files: ["**/*.{ts,mts,cts,mjs}"],
    ignores: stamped,
    plugins: { repository },
    rules: {
      "repository/no-comments": "error",
      "repository/no-host-path-literal": "error",
    },
  },
  {
    files: ["tests/**/*.{ts,mts,cts}", "**/*.test.{ts,mts,cts}"],
    plugins: { repository },
    rules: {
      "repository/no-locale-compare": "error",
      "repository/no-in-operator": "error",
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
    ignores: stamped,
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
