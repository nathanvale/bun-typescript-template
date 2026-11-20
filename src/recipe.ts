export const SKILL_FOLDER = ".agents/skills";

export interface Copy {
  readonly from: string;
  readonly into:
    | "."
    | "src"
    | "tests"
    | "tests/support"
    | "config"
    | typeof SKILL_FOLDER;
  readonly only?: readonly string[];
}

export const PIN_SETTINGS = {
  from: "generated-repository/settings",
  into: ".",
} as const satisfies Copy;

export interface Recipe {
  readonly pin: typeof PIN_SETTINGS;
  readonly copies: readonly Copy[];
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

export function copiesOf(recipe: Recipe): readonly Copy[] {
  return [recipe.pin, ...recipe.copies];
}
