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
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapOptions,
  HELP,
  parseArgs,
  RUNTIME_FAILURE_REPAIR,
  resolveRepositoryName,
  validateSourcePacket,
} from "./bootstrap-arguments.ts";
import { CliError } from "./cli-error.ts";
import { clonePin, generatedPin, readKernelPin } from "./kernel-pin.ts";
import { type KernelSeam, readKernel } from "./kernel-reader.ts";
import {
  type Copy,
  KERNEL_LOCKFILE,
  KERNEL_RECIPE,
  type Layout,
  lintsCode,
  type Profile,
  type ProjectRecipe,
  type Starter,
  UNCOPIED_NAMES,
} from "./recipe.ts";
import { substituteTokens } from "./token-substitution.ts";

const SCHEMA_VERSION = 1;
const TEMPLATE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface BootstrapResult {
  destination: string;
  generatedFiles: number;
  profile: Profile;
  runId: string;
  schemaVersion: number;
  sourcePacket: string;
  starter?: Starter;
  status: "created";
  variant: Layout;
}

function starterOption(recipe: ProjectRecipe): { starter?: Starter } {
  const { starter } = recipe.request;
  return starter === undefined ? {} : { starter };
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
  return (
    !UNCOPIED_NAMES.includes(name) &&
    (only === undefined || only.includes(name))
  );
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
      "profile_source_missing",
      "recipe folder is missing",
    );
  if (!stats.isDirectory())
    throw sourceRefusal(
      source,
      "profile_source_wrong_type",
      "recipe folder is not a folder",
    );
}

async function requireSourceFile(source: string): Promise<void> {
  const stats = await lstatIfPresent(source);
  if (stats === undefined)
    throw sourceRefusal(
      source,
      "profile_source_missing",
      "recipe file is missing",
    );
  if (!stats.isFile())
    throw sourceRefusal(
      source,
      "profile_source_wrong_type",
      "recipe file is not a regular file",
    );
}

async function requireCopySource(copy: Copy): Promise<void> {
  const folder = join(TEMPLATE_ROOT, copy.from);
  await requireSourceFolder(folder);
  for (const name of copy.only ?? []) {
    await requireSourceFile(join(folder, name));
  }
}

async function requireProfileSources(recipe: ProjectRecipe): Promise<void> {
  await Promise.all(recipe.copies.map(requireCopySource));
}

async function copyRecipe(
  recipe: ProjectRecipe,
  staging: string,
): Promise<void> {
  for (const copy of recipe.copies) {
    const into = join(staging, copy.into);
    await mkdir(into, { recursive: true });
    await copyDirectoryContents(
      join(TEMPLATE_ROOT, copy.from),
      into,
      copy.only,
    );
  }
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

const MARKER_GUIDANCE =
  "A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.";

function commentGuidance(recipe: ProjectRecipe): string {
  const refusal = lintsCode(recipe)
    ? "Lint refuses a comment in code, so say it in a name, a type or a test title."
    : "Write no comment in code. Say it in a name, a type or a test title.";
  const owner = lintsCode(recipe)
    ? "\nThe lint rule files in config/ are the template's. Change a lint rule in the template, not here.\n"
    : "";
  return `## Comments\n\n${refusal}\n${MARKER_GUIDANCE}\n${owner}`;
}

async function writeRepositoryContext(
  staging: string,
  options: BootstrapOptions,
): Promise<void> {
  const revision = templateIdentity(["rev-parse", "HEAD"]);
  const dirty = templateIdentity(["status", "--porcelain"]);
  const metadata = {
    specRevision: "4",
    templateRevision: revision,
    templateDirty: dirty.length > 0,
    sourcePacket: options.sourcePacket,
    starter: options.recipe.cli,
    profile: options.recipe.request.profile,
    entryPoint: "src/cli.ts",
    commandOwner: "src/commands.ts",
    registrationVersion: 1,
  };
  await writeFile(
    join(staging, ".cli-design-template.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  const check = options.recipe.checkCommand;
  await writeFile(
    join(staging, "AGENTS.md"),
    `# Repository commands\n\nUse the existing repository CLI at src/cli.ts. Add commands through src/commands.ts.\nKeep domain implementation in separate files and preserve one public application CLI.\n\nCheck command: ${check}\nSmoke: bun run start --help\nSource packet: ${options.sourcePacket}\nTemplate source: ${metadata.templateRevision}\n\n${commentGuidance(options.recipe)}`,
  );
}

async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const destinationState = await validateDestination(options.destination);
  const { recipe } = options;
  await requireProfileSources(recipe);

  await mkdir(dirname(options.destination), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(options.destination), ".repo-bootstrap-"),
  );
  try {
    await copyRecipe(recipe, staging);
    await writeRepositoryContext(staging, options);
    const generatedFiles = await substituteTokens(staging, options);
    if (options.lockfile !== undefined)
      await writeFile(join(staging, "bun.lock"), options.lockfile);
    await installStaging(staging, options.destination, destinationState);
    return {
      destination: options.destination,
      generatedFiles,
      profile: recipe.request.profile,
      runId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      sourcePacket: options.sourcePacket,
      ...starterOption(recipe),
      status: "created",
      variant: recipe.request.layout,
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

// Interface: Bootstrap through the kernel row, which reads the kernel commit
// and the lockfile before any staging folder exists, so a refusal leaves
// nothing behind. package.json names the kernel
// by its Pin, one dependency line at that full commit. The lockfile is the
// kernel lockfile, the bytes supplied, or none; only the trial and tests use
// the last two. Only tests ask for `kernelFrom: "clone"`. It reads each
// request field once, before its first wait.
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
    recipe: KERNEL_RECIPE,
    sourcePacket,
    kernelPin:
      kernelFrom === "clone"
        ? clonePin(kernel)
        : generatedPin(readKernelPin(TEMPLATE_ROOT), commit),
    lockfile,
  });
}

function writeError(error: unknown, json: boolean): number {
  const failure =
    error instanceof CliError
      ? error
      : new CliError(
          "runtime_failure",
          error instanceof Error ? error.message : "unexpected runtime failure",
          RUNTIME_FAILURE_REPAIR,
          1,
          false,
        );
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    status: "refused",
    error: {
      code: failure.code,
      message: failure.message,
      repair: failure.repair,
      retrySafe: failure.retrySafe,
    },
  };
  process.stderr.write(
    json
      ? `${JSON.stringify(envelope)}\n`
      : `${failure.message}\nRepair: ${failure.repair}\n`,
  );
  return failure.exitCode;
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    if (options === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    const result = await bootstrap(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Created ${result.profile} ${result.variant} repository at ${result.destination}\n`,
    );
    return 0;
  } catch (error) {
    return writeError(error, json);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
