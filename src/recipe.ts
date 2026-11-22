export const SKILL_FOLDER = ".agents/skills";
export const HOSTED_CHECK_FOLDER = ".github/workflows";
export const CHANGE_NOTES_FOLDER = "change-notes";

export interface RecipeCopy {
  readonly from: string;
  readonly into:
    | "."
    | "src"
    | "tests"
    | "tests/support"
    | "config"
    | typeof SKILL_FOLDER
    | typeof HOSTED_CHECK_FOLDER
    | typeof CHANGE_NOTES_FOLDER;
  readonly only?: readonly string[];
}

export const PIN_SETTINGS = {
  from: "generated-repository/settings",
  into: ".",
} as const satisfies RecipeCopy;

export interface Recipe {
  readonly pin: typeof PIN_SETTINGS;
  readonly copies: readonly RecipeCopy[];
  readonly checkCommand: string;
}

export const LINT_RULE_FILES: readonly string[] = [
  "anti-slop-bindings.mjs",
  "anti-slop-rules.mjs",
  "anti-slop-type-rules.mjs",
  "payload-rules.mjs",
  "platform-rules.mjs",
  "template-rules.mjs",
];

export const KERNEL_RECIPE: Recipe = {
  pin: PIN_SETTINGS,
  copies: [
    { from: "generated-repository/application", into: "." },
    { from: "generated-repository/change-notes", into: CHANGE_NOTES_FOLDER },
    { from: "generated-repository/hosted-check", into: HOSTED_CHECK_FOLDER },
    { from: "generated-repository/skills", into: SKILL_FOLDER },
    {
      from: "tests/support",
      into: "tests/support",
      only: ["test-folder.ts"],
    },
    { from: "config", into: "config", only: LINT_RULE_FILES },
  ],
  checkCommand: "bun run check",
};

export const KERNEL_LOCKFILE = "generated-repository/bun.lock";
export const TEMPLATE_JSON_FILE = ".template.json";
export const RECORDED_HITS_FILES: readonly string[] = [
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
];
export const RECORDED_HITS_SCRIPT = "quality:fallow:record-hits";

export const REPOSITORY_RECIPE_COPIES: readonly string[] = [
  "README.md",
  "src/cli.ts",
  "src/commands.ts",
  "tests/cli.test.ts",
];

export function copiesOf(recipe: Recipe): readonly RecipeCopy[] {
  return [recipe.pin, ...recipe.copies];
}
