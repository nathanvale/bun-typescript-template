import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = "kernel-pin.json";
const fullCommit = /^[0-9a-f]{40}$/;
const shapes = {
  repository: /^[\w.-]+$/,
  remote: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/,
  commit: fullCommit,
  branch: /^[\w./-]+$/,
  carryOutIdentity: fullCommit,
} as const;
const keys = Object.keys(shapes);
const moved = "After its first write, only a pin move changes the kernel pin.";

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

function entriesOf(text: string): Map<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(
      `is not JSON. Repair: restore it from the last commit that changed it. ${moved}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    fail(
      `must be an object. Repair: write it as an object with the keys ${keys.join(", ")}.`,
    );
  return new Map(Object.entries(parsed));
}

function text(entries: Map<string, unknown>, key: keyof typeof shapes): string {
  const value = entries.get(key);
  if (typeof value !== "string")
    fail(`needs key "${key}" as a string. Repair: add that key.`);
  if (shapes[key].test(value)) return value;
  return fail(
    shapes[key] === fullCommit
      ? `${key} is "${value}", which is not a full commit. An abbreviated commit is refused, because it can come to match more than one commit. Repair: write all 40 lowercase hexadecimal characters.`
      : `${key} is "${value}", which does not match ${shapes[key]}. Repair: write a value that pattern matches.`,
  );
}

export function parseKernelPin(source: string): KernelPin {
  const entries = entriesOf(source);
  for (const key of entries.keys())
    if (!keys.includes(key))
      fail(`has key "${key}". Repair: use only ${keys.join(", ")}.`);
  return {
    repository: text(entries, "repository"),
    remote: text(entries, "remote"),
    commit: text(entries, "commit"),
    branch: text(entries, "branch"),
    carryOutIdentity: text(entries, "carryOutIdentity"),
  };
}

export function readKernelPin(root: string): KernelPin {
  const path = join(root, file);
  if (!existsSync(path))
    fail(
      `is missing at ${root}. The template holds no kernel source, so this kernel pin is its only record of the kernel repository. Repair: restore it from the last commit that changed it. ${moved}`,
    );
  return parseKernelPin(readFileSync(path, "utf8"));
}
