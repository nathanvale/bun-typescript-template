import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./cli-error.ts";
import { git, type KernelSeam } from "./kernel-reader.ts";

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

export function findSiblingKernel(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
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
  throw new CliError(
    "kernel_repository_missing",
    `No kernel repository is at ${[...new Set(places)].join(" or ")}.`,
    `clone ${pin.remote} beside the template, or name its path in KERNEL_REPOSITORY`,
    1,
    false,
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
