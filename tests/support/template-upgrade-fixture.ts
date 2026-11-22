import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../../src/template-upgrade.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git, gitEnv, initRepository } from "./git-fixture.ts";
import { siblingKernel } from "./kernel-sibling.ts";
import { spawnBounded } from "./process.ts";

export function templateUpgradeEnv() {
  return {
    ...process.env,
    ...gitEnv,
    KERNEL_REPOSITORY: siblingKernel(),
  };
}

export function applyNoCheckJsonArgs(
  repo: string,
  targetCommit: string,
): string[] {
  return [
    "apply",
    "--repository",
    repo,
    "--to",
    targetCommit,
    "--no-check",
    "--json",
  ];
}

export async function invokeTemplateUpgradeMain(
  stdout: () => string,
  stderr: () => string,
  argv: readonly string[],
  runtime: {
    readonly templateRoot: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const outStart = stdout().length;
  const errStart = stderr().length;
  const exitCode = await main(argv, runtime);
  return {
    exitCode,
    stdout: stdout().slice(outStart),
    stderr: stderr().slice(errStart),
  };
}

const OVERLAY_PATHS = [
  "src",
  "generated-repository",
  "config",
  "kernel-pin.json",
] as const;

function applyWorkingTreeOverlay(templateClone: string): void {
  const modified = git(
    ROOT,
    "diff",
    "--name-only",
    "--no-renames",
    "HEAD",
    "--",
    ...OVERLAY_PATHS,
  )
    .split("\n")
    .filter((entry) => entry !== "");
  if (modified.length === 0) {
    return;
  }
  const present: string[] = [];
  const removed: string[] = [];
  for (const relativePath of modified) {
    const sourcePath = join(ROOT, relativePath);
    const targetPath = join(templateClone, relativePath);
    if (existsSync(sourcePath)) {
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
      present.push(relativePath);
    } else {
      rmSync(targetPath, { force: true });
      removed.push(relativePath);
    }
  }
  if (present.length > 0) {
    git(templateClone, "add", "--", ...present);
  }
  if (removed.length > 0) {
    git(templateClone, "rm", "--quiet", "--ignore-unmatch", "--", ...removed);
  }
  git(templateClone, "commit", "--quiet", "-m", "apply working tree overlay");
}

export function cloneTemplateAtHead(folder: (prefix: string) => string): {
  readonly templateClone: string;
  readonly baseCommit: string;
} {
  const scratch = folder("e2e-template-");
  const templateClone = join(scratch, "template");
  git(scratch, "clone", "--quiet", "--shared", ROOT, templateClone);
  applyWorkingTreeOverlay(templateClone);
  const baseCommit = git(templateClone, "rev-parse", "HEAD");
  return { templateClone, baseCommit };
}

function updateFixturePackageJson(templateClone: string): void {
  const settingsPackagePath = join(
    templateClone,
    "generated-repository/settings/package.json",
  );
  const settingsPackage = JSON.parse(
    readFileSync(settingsPackagePath, "utf8"),
  ) as {
    devDependencies: Record<string, string>;
    [key: string]: unknown;
  };
  const updatedPackage: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settingsPackage)) {
    updatedPackage[key] =
      key === "devDependencies"
        ? { ...settingsPackage.devDependencies, "@biomejs/biome": "2.6.8" }
        : value;
    if (key === "private") {
      updatedPackage.engines = { bun: ">=1.4.4" };
    }
  }
  writeFileSync(
    settingsPackagePath,
    `${JSON.stringify(updatedPackage, null, 2)}\n`,
  );
}

function updateFixtureLintAndTestFiles(templateClone: string): void {
  renameSync(
    join(templateClone, "config/platform-rules.mjs"),
    join(templateClone, "config/host-platform-rules.mjs"),
  );
  const recipePath = join(templateClone, "src/recipe.ts");
  writeFileSync(
    recipePath,
    readFileSync(recipePath, "utf8").replace(
      '"platform-rules.mjs"',
      '"host-platform-rules.mjs"',
    ),
  );
  const eslintPath = join(
    templateClone,
    "generated-repository/settings/eslint.config.mjs",
  );
  writeFileSync(
    eslintPath,
    readFileSync(eslintPath, "utf8").replace(
      "./config/platform-rules.mjs",
      "./config/host-platform-rules.mjs",
    ),
  );
  rmSync(
    join(
      templateClone,
      "generated-repository/application/tests/pointer-skills.test.ts",
    ),
  );
  const editedTest = join(
    templateClone,
    "generated-repository/application/tests/add-on-start-up.test.ts",
  );
  const lines = readFileSync(editedTest, "utf8").split("\n");
  const targetIndex = lines.findIndex((line) => line.includes("describe("));
  const lineToEdit = targetIndex >= 0 ? targetIndex : 0;
  lines[lineToEdit] = lines[lineToEdit]
    ? lines[lineToEdit].replace('"', '"template-edited ')
    : "// template";
  writeFileSync(editedTest, lines.join("\n"));
}

export function commitTemplateUpgradeChanges(templateClone: string): string {
  updateFixturePackageJson(templateClone);
  updateFixtureLintAndTestFiles(templateClone);
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/package.json",
    "config/host-platform-rules.mjs",
    "src/recipe.ts",
    "generated-repository/settings/eslint.config.mjs",
    "generated-repository/application/tests/add-on-start-up.test.ts",
  );
  git(
    templateClone,
    "rm",
    "--quiet",
    "--",
    "config/platform-rules.mjs",
    "generated-repository/application/tests/pointer-skills.test.ts",
  );
  git(templateClone, "commit", "--quiet", "-m", "template upgrade fixture");
  return git(templateClone, "rev-parse", "HEAD");
}

export async function bootstrapGeneratedRepository(
  folder: (prefix: string) => string,
  templateClone: string,
  baseCommit: string,
  name: string,
): Promise<string> {
  const baseCheckout = join(folder("e2e-base-"), "template");
  git(
    folder("e2e-clone-cwd-"),
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    templateClone,
    baseCheckout,
  );
  git(baseCheckout, "checkout", "--quiet", "--detach", baseCommit);

  const destination = join(folder("e2e-repo-"), name);
  const result = await spawnBounded(
    [
      process.execPath,
      "run",
      join(baseCheckout, "src/bootstrap.ts"),
      "--destination",
      destination,
      "--source-packet",
      "/abs/packets/e2e-demo",
      "--name",
      name,
      "--json",
    ],
    {
      cwd: baseCheckout,
      env: { ...process.env, ...gitEnv, KERNEL_REPOSITORY: siblingKernel() },
      processGroup: true,
    },
  );
  if (result.exit !== 0) {
    throw new Error(`bootstrap failed: ${result.stderr}\n${result.stdout}`);
  }
  initRepository(destination);
  const files = git(destination, "ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((entry) => entry !== "");
  git(destination, "add", "--", ...files);
  git(destination, "commit", "--quiet", "-m", "initial bootstrap");
  return destination;
}
