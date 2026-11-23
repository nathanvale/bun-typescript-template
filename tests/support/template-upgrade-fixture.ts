import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { RECORDED_HITS_FILES } from "../../src/recipe.ts";
import { main } from "../../src/template-upgrade.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git, gitEnv, gitOutput, initRepository } from "./git-fixture.ts";
import { kernelCheckout, siblingKernel } from "./kernel-sibling.ts";
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

function gitNulPaths(root: string, ...args: string[]): string[] {
  const output = gitOutput(root, ...args);
  return output === ""
    ? []
    : output.split("\0").filter((entry) => entry !== "");
}

function statEntry(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function applyWorkingTreeOverlay(
  templateRoot: string,
  templateClone: string,
): void {
  const trackedChanges = gitNulPaths(
    templateRoot,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD",
    "--",
    ...OVERLAY_PATHS,
  );
  const untrackedFiles = gitNulPaths(
    templateRoot,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...OVERLAY_PATHS,
  );
  const changed = [...new Set([...trackedChanges, ...untrackedFiles])];
  if (changed.length === 0) {
    return;
  }
  const present: { readonly path: string; readonly entry: Stats }[] = [];
  const removed: string[] = [];
  for (const relativePath of changed) {
    const entry = statEntry(join(templateRoot, relativePath));
    if (entry === undefined) {
      removed.push(relativePath);
    } else {
      present.push({ path: relativePath, entry });
    }
  }
  for (const relativePath of removed) {
    rmSync(join(templateClone, relativePath), { force: true, recursive: true });
  }
  if (removed.length > 0) {
    git(templateClone, "rm", "--quiet", "--ignore-unmatch", "--", ...removed);
  }
  for (const { path: relativePath, entry } of present) {
    const sourcePath = join(templateRoot, relativePath);
    const targetPath = join(templateClone, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { force: true, recursive: true });
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    } else {
      throw new Error(
        `Unsupported working tree overlay entry at ${relativePath}.`,
      );
    }
  }
  if (present.length > 0) {
    git(templateClone, "add", "--", ...present.map((item) => item.path));
  }
  git(templateClone, "commit", "--quiet", "-m", "apply working tree overlay");
}

export function cloneTemplateAtHead(
  folder: (prefix: string) => string,
  templateRoot = ROOT,
): {
  readonly templateClone: string;
  readonly baseCommit: string;
} {
  const scratch = folder("e2e-template-");
  const templateClone = join(scratch, "template");
  git(scratch, "clone", "--quiet", "--shared", templateRoot, templateClone);
  applyWorkingTreeOverlay(templateRoot, templateClone);
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
  const files = gitNulPaths(
    destination,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  );
  git(destination, "add", "--", ...files);
  git(destination, "commit", "--quiet", "-m", "initial bootstrap");
  return destination;
}

export function writeScriptedBun(
  folder: (prefix: string) => string,
  prefix: string,
  script: string,
) {
  const binFolder = folder(prefix);
  const ledger = join(binFolder, "calls.log");
  const bunPath = join(binFolder, "bun");
  writeFileSync(bunPath, script.replace("__LEDGER__", JSON.stringify(ledger)));
  chmodSync(bunPath, 0o755);
  return {
    binFolder,
    ledger,
    env: {
      ...process.env,
      ...gitEnv,
      KERNEL_REPOSITORY: siblingKernel(),
      PATH: `${binFolder}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

export function linkTemplateNodeModules(destination: string): void {
  const modules = join(destination, "node_modules");
  rmSync(modules, { force: true, recursive: true });
  mkdirSync(modules, { recursive: true });
  for (const name of readdirSync(join(ROOT, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules", name), join(modules, name));
  }
  const kernelPackage = readKernelPin(ROOT).repository;
  rmSync(join(modules, kernelPackage), { force: true, recursive: true });
  kernelCheckout(join(modules, kernelPackage));
}

const TEMPLATE_UPGRADE_CALLS = new Set([
  "install",
  "run quality:fallow:record-hits",
  "run check",
]);

export function templateUpgradeCalls(ledger: string): string[] {
  return readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .filter((line) => TEMPLATE_UPGRADE_CALLS.has(line));
}

export function prepareFastInstallBun(
  folder: (prefix: string) => string,
  prefix: string,
) {
  const kernelDir = join(folder(`${prefix}kernel-`), "agent-cli-kernel");
  kernelCheckout(kernelDir);
  const templateModules = join(ROOT, "node_modules");
  const kernelPackage = readKernelPin(ROOT).repository;
  return writeScriptedBun(
    folder,
    prefix,
    `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  rm -rf node_modules
  mkdir -p node_modules
  for entry in ${JSON.stringify(templateModules)}/* ${JSON.stringify(templateModules)}/.bin; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    ln -s "$entry" "node_modules/$name"
  done
  rm -rf "node_modules/${kernelPackage}"
  cp -R ${JSON.stringify(kernelDir)} "node_modules/${kernelPackage}"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
}

export function commitTemplateLintChange(templateClone: string): string {
  const eslintPath = join(
    templateClone,
    "generated-repository/settings/eslint.config.mjs",
  );
  writeFileSync(eslintPath, `${readFileSync(eslintPath, "utf8")}\n`);
  const templateRulesPath = join(templateClone, "config/template-rules.mjs");
  writeFileSync(
    templateRulesPath,
    `${readFileSync(templateRulesPath, "utf8")}\n`,
  );
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/eslint.config.mjs",
    "config/template-rules.mjs",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "template change without package.json change",
  );
  return git(templateClone, "rev-parse", "HEAD");
}

export function createRecordedHitsUpgradeFixture(
  folder: (prefix: string) => string,
  options?: {
    readonly omitRecordScriptInTarget?: boolean;
  },
) {
  const { templateClone } = cloneTemplateAtHead(folder);
  const savedFiles = RECORDED_HITS_FILES.map((file) => {
    const path = join(templateClone, "generated-repository/settings", file);
    return { file, path, content: readFileSync(path, "utf8") };
  });
  const settingsPackagePath = join(
    templateClone,
    "generated-repository/settings/package.json",
  );
  const targetPackageText = readFileSync(settingsPackagePath, "utf8");
  const parsedPackage = JSON.parse(targetPackageText) as {
    scripts: Record<string, string>;
    [key: string]: unknown;
  };
  const withoutRecordScript = `${JSON.stringify(
    {
      ...parsedPackage,
      scripts: Object.fromEntries(
        Object.entries(parsedPackage.scripts).filter(
          ([name]) => name !== "quality:fallow:record-hits",
        ),
      ),
    },
    null,
    2,
  )}\n`;
  writeFileSync(settingsPackagePath, withoutRecordScript);
  git(
    templateClone,
    "rm",
    "--quiet",
    "--",
    ...RECORDED_HITS_FILES.map(
      (file) => `generated-repository/settings/${file}`,
    ),
  );
  git(templateClone, "add", "--", "generated-repository/settings/package.json");
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "template before recorded-hits files",
  );
  const baseCommit = git(templateClone, "rev-parse", "HEAD");

  for (const { path, content } of savedFiles) {
    writeFileSync(path, content);
  }
  writeFileSync(
    settingsPackagePath,
    options?.omitRecordScriptInTarget === true
      ? withoutRecordScript
      : targetPackageText,
  );
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/package.json",
    ...RECORDED_HITS_FILES.map(
      (file) => `generated-repository/settings/${file}`,
    ),
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "template adding recorded-hits files",
  );
  const targetCommit = git(templateClone, "rev-parse", "HEAD");
  return {
    templateClone,
    baseCommit,
    targetCommit,
    branch: `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`,
  };
}
