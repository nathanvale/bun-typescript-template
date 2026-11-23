import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./cli-error.ts";
import { git, type KernelSeam } from "./kernel-reader.ts";
import { withoutGitLocation } from "./template-upgrade-git.ts";

const file = "kernel-pin.json";
export const kernelPinFile = file;
const fullCommit = /^[0-9a-f]{40}$/;
const abbreviatedCommit = /^[0-9a-f]{1,39}$/;
const branchName =
  /^(?![-/])(?!.*\/$)(?!.*\/\/)(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))(?!.*\.$)[\w./-]+$/;
const fieldPatterns = {
  repository: /^[\w.-]+$/,
  remote: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/,
  commit: fullCommit,
  branch: branchName,
  carryOutIdentity: fullCommit,
} as const;
const fields = Object.keys(fieldPatterns);
const restoreRepair =
  "Repair: restore it from the last commit that changed it. After its first write, only a pin move changes the kernel pin.";

type Field = keyof typeof fieldPatterns;
type Environment = Readonly<Record<string, string | undefined>>;

export type KernelPin = {
  readonly repository: string;
  readonly remote: string;
  readonly commit: string;
  readonly branch: string;
  readonly carryOutIdentity: string;
};

function fail(problem: string): never {
  throw new Error(`${file}: ${problem}`);
}

function entriesOf(source: string): Map<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail(`is not JSON. ${restoreRepair}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    fail(
      `must be an object. Repair: write it as an object with the keys ${fields.join(", ")}.`,
    );
  return new Map(Object.entries(parsed));
}

function commitProblem(field: Field, value: string): string {
  return abbreviatedCommit.test(value)
    ? `${field} is "${value}", an abbreviated commit. An abbreviated commit is refused, because it can come to match more than one commit. Repair: write all 40 characters of the commit.`
    : `${field} is "${value}", which is not a full commit: 40 lowercase hexadecimal characters. Repair: write the commit as git rev-parse prints it.`;
}

function patternProblem(field: Field, value: string): string {
  if (fieldPatterns[field] === fullCommit) return commitProblem(field, value);
  return field === "branch"
    ? `branch is "${value}", which git refuses as a branch name. Repair: write the branch as git branch prints it, such as main or feature/kernel.`
    : `${field} is "${value}", which does not match ${fieldPatterns[field]}. Repair: write a value that pattern matches.`;
}

function checkedField(entries: Map<string, unknown>, field: Field): string {
  if (!entries.has(field)) fail(`needs key "${field}". Repair: add that key.`);
  const value = entries.get(field);
  if (typeof value !== "string")
    fail(
      `${field} is ${JSON.stringify(value)}, which is not a string. Repair: write it as a string.`,
    );
  const pattern = fieldPatterns[field];
  if (pattern.test(value)) return value;
  return fail(patternProblem(field, value));
}

export function parseKernelPin(source: string): KernelPin {
  const entries = entriesOf(source);
  for (const key of entries.keys())
    if (!fields.includes(key))
      fail(`has key "${key}". Repair: use only ${fields.join(", ")}.`);
  return Object.freeze({
    repository: checkedField(entries, "repository"),
    remote: checkedField(entries, "remote"),
    commit: checkedField(entries, "commit"),
    branch: checkedField(entries, "branch"),
    carryOutIdentity: checkedField(entries, "carryOutIdentity"),
  });
}

export function readKernelPin(root: string): KernelPin {
  const path = join(root, file);
  if (!existsSync(path))
    fail(
      `is missing at ${root}. The template holds no kernel source, so this kernel pin is its only record of the kernel repository. ${restoreRepair}`,
    );
  return parseKernelPin(readFileSync(path, "utf8"));
}

export function siblingKernelPath(root: string, { repository }: KernelPin) {
  return join(dirname(root), repository);
}

const kernelCacheFolder = "bun-typescript-template/agent-cli-kernel.git";
const networkMilliseconds = 300_000;

export function kernelCachePath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const named = environment.XDG_CACHE_HOME;
  const home =
    named !== undefined && isAbsolute(named)
      ? named
      : join(environment.HOME ?? homedir(), ".cache");
  return join(home, kernelCacheFolder);
}

function networkGit(
  args: readonly string[],
  environment: Environment,
): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    env: { ...withoutGitLocation(environment), GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: networkMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    return `git did not finish within ${networkMilliseconds} ms`;
  if (result.exitCode === 0) return undefined;
  return result.stderr.toString().trim().split("\n")[0] ?? "";
}

function cloneCache(
  cache: string,
  remote: string,
  environment: Environment,
): string | undefined {
  mkdirSync(dirname(cache), { recursive: true });
  const temporary = mkdtempSync(`${cache}-`);
  try {
    const said = networkGit(
      ["clone", "--bare", "--quiet", remote, temporary],
      environment,
    );
    if (said === undefined) renameSync(temporary, cache);
    return said;
  } catch (error) {
    if (!existsSync(cache)) throw error;
    return undefined;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function cachedKernel(
  pin: KernelPin,
  commit: string,
  places: readonly string[],
  environment: Environment,
): string {
  const cache = kernelCachePath(environment);
  const missing = (cause: string) =>
    new CliError(
      "kernel_repository_missing",
      `No kernel repository is at ${places.join(" or ")}, and ${cause}`,
      `clone ${pin.remote} beside the template, or name a clone's path in KERNEL_REPOSITORY, or rerun once git can reach ${pin.remote} to fill the kernel cache at ${cache}`,
      1,
      false,
    );
  if (!existsSync(cache)) {
    const said = cloneCache(cache, pin.remote, environment);
    if (said !== undefined)
      throw missing(
        `git could not clone ${pin.remote} into the kernel cache at ${cache}: git says "${said}".`,
      );
  }
  const holds = () => git(cache, "cat-file", ["-e", commit]).ok;
  if (holds()) return cache;
  const said = networkGit(
    [
      "--git-dir",
      cache,
      "fetch",
      "--quiet",
      pin.remote,
      "+refs/heads/*:refs/heads/*",
    ],
    environment,
  );
  if (holds()) return cache;
  throw missing(
    said === undefined
      ? `commit ${commit} is in no branch of ${pin.remote}, so the kernel cache at ${cache} does not hold it.`
      : `git could not fetch ${pin.remote} into the kernel cache at ${cache}: git says "${said}".`,
  );
}

export function findSiblingKernel(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  commit?: string,
): string {
  const named = environment.KERNEL_REPOSITORY;
  if (named !== undefined && named !== "") return named;
  const pin = readKernelPin(root);
  const shared = git(root, "rev-parse", [
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!shared.ok)
    throw new CliError(
      "template_git_unreadable",
      `git cannot say where the checkout at ${root} keeps its objects: git says "${shared.said}".`,
      "run this from a git clone of the template, or name the kernel repository's path in KERNEL_REPOSITORY",
      1,
      false,
    );
  const places = [
    siblingKernelPath(root, pin),
    siblingKernelPath(dirname(shared.stdout.toString().trim()), pin),
  ];
  const found = places.find((place) => existsSync(place));
  if (found !== undefined) return found;
  return cachedKernel(
    pin,
    commit ?? pin.commit,
    [...new Set(places)],
    environment,
  );
}

export function writeKernelPin(root: string, pin: KernelPin): boolean {
  const path = join(root, file);
  const text = `${JSON.stringify(pin, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

export function generatedPin({ remote }: KernelPin, commit: string): string {
  const repository = new URL(remote).pathname.replace(/^\/|\.git$/g, "");
  return `github:${repository}#${commit}`;
}

export function clonePin({ repository, commit }: KernelSeam): string {
  return `git+${pathToFileURL(realpathSync(repository)).href}#${commit}`;
}
