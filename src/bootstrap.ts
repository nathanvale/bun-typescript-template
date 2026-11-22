import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapOptions,
  HELP,
  parseArgs,
  resolveRepositoryName,
  validateSourcePacket,
} from "./bootstrap-arguments.ts";
import { CliError, writeCliError } from "./cli-error.ts";
import {
  clonePin,
  findSiblingKernel,
  generatedPin,
  readKernelPin,
} from "./kernel-pin.ts";
import { type KernelSeam, readKernel } from "./kernel-reader.ts";
import {
  type RecipeCopy,
  copiesOf,
  KERNEL_LOCKFILE,
  KERNEL_RECIPE,
  type Recipe,
  SKILL_FOLDER,
  TEMPLATE_JSON_FILE,
} from "./recipe.ts";
import { substituteTokens } from "./token-substitution.ts";

const SCHEMA_VERSION = 1;
const TEMPLATE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface BootstrapResult {
  destination: string;
  generatedFiles: number;
  runId: string;
  schemaVersion: number;
  sourcePacket: string;
  status: "created";
}

interface Generation extends BootstrapOptions {
  readonly kernelPin: string;
  readonly kernelCommit: string;
  readonly lockfile: Uint8Array | undefined;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.hasOwn(error, "code") &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isInsideTemplate(destination: string): boolean {
  const fromTemplate = relative(TEMPLATE_ROOT, destination);
  return (
    fromTemplate === "" ||
    (!fromTemplate.startsWith("..") && !isAbsolute(fromTemplate))
  );
}

function destinationRefusal(message: string): CliError {
  return new CliError(
    "destination_not_empty",
    message,
    "choose a new or empty directory; existing bytes were preserved",
    3,
    true,
  );
}

function requireOrdinaryDirectory(
  stats: Awaited<ReturnType<typeof lstat>>,
): void {
  if (!stats.isDirectory()) {
    throw destinationRefusal(
      "destination already exists and is not an empty directory",
    );
  }
  if (stats.isSymbolicLink()) {
    throw destinationRefusal(
      "destination already exists and is not an empty directory",
    );
  }
}

async function validateDestination(
  destination: string,
): Promise<"absent" | "empty"> {
  if (isInsideTemplate(destination)) {
    throw new CliError(
      "destination_inside_template",
      "destination must be outside the template repository",
      "choose a fresh destination outside this checkout",
      3,
      true,
    );
  }

  const stats = await lstatIfPresent(destination);
  if (stats === undefined) {
    return "absent";
  }
  requireOrdinaryDirectory(stats);
  if ((await readdir(destination)).length > 0) {
    throw destinationRefusal("destination already contains files");
  }
  return "empty";
}

function isCopied(name: string, only: readonly string[] | undefined): boolean {
  return only === undefined || only.includes(name);
}

async function copyDirectoryContents(
  source: string,
  destination: string,
  only: readonly string[] | undefined,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!isCopied(entry.name, only)) {
      continue;
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      errorOnExist: true,
      force: false,
      recursive: entry.isDirectory(),
    });
  }
}

function sourceRefusal(source: string, code: string, message: string) {
  const path = relative(TEMPLATE_ROOT, source);
  return new CliError(
    code,
    `${message}: ${path}`,
    `run git restore ${path} in the template repository`,
    1,
    false,
  );
}

async function requireSourceFolder(source: string): Promise<void> {
  const stats = await lstatIfPresent(source);
  if (stats === undefined)
    throw sourceRefusal(
      source,
      "recipe_source_missing",
      "recipe folder is missing",
    );
  if (!stats.isDirectory())
    throw sourceRefusal(
      source,
      "recipe_source_wrong_type",
      "recipe folder is not a folder",
    );
}

async function requireSourceFile(source: string): Promise<void> {
  const stats = await lstatIfPresent(source);
  if (stats === undefined)
    throw sourceRefusal(
      source,
      "recipe_source_missing",
      "recipe file is missing",
    );
  if (!stats.isFile())
    throw sourceRefusal(
      source,
      "recipe_source_wrong_type",
      "recipe file is not a regular file",
    );
}

async function requireCopySource(copy: RecipeCopy): Promise<void> {
  const folder = join(TEMPLATE_ROOT, copy.from);
  await requireSourceFolder(folder);
  for (const name of copy.only ?? []) {
    await requireSourceFile(join(folder, name));
  }
}

async function requireRecipeSources(recipe: Recipe): Promise<void> {
  await Promise.all(copiesOf(recipe).map(requireCopySource));
}

async function copyRecipe(recipe: Recipe, staging: string): Promise<void> {
  for (const copy of copiesOf(recipe)) {
    const into = join(staging, copy.into);
    await mkdir(into, { recursive: true });
    await copyDirectoryContents(
      join(TEMPLATE_ROOT, copy.from),
      into,
      copy.only,
    );
  }
}

async function linkSkills(staging: string): Promise<void> {
  const skills = join(staging, SKILL_FOLDER);
  if ((await lstatIfPresent(skills)) === undefined) return;
  const links = join(staging, ".claude", "skills");
  await mkdir(links, { recursive: true });
  for (const name of await readdir(skills))
    await symlink(join("..", "..", SKILL_FOLDER, name), join(links, name));
}

async function installStaging(
  staging: string,
  destination: string,
  destinationState: "absent" | "empty",
): Promise<void> {
  if (destinationState === "empty") {
    await rmdir(destination);
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (destinationState === "empty") {
      await mkdir(destination);
    }
    throw error;
  }
}

const GIT_MILLISECONDS = 4_000;

function templateIdentity(args: string[]) {
  const child = Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_MILLISECONDS,
    killSignal: "SIGKILL",
  });
  if (child.exitedDueToTimeout)
    throw new CliError(
      "template_revision_unavailable",
      `git ${args.join(" ")} did not finish within ${GIT_MILLISECONDS} ms while reading the template's commit`,
      "run that git command by hand in the template to see where it waits, then rerun the same command",
      1,
      false,
    );
  if (child.exitCode !== 0)
    throw new CliError(
      "template_revision_unavailable",
      "cannot read the template's commit with git",
      "rerun from a git clone of the template",
      1,
      false,
    );
  return child.stdout.toString().trim();
}

const COMMENT_GUIDANCE = `## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with \`Platform:\` or \`Interface:\` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in config/ are the template's. Change a lint rule in the template, not here.
`;

function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function skillPurpose(text: string, name: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const raw =
    frontmatter === undefined
      ? undefined
      : /^description:\s*(.+)$/m.exec(frontmatter)?.[1];
  const description = raw === undefined ? "" : unquoteYamlValue(raw);
  if (description === "") return name;
  const period = description.indexOf(". ");
  const sentence = period >= 0 ? description.slice(0, period) : description;
  const cleaned = sentence.replace(/\.$/, "").trim();
  return cleaned === "" ? name : cleaned;
}

async function skillGuidance(staging: string): Promise<string> {
  const skills = join(staging, SKILL_FOLDER);
  if ((await lstatIfPresent(skills)) === undefined) return "";
  const names = (await readdir(skills, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (names.length === 0) return "";
  const lines: string[] = [];
  for (const name of names) {
    const text = await readFile(join(skills, name, "SKILL.md"), "utf8");
    const purpose = skillPurpose(text, name);
    lines.push(`- ${purpose}: read \`${SKILL_FOLDER}/${name}/SKILL.md\`.`);
  }
  return `The kernel's skills are installed under \`${SKILL_FOLDER}/\` (and linked under \`.claude/skills/\`). Read the matching skill before working:\n\n${lines.join("\n")}\n\n`;
}

async function writeRepositoryContext(
  staging: string,
  options: BootstrapOptions,
  recipe: Recipe,
): Promise<void> {
  const revision = templateIdentity(["rev-parse", "HEAD"]);
  const dirty = templateIdentity(["status", "--porcelain"]);
  const metadata = {
    name: options.name,
    templateRevision: revision,
    templateDirty: dirty.length > 0,
    sourcePacket: options.sourcePacket,
  };
  await writeFile(
    join(staging, TEMPLATE_JSON_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  const check = recipe.checkCommand;
  const skills = await skillGuidance(staging);
  await writeFile(
    join(staging, "AGENTS.md"),
    `# Repository commands\n\n${skills}Use the existing repository CLI at src/cli.ts. Add commands through src/commands.ts.\nKeep domain implementation in separate files and preserve one public application CLI.\n\nCheck command: ${check}\nSmoke: bun run start --help\nSource packet: ${options.sourcePacket}\nTemplate source: ${metadata.templateRevision}\n\n${COMMENT_GUIDANCE}`,
  );
}

async function bootstrap(options: Generation): Promise<BootstrapResult> {
  const destinationState = await validateDestination(options.destination);
  const recipe = KERNEL_RECIPE;
  await requireRecipeSources(recipe);

  await mkdir(dirname(options.destination), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(options.destination), ".repo-bootstrap-"),
  );
  try {
    await copyRecipe(recipe, staging);
    await writeRepositoryContext(staging, options, recipe);
    const generatedFiles = await substituteTokens(staging, options);
    await linkSkills(staging);
    if (options.lockfile !== undefined)
      await writeFile(join(staging, "bun.lock"), options.lockfile);
    await installStaging(staging, options.destination, destinationState);
    return {
      destination: options.destination,
      generatedFiles,
      runId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      sourcePacket: options.sourcePacket,
      status: "created",
    };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export type KernelBootstrap = {
  readonly destination: string;
  readonly name?: string;
  readonly sourcePacket: string;
  readonly kernel: KernelSeam;
  readonly declarationPath?: string;
  readonly lockfile: "committed" | "none" | Uint8Array;
  readonly kernelFrom?: "remote" | "clone";
};

async function lockfileFor(lockfile: KernelBootstrap["lockfile"]) {
  if (lockfile !== "committed")
    return lockfile === "none" ? undefined : lockfile.slice();
  const path = join(TEMPLATE_ROOT, KERNEL_LOCKFILE);
  if ((await lstatIfPresent(path))?.isFile() !== true)
    throw new CliError(
      "kernel_lockfile_missing",
      `the template has no kernel lockfile at ${KERNEL_LOCKFILE}`,
      "run bun run pin-move with the pinned commit to write it, then run Bootstrap again",
      1,
      false,
    );
  return new Uint8Array(await readFile(path));
}

export async function bootstrapWithKernel(
  request: KernelBootstrap,
): Promise<BootstrapResult> {
  const { destination, sourcePacket, declarationPath, kernelFrom } = request;
  const { kernel: seam, lockfile: given } = request;
  const kernel = { repository: seam.repository, commit: seam.commit };
  validateSourcePacket(sourcePacket);
  const name = resolveRepositoryName(destination, request.name);
  const { commit } = readKernel(kernel, declarationPath);
  const lockfile = await lockfileFor(given);
  return bootstrap({
    destination: resolve(destination),
    json: false,
    name,
    sourcePacket,
    kernelPin:
      kernelFrom === "clone"
        ? clonePin(kernel)
        : generatedPin(readKernelPin(TEMPLATE_ROOT), commit),
    kernelCommit: commit,
    lockfile,
  });
}

function bootstrapOnKernel(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  return bootstrapWithKernel({
    destination: options.destination,
    name: options.name,
    sourcePacket: options.sourcePacket,
    kernel: {
      repository: findSiblingKernel(TEMPLATE_ROOT, process.env),
      commit: readKernelPin(TEMPLATE_ROOT).commit,
    },
    lockfile: "committed",
  });
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    if (options === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    const result = await bootstrapOnKernel(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Created a repository at ${result.destination}, with the kernel at the template's Pin\n`,
    );
    return 0;
  } catch (error) {
    return writeCliError(error, json);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
