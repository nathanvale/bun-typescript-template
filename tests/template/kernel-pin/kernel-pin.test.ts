import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseKernelPin, readKernelPin } from "../../../src/kernel-pin.ts";
import { testFolder } from "../../support/test-folder.ts";

const root = join(import.meta.dir, "../../..");
const full = "0123456789abcdef0123456789abcdef01234567";
const valid = {
  repository: "fixture-kernel",
  remote: "https://github.com/owner/fixture-kernel.git",
  commit: full,
  branch: "main",
  carryOutIdentity: full,
};
const keys = "repository, remote, commit, branch, carryOutIdentity";
const abbreviated = (key: string, value: string) =>
  `Error: kernel-pin.json: ${key} is "${value}", which is not a full commit. An abbreviated commit is refused, because a pinned commit and a carry-out identity each name one commit for good. Repair: write all 40 lowercase hexadecimal characters.`;

function refusalFor(source: string): string {
  try {
    parseKernelPin(source);
    return "no refusal";
  } catch (error) {
    return String(error);
  }
}

test("the template's kernel pin parses, with a full pinned commit that equals its carry-out identity", () => {
  const pin = readKernelPin(root);
  expect(Object.keys(pin).join(", ")).toBe(keys);
  expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(pin.commit).toBe(pin.carryOutIdentity);
});

test("a kernel pin with its five fields is read as written", () => {
  expect(parseKernelPin(JSON.stringify(valid))).toEqual(valid);
});

test.each([
  [
    "an abbreviated pinned commit",
    { ...valid, commit: full.slice(0, 7) },
    abbreviated("commit", full.slice(0, 7)),
  ],
  [
    "a pinned commit one character short",
    { ...valid, commit: full.slice(0, 39) },
    abbreviated("commit", full.slice(0, 39)),
  ],
  [
    "a pinned commit in upper case",
    { ...valid, commit: full.toUpperCase() },
    abbreviated("commit", full.toUpperCase()),
  ],
  [
    "an abbreviated carry-out identity",
    { ...valid, carryOutIdentity: full.slice(0, 7) },
    abbreviated("carryOutIdentity", full.slice(0, 7)),
  ],
  [
    "a derived hash beside the five fields",
    { ...valid, treeHash: full },
    `Error: kernel-pin.json: has key "treeHash". Repair: use only ${keys}.`,
  ],
  [
    "a missing branch",
    { ...valid, branch: undefined },
    'Error: kernel-pin.json: needs key "branch" as a string. Repair: add that key.',
  ],
  [
    "a commit that is not a string",
    { ...valid, commit: 4 },
    'Error: kernel-pin.json: needs key "commit" as a string. Repair: add that key.',
  ],
  [
    "a remote address that is not an https clone address",
    { ...valid, remote: "git@github.com:owner/fixture-kernel.git" },
    'Error: kernel-pin.json: remote is "git@github.com:owner/fixture-kernel.git", which does not match /^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\.git$/. Repair: write a value that pattern matches.',
  ],
  [
    "a repository name that holds a path",
    { ...valid, repository: "owner/fixture-kernel" },
    'Error: kernel-pin.json: repository is "owner/fixture-kernel", which does not match /^[\\w.-]+$/. Repair: write a value that pattern matches.',
  ],
  [
    "a list",
    [valid],
    `Error: kernel-pin.json: must be an object. Repair: write it as an object with the keys ${keys}.`,
  ],
])("%s is refused with its exact message", (_case, pin, expected) => {
  expect(refusalFor(JSON.stringify(pin))).toBe(expected);
});

test("a kernel pin that is not JSON is refused with its exact message", () => {
  expect(refusalFor("{")).toBe(
    "Error: kernel-pin.json: is not JSON. Repair: restore it from the last commit that changed it. After its first write, only a pin move changes the kernel pin.",
  );
});

test("a missing kernel pin is refused with its exact message", () => {
  const empty = testFolder("kernel-pin-");
  try {
    expect(() => readKernelPin(empty)).toThrow(
      `kernel-pin.json: is missing at ${empty}. The template holds no kernel source, so this kernel pin is its only record of the kernel repository. Repair: restore it from the last commit that changed it. After its first write, only a pin move changes the kernel pin.`,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
