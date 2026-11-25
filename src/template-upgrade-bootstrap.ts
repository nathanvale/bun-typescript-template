import { realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  findSiblingKernel,
  kernelPinFile,
  readKernelPin,
  writeKernelPin,
} from "./kernel-pin.ts";
import { TEMPLATE_JSON_FILE } from "./recipe.ts";
import {
  decodeUtf8Strict,
  gitCommitIdentityArgs,
  lstatIfPresent,
  runGitText,
  withoutGitLocation,
} from "./template-upgrade-git.ts";
import {
  OLD_TEMPLATE_JSON_FILE,
  type TemplateUpgradeInputs,
} from "./template-upgrade-inputs.ts";
import { PACKAGE_NAME_ENV } from "./token-substitution.ts";

const CLONE_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface TemplateUpgradeTrees {
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly scratchFolder: string;
}

function readRecordField(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return undefined;
  }
  return new Map<string, unknown>(Object.entries(record)).get(key);
}

function parseBootstrapErrorDetail(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const errorField = readRecordField(parsed, "error");
  const message = readRecordField(errorField, "message");
  if (typeof message !== "string" || message === "") {
    return undefined;
  }
  const repair = readRecordField(errorField, "repair");
  return typeof repair === "string" && repair !== ""
    ? `${message} (${repair})`
    : message;
}

function summarizeBootstrapFailure(stderr: string, stdout: string): string {
  const trimmedStderr = stderr.trim();
  if (trimmedStderr !== "") {
    return parseBootstrapErrorDetail(trimmedStderr) ?? trimmedStderr;
  }
  const trimmedStdout = stdout.trim();
  return trimmedStdout === ""
    ? "bootstrap exited with no output"
    : trimmedStdout;
}

async function resolveBootstrappedStampFile(
  destination: string,
  label: "old" | "new",
): Promise<string> {
  const [currentStats, oldStats] = await Promise.all([
    lstatIfPresent(join(destination, TEMPLATE_JSON_FILE)),
    lstatIfPresent(join(destination, OLD_TEMPLATE_JSON_FILE)),
  ]);
  if (currentStats !== undefined && oldStats !== undefined) {
    throw new CliError(
      "regeneration_stamp_duplicate",
      `${label} regeneration wrote both ${TEMPLATE_JSON_FILE} and ${OLD_TEMPLATE_JSON_FILE}`,
      `inspect bootstrap at that template commit and keep only ${TEMPLATE_JSON_FILE}`,
      1,
      false,
    );
  }
  if (currentStats !== undefined) {
    return TEMPLATE_JSON_FILE;
  }
  if (oldStats !== undefined) {
    return OLD_TEMPLATE_JSON_FILE;
  }
  throw new CliError(
    "regeneration_stamp_missing",
    `${label} regeneration did not write ${TEMPLATE_JSON_FILE}`,
    `verify the template commit's bootstrap writes ${TEMPLATE_JSON_FILE}`,
    1,
    false,
  );
}

async function readBootstrappedStampRevision(
  destination: string,
  stampFile: string,
  label: "old" | "new",
): Promise<string> {
  const stampPath = join(destination, stampFile);
  let text: string;
  try {
    text = decodeUtf8Strict(
      new Uint8Array(await readFile(stampPath)),
      `${label} regeneration ${stampFile}`,
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      "regeneration_stamp_missing",
      `${label} regeneration did not write ${stampFile}`,
      `verify the template commit's bootstrap writes ${stampFile}`,
      1,
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(
      "regeneration_stamp_invalid",
      `${label} regeneration wrote invalid JSON to ${stampFile}`,
      "inspect bootstrap at that template commit",
      1,
      false,
    );
  }
  const revision: unknown =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? new Map<string, unknown>(Object.entries(parsed)).get("templateRevision")
      : undefined;
  if (typeof revision !== "string") {
    throw new CliError(
      "regeneration_stamp_invalid",
      `${label} regeneration ${stampFile} has no templateRevision`,
      "inspect bootstrap at that template commit",
      1,
      false,
    );
  }
  return revision;
}

interface BootstrapCommitRequest {
  readonly templateRoot: string;
  readonly scratchFolder: string;
  readonly label: "old" | "new";
  readonly commit: string;
  readonly repositoryName: string;
  readonly packageName: string;
  readonly sourcePacket: string;
  readonly repositoryPinnedCommit: string;
  readonly kernelRepository: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function pinTemplateCloneToRepositoryPin(
  request: BootstrapCommitRequest,
  cloneFolder: string,
): string | undefined {
  const { label, commit, repositoryPinnedCommit, env } = request;
  let currentPin: ReturnType<typeof readKernelPin>;
  try {
    currentPin = readKernelPin(cloneFolder);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "template_pin_invalid",
      `${label} template commit ${commit.slice(0, 7)} has an invalid ${kernelPinFile}: ${detail}`,
      `restore a valid ${kernelPinFile} at template commit ${commit.slice(0, 7)}`,
      1,
      false,
    );
  }
  if (currentPin.commit === repositoryPinnedCommit) {
    return undefined;
  }
  writeKernelPin(cloneFolder, {
    ...currentPin,
    commit: repositoryPinnedCommit,
  });
  runGitText(
    cloneFolder,
    ["--literal-pathspecs", "add", "--", kernelPinFile],
    {
      code: "regeneration_pin_failed",
      message: `cannot stage ${kernelPinFile} in temporary ${label} template clone`,
      repair: `verify git can write inside the temporary clone at ${commit.slice(0, 7)}, then rerun`,
    },
    { env, timeoutMilliseconds: CLONE_TIMEOUT_MS },
  );
  runGitText(
    cloneFolder,
    [
      ...gitCommitIdentityArgs(cloneFolder, env),
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `temporary template upgrade pin ${repositoryPinnedCommit.slice(0, 7)}`,
    ],
    {
      code: "regeneration_pin_failed",
      message: `cannot commit repository Pin ${repositoryPinnedCommit.slice(0, 7)} in temporary ${label} template clone`,
      repair: `verify git can commit inside the temporary clone at ${commit.slice(0, 7)}, then rerun`,
    },
    { env, timeoutMilliseconds: CLONE_TIMEOUT_MS },
  );
  return runGitText(
    cloneFolder,
    ["rev-parse", "HEAD"],
    {
      code: "regeneration_pin_failed",
      message: `cannot read temporary commit in ${label} template clone`,
      repair: `verify git in the temporary clone at ${commit.slice(0, 7)}, then rerun`,
    },
    { env, timeoutMilliseconds: CLONE_TIMEOUT_MS },
  );
}

function decodeUtf8IfValid(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

async function rewriteTemporaryCommitInTree(
  folder: string,
  temporaryCommit: string,
  realCommit: string,
): Promise<void> {
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = join(folder, entry.name);
    if (entry.isDirectory()) {
      await rewriteTemporaryCommitInTree(fullPath, temporaryCommit, realCommit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const text = decodeUtf8IfValid(new Uint8Array(await readFile(fullPath)));
    if (text !== undefined && text.includes(temporaryCommit)) {
      await writeFile(fullPath, text.replaceAll(temporaryCommit, realCommit));
    }
  }
}

async function normalizeRegeneratedStamp(
  destination: string,
  stampFile: string,
  realCommit: string,
  label: "old" | "new",
): Promise<void> {
  const stampPath = join(destination, stampFile);
  const text = decodeUtf8Strict(
    new Uint8Array(await readFile(stampPath)),
    `${label} regeneration ${stampFile}`,
  );
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "regeneration_stamp_invalid",
      `${label} regeneration wrote a non-object ${stampFile}`,
      "inspect bootstrap at that template commit",
      1,
      false,
    );
  }
  const normalized = Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => {
      if (key === "templateRevision") {
        return [key, realCommit];
      }
      if (key === "templateDirty") {
        return [key, false];
      }
      return [key, value];
    }),
  );
  await writeFile(stampPath, `${JSON.stringify(normalized, null, 2)}\n`);
}

function cloneTemplateCommit(
  request: BootstrapCommitRequest,
  cloneFolder: string,
): void {
  const { templateRoot, scratchFolder, label, commit, env } = request;
  runGitText(
    scratchFolder,
    [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--",
      templateRoot,
      cloneFolder,
    ],
    {
      code: "regeneration_clone_failed",
      message: `cannot clone template at ${commit.slice(0, 7)} for ${label} regeneration`,
      repair: `verify ${templateRoot} is a readable git checkout, then rerun`,
    },
    { env, timeoutMilliseconds: CLONE_TIMEOUT_MS },
  );
  runGitText(
    cloneFolder,
    ["checkout", "--quiet", "--detach", commit],
    {
      code: "regeneration_checkout_failed",
      message: `cannot check out template commit ${commit.slice(0, 7)} for ${label} regeneration`,
      repair: `verify commit ${commit} exists with complete objects in ${templateRoot}, then rerun`,
    },
    { env, timeoutMilliseconds: CLONE_TIMEOUT_MS },
  );
}

function runBootstrapAtCommit(
  request: BootstrapCommitRequest,
  cloneFolder: string,
  destination: string,
): void {
  const {
    label,
    commit,
    repositoryName,
    packageName,
    sourcePacket,
    repositoryPinnedCommit,
    kernelRepository,
    env,
  } = request;
  const bootstrapScript = join(cloneFolder, "src", "bootstrap.ts");
  const child = Bun.spawnSync(
    [
      process.execPath,
      "run",
      bootstrapScript,
      "--destination",
      destination,
      "--source-packet",
      sourcePacket,
      "--name",
      repositoryName,
      "--json",
    ],
    {
      cwd: cloneFolder,
      env: {
        ...withoutGitLocation(env),
        KERNEL_REPOSITORY: kernelRepository,
        [PACKAGE_NAME_ENV]: packageName,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: BOOTSTRAP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (child.exitedDueToTimeout) {
    throw new CliError(
      "regeneration_failed",
      `${label} bootstrap at ${commit.slice(0, 7)} with Pin ${repositoryPinnedCommit.slice(0, 7)} did not finish within ${BOOTSTRAP_TIMEOUT_MS} ms`,
      `run bootstrap at ${commit.slice(0, 7)} by hand to see where it waits, then rerun`,
      1,
      false,
    );
  }
  if (child.exitCode !== 0) {
    const detail = summarizeBootstrapFailure(
      new TextDecoder("utf-8").decode(child.stderr),
      new TextDecoder("utf-8").decode(child.stdout),
    );
    throw new CliError(
      "regeneration_failed",
      `${label} bootstrap at ${commit.slice(0, 7)} with Pin ${repositoryPinnedCommit.slice(0, 7)} failed: ${detail}`,
      `ensure KERNEL_REPOSITORY holds Pin ${repositoryPinnedCommit.slice(0, 7)}, or move the repository's Pin if template commit ${commit.slice(0, 7)} requires a newer kernel commit, then rerun`,
      1,
      false,
    );
  }
}

async function bootstrapAtCommit(
  request: BootstrapCommitRequest,
): Promise<string> {
  const cloneFolder = join(request.scratchFolder, "clones", request.label);
  const destination = join(
    request.scratchFolder,
    request.label,
    request.repositoryName,
  );
  cloneTemplateCommit(request, cloneFolder);
  const temporaryCommit = pinTemplateCloneToRepositoryPin(request, cloneFolder);
  runBootstrapAtCommit(request, cloneFolder, destination);
  const expectedCommit = temporaryCommit ?? request.commit;
  const stampFile = await resolveBootstrappedStampFile(
    destination,
    request.label,
  );
  const stampedRevision = await readBootstrappedStampRevision(
    destination,
    stampFile,
    request.label,
  );
  if (stampedRevision !== expectedCommit) {
    throw new CliError(
      "regeneration_revision_mismatch",
      `${request.label} regeneration stamped ${stampedRevision}, expected ${expectedCommit}`,
      "check git and bootstrap in the template checkout, then rerun",
      1,
      false,
    );
  }
  if (temporaryCommit !== undefined) {
    await rewriteTemporaryCommitInTree(
      destination,
      temporaryCommit,
      request.commit,
    );
    await normalizeRegeneratedStamp(
      destination,
      stampFile,
      request.commit,
      request.label,
    );
  }
  return destination;
}

export async function withTemplateUpgradeTrees<Result>(
  inputs: TemplateUpgradeInputs,
  env: Readonly<Record<string, string | undefined>>,
  work: (trees: TemplateUpgradeTrees) => Promise<Result>,
): Promise<Result> {
  const kernelRepository = findSiblingKernel(
    inputs.templateRoot,
    env,
    inputs.repositoryPinnedCommit,
  );
  const scratchFolder = realpathSync(
    await mkdtemp(join(tmpdir(), "template-upgrade-")),
  );
  try {
    const oldFolder = await bootstrapAtCommit({
      templateRoot: inputs.templateRoot,
      scratchFolder,
      label: "old",
      commit: inputs.baseCommit,
      repositoryName: inputs.repositoryName,
      packageName: inputs.packageName,
      sourcePacket: inputs.sourcePacket,
      repositoryPinnedCommit: inputs.repositoryPinnedCommit,
      kernelRepository,
      env,
    });
    const newFolder = await bootstrapAtCommit({
      templateRoot: inputs.templateRoot,
      scratchFolder,
      label: "new",
      commit: inputs.targetCommit,
      repositoryName: inputs.repositoryName,
      packageName: inputs.packageName,
      sourcePacket: inputs.sourcePacket,
      repositoryPinnedCommit: inputs.repositoryPinnedCommit,
      kernelRepository,
      env,
    });
    return await work({
      oldFolder,
      newFolder,
      scratchFolder,
    });
  } finally {
    await rm(scratchFolder, { force: true, recursive: true });
  }
}
