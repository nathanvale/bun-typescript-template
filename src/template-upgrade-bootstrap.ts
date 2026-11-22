import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli-error.ts";
import { findSiblingKernel } from "./kernel-pin.ts";
import {
  decodeUtf8Strict,
  runGitText,
  withoutGitLocation,
} from "./template-upgrade-git.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";

const CLONE_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const STAMP_FILE = ".cli-design-template.json";

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

async function readBootstrappedStampRevision(
  destination: string,
  label: "old" | "new",
): Promise<string> {
  const stampPath = join(destination, STAMP_FILE);
  let text: string;
  try {
    text = decodeUtf8Strict(
      new Uint8Array(await readFile(stampPath)),
      `${label} regeneration ${STAMP_FILE}`,
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      "regeneration_stamp_missing",
      `${label} regeneration did not write ${STAMP_FILE}`,
      "verify the template commit's bootstrap writes .cli-design-template.json",
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
      `${label} regeneration wrote invalid JSON to ${STAMP_FILE}`,
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
      `${label} regeneration ${STAMP_FILE} has no templateRevision`,
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
  readonly sourcePacket: string;
  readonly kernelRepository: string;
  readonly env: Readonly<Record<string, string | undefined>>;
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
  const { label, commit, repositoryName, sourcePacket, kernelRepository, env } =
    request;
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
      env: { ...withoutGitLocation(env), KERNEL_REPOSITORY: kernelRepository },
      stdout: "pipe",
      stderr: "pipe",
      timeout: BOOTSTRAP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (child.exitedDueToTimeout) {
    throw new CliError(
      "regeneration_failed",
      `${label} bootstrap at ${commit.slice(0, 7)} did not finish within ${BOOTSTRAP_TIMEOUT_MS} ms`,
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
      `${label} bootstrap at ${commit.slice(0, 7)} failed: ${detail}`,
      `fix the underlying bootstrap failure at ${commit.slice(0, 7)} or ensure KERNEL_REPOSITORY holds its pinned commit, then rerun`,
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
  runBootstrapAtCommit(request, cloneFolder, destination);
  const stampedRevision = await readBootstrappedStampRevision(
    destination,
    request.label,
  );
  if (stampedRevision !== request.commit) {
    throw new CliError(
      "regeneration_revision_mismatch",
      `${request.label} regeneration stamped ${stampedRevision}, expected ${request.commit}`,
      "check git and bootstrap in the template checkout, then rerun",
      1,
      false,
    );
  }
  return destination;
}

export async function withTemplateUpgradeTrees<Result>(
  inputs: TemplateUpgradeInputs,
  env: Readonly<Record<string, string | undefined>>,
  work: (trees: TemplateUpgradeTrees) => Promise<Result>,
): Promise<Result> {
  const kernelRepository = findSiblingKernel(inputs.templateRoot, env);
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
      sourcePacket: inputs.sourcePacket,
      kernelRepository,
      env,
    });
    const newFolder = await bootstrapAtCommit({
      templateRoot: inputs.templateRoot,
      scratchFolder,
      label: "new",
      commit: inputs.targetCommit,
      repositoryName: inputs.repositoryName,
      sourcePacket: inputs.sourcePacket,
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
