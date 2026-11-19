import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = "kernel-pin.json";
const fullCommit = /^[0-9a-f]{40}$/;
const abbreviatedCommit = /^[0-9a-f]{1,39}$/;
const fieldPatterns = {
  repository: /^[\w.-]+$/,
  remote: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/,
  commit: fullCommit,
  branch: /^[\w./-]+$/,
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

function checkedField(entries: Map<string, unknown>, field: Field): string {
  if (!entries.has(field)) fail(`needs key "${field}". Repair: add that key.`);
  const value = entries.get(field);
  if (typeof value !== "string")
    fail(
      `${field} is ${JSON.stringify(value)}, which is not a string. Repair: write it as a string.`,
    );
  const pattern = fieldPatterns[field];
  if (pattern.test(value)) return value;
  return fail(
    pattern === fullCommit
      ? commitProblem(field, value)
      : `${field} is "${value}", which does not match ${pattern}. Repair: write a value that pattern matches.`,
  );
}

export function parseKernelPin(source: string): KernelPin {
  const entries = entriesOf(source);
  for (const key of entries.keys())
    if (!fields.includes(key))
      fail(`has key "${key}". Repair: use only ${fields.join(", ")}.`);
  return {
    repository: checkedField(entries, "repository"),
    remote: checkedField(entries, "remote"),
    commit: checkedField(entries, "commit"),
    branch: checkedField(entries, "branch"),
    carryOutIdentity: checkedField(entries, "carryOutIdentity"),
  };
}

export function readKernelPin(root: string): KernelPin {
  const path = join(root, file);
  if (!existsSync(path))
    fail(
      `is missing at ${root}. The template holds no kernel source, so this kernel pin is its only record of the kernel repository. ${restoreRepair}`,
    );
  return parseKernelPin(readFileSync(path, "utf8"));
}
