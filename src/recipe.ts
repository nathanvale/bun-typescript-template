export type Profile = "scratch" | "durable";
export type Starter = "simple" | "complex";
export type Layout = "single-package" | "monorepo";

export type Request =
  | {
      readonly profile: "scratch";
      readonly layout: "single-package";
      readonly starter?: undefined;
    }
  | {
      readonly profile: "durable";
      readonly layout: Layout;
      readonly starter?: undefined;
    }
  | {
      readonly profile: "durable";
      readonly layout: "single-package";
      readonly starter: Starter;
    };

export interface Copy {
  readonly from: string;
  readonly into: "." | "src" | "tests" | "tests/support" | "config";
  readonly only?: readonly string[];
}

export interface ProjectRecipe {
  readonly request: Request;
  readonly copies: readonly [Copy, ...Copy[]];
  readonly cli: Starter | "kernel";
  readonly checkCommand: string;
}

export const UNCOPIED_NAMES: readonly string[] = [
  "TEMPLATE-SOURCE.md",
  "composition-tests",
];

export const LINT_RULE_FILES: readonly string[] = [
  "anti-slop-bindings.mjs",
  "anti-slop-rules.mjs",
  "anti-slop-type-rules.mjs",
  "payload-rules.mjs",
  "platform-rules.mjs",
  "template-rules.mjs",
];

const LINT_RULES: Copy = {
  from: "config",
  into: "config",
  only: LINT_RULE_FILES,
};

const TEST_FOLDER: Copy = {
  from: "tests/support",
  into: "tests/support",
  only: ["test-folder.ts"],
};

const SIMPLE_CLI: readonly Copy[] = [
  { from: "starters/shared/src", into: "src" },
  { from: "starters/simple/src", into: "src" },
  { from: "starters/simple/tests", into: "tests" },
  TEST_FOLDER,
];

function starterRow(starter: Starter): ProjectRecipe {
  return {
    request: { profile: "durable", layout: "single-package", starter },
    copies: [
      { from: `profiles/static-admission/${starter}`, into: "." },
      { from: `starters/${starter}`, into: "." },
      { from: "starters/shared/src", into: "src" },
      TEST_FOLDER,
      LINT_RULES,
    ],
    cli: starter,
    checkCommand: "bun run check",
  };
}

export const RECIPES: readonly ProjectRecipe[] = [
  {
    request: { profile: "scratch", layout: "single-package" },
    copies: [{ from: "profiles/scratch", into: "." }, ...SIMPLE_CLI],
    cli: "simple",
    checkCommand: "bun run typecheck && bun run test",
  },
  {
    request: { profile: "durable", layout: "single-package" },
    copies: [
      { from: "profiles/durable", into: "." },
      ...SIMPLE_CLI,
      LINT_RULES,
    ],
    cli: "simple",
    checkCommand: "bun run check",
  },
  {
    request: { profile: "durable", layout: "monorepo" },
    copies: [
      { from: "examples/monorepo", into: "." },
      ...SIMPLE_CLI,
      LINT_RULES,
    ],
    cli: "simple",
    checkCommand: "bun run check",
  },
  starterRow("simple"),
  starterRow("complex"),
];

// Interface: the kernel row. It copies the template's own files for a
// generated repository, which names the kernel by its Pin, one dependency
// line in package.json. It is not in RECIPES, so no command-line selection
// reaches it.
export const KERNEL_RECIPE: ProjectRecipe = {
  request: { profile: "durable", layout: "single-package" },
  copies: [
    { from: "generated-repository/settings", into: "." },
    { from: "generated-repository/application", into: "." },
    TEST_FOLDER,
    LINT_RULES,
  ],
  cli: "kernel",
  checkCommand: "bun run check",
};

// Interface: the kernel lockfile, which Bootstrap gives a repository the
// kernel row makes when asked for it. Only the pin move writes it.
export const KERNEL_LOCKFILE = "generated-repository/bun.lock";

export function lintsCode(recipe: ProjectRecipe): boolean {
  return recipe.copies.includes(LINT_RULES);
}

function distinct<T>(values: readonly (T | undefined)[]): T[] {
  return [
    ...new Set(values.filter((value): value is T => value !== undefined)),
  ];
}

export const PROFILES: readonly Profile[] = distinct(
  RECIPES.map((recipe) => recipe.request.profile),
);

export const STARTERS: readonly Starter[] = distinct(
  RECIPES.map((recipe) => recipe.request.starter),
);

export interface Selection {
  readonly profile: Profile;
  readonly monorepo: boolean;
  readonly starter?: Starter | undefined;
}

export type RecipeChoice =
  | { readonly status: "selected"; readonly recipe: ProjectRecipe }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly repair: string;
    };

function refusal(selection: Selection): RecipeChoice {
  if (selection.monorepo && selection.profile !== "durable") {
    return {
      status: "refused",
      message: "--monorepo is available only with --profile durable",
      repair: "remove --monorepo or choose --profile durable",
    };
  }
  if (selection.starter !== undefined && selection.profile !== "durable") {
    return {
      status: "refused",
      message: "--starter is available only with --profile durable",
      repair: "remove --starter or choose --profile durable",
    };
  }
  if (selection.starter !== undefined && selection.monorepo) {
    return {
      status: "refused",
      message: "--starter and --monorepo cannot be combined",
      repair: "choose one CLI starter or the explicit monorepo example",
    };
  }
  throw new Error(
    `No recipe and no refusal matches profile ${selection.profile}, monorepo ${String(selection.monorepo)}, starter ${selection.starter ?? "none"}. Repair: add a recipe to RECIPES or a case to refusal().`,
  );
}

export function selectRecipe(
  selection: Selection,
  recipes: readonly ProjectRecipe[] = RECIPES,
): RecipeChoice {
  const layout: Layout = selection.monorepo ? "monorepo" : "single-package";
  const recipe = recipes.find(
    ({ request }) =>
      request.profile === selection.profile &&
      request.layout === layout &&
      request.starter === selection.starter,
  );
  return recipe === undefined
    ? refusal(selection)
    : { status: "selected", recipe };
}
