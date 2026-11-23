import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import js from "@eslint/js";
import { kernelLint } from "agent-cli-kernel/lint";
import kernelRules from "agent-cli-kernel/lint-rules";
import tseslint from "typescript-eslint";
import antiSlop, { chainedTypeAssertions } from "./config/anti-slop-rules.mjs";
import payloadRules from "./config/payload-rules.mjs";
import platformRules from "./config/platform-rules.mjs";
import templateRules from "./config/template-rules.mjs";

const entrySourceFiles = new Set(["cli.ts", "commands.ts"]);

const noLooseSourceWithSubjects = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      looseSource:
        "Source file {{name}} sits loose in src/ alongside subject folders. Repair: move it into a subject folder (src/<subject>/) or src/shared/; only src/cli.ts and src/commands.ts stay at src/ root once subject folders exist.",
    },
  },
  create(context) {
    const file = context.filename;
    if (file === "<input>" || file === "<text>") return {};
    const folder = dirname(file);
    if (resolve(folder) !== resolve(import.meta.dirname, "src")) return {};
    const name = basename(file);
    if (entrySourceFiles.has(name)) return {};
    const hasSubjectFolder = readdirSync(folder, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
    if (!hasSubjectFolder) return {};
    return {
      Program(node) {
        context.report({
          node,
          messageId: "looseSource",
          data: { name },
        });
      },
    };
  },
};

const repository = {
  rules: {
    ...templateRules.rules,
    ...platformRules.rules,
    ...payloadRules.rules,
    ...kernelRules.rules,
    "no-loose-source-with-subjects": noLooseSourceWithSubjects,
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
  ...kernelLint({
    rootDir: import.meta.dirname,
    srcDir: "src",
    testDirs: [],
    addons: [],
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
    plugins: { repository },
    rules: {
      "repository/no-comments": "error",
      "repository/no-host-path-literal": "error",
    },
  },
  {
    files: ["**/*.ts.txt"],
    languageOptions: { parser: tseslint.parser },
    plugins: { repository: repository },
    rules: { "repository/no-comments": "error" },
  },
  {
    files: ["src/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"],
    plugins: { repository },
    rules: {
      "repository/no-loose-source-with-subjects": "error",
    },
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
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
  {
    files: ["**/*.{ts,mts,cts}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", argsIgnorePattern: "^_" },
      ],
    },
  },
);
