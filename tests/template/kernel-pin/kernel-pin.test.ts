import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  generatedPin,
  parseKernelPin,
  readKernelPin,
} from "../../../src/kernel-pin.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
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
  `Error: kernel-pin.json: ${key} is "${value}", an abbreviated commit. An abbreviated commit is refused, because it can come to match more than one commit. Repair: write all 40 characters of the commit.`;
const notBranch = (value: string) =>
  `Error: kernel-pin.json: branch is "${value}", which git refuses as a branch name. Repair: write the branch as git branch prints it, such as main or feature/kernel.`;
const notFull = (key: string, value: string) =>
  `Error: kernel-pin.json: ${key} is "${value}", which is not a full commit: 40 lowercase hexadecimal characters. Repair: write the commit as git rev-parse prints it.`;

function refusalFor(source: string): string {
  try {
    parseKernelPin(source);
    return "no refusal";
  } catch (error) {
    return String(error);
  }
}

test("the template's kernel pin parses, with a full pinned commit and a full carry-out identity", () => {
  const pin = readKernelPin(root);
  expect(Object.keys(pin).join(", ")).toBe(keys);
  expect(
    [pin.commit, pin.carryOutIdentity].map((commit) =>
      /^[0-9a-f]{40}$/.test(commit),
    ),
  ).toEqual([true, true]);
});

test("the template's kernel lockfile names the kernel by the Pin at the pinned commit, in full", () => {
  const pin = readKernelPin(root);
  const lockfile = readFileSync(join(root, KERNEL_LOCKFILE), "utf8");
  expect(lockfile.match(/^ {8}"agent-cli-kernel": "([^"]+)",$/m)?.[1]).toBe(
    generatedPin(pin, pin.commit),
  );
});

test("a kernel pin with its five fields is read as written, and frozen", () => {
  const pin = parseKernelPin(JSON.stringify(valid));
  expect(pin).toEqual(valid);
  expect(Object.isFrozen(pin)).toBe(true);
});

test.each(["main", "feature/kernel", "release-1.2", "v1.x/kernel_split"])(
  "branch %s is read as written",
  (branch) => {
    expect(parseKernelPin(JSON.stringify({ ...valid, branch })).branch).toBe(
      branch,
    );
  },
);

test.each([
  ["two dots in a row", "main..next"],
  ["a leading slash", "/main"],
  ["a trailing slash", "main/"],
  ["two slashes in a row", "feature//kernel"],
  ["a leading dot", ".hidden"],
  ["a component that starts with a dot", "feature/.hidden"],
  ["a component that ends in .lock", "main.lock"],
  ["a trailing dot", "main."],
  ["a leading hyphen", "-main"],
])("a branch with %s is refused with its exact message", (_case, branch) => {
  expect(refusalFor(JSON.stringify({ ...valid, branch }))).toBe(
    notBranch(branch),
  );
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
    notFull("commit", full.toUpperCase()),
  ],
  [
    "a pinned commit one character too long",
    { ...valid, commit: `${full}0` },
    notFull("commit", `${full}0`),
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
    'Error: kernel-pin.json: needs key "branch". Repair: add that key.',
  ],
  [
    "a commit that is not a string",
    { ...valid, commit: 4 },
    "Error: kernel-pin.json: commit is 4, which is not a string. Repair: write it as a string.",
  ],
  [
    "a branch that is null",
    { ...valid, branch: null },
    "Error: kernel-pin.json: branch is null, which is not a string. Repair: write it as a string.",
  ],
  [
    "a branch with a space in it",
    { ...valid, branch: "main branch" },
    notBranch("main branch"),
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

test("the Pin a generated repository holds names the kernel pin's GitHub repository at the commit given, in full, whatever commit the kernel pin names", () => {
  const candidate = "f".repeat(40);
  const pin = parseKernelPin(
    JSON.stringify({
      ...valid,
      remote: "https://github.com/some.owner/fixture-kernel.v2.git",
    }),
  );
  expect([generatedPin(pin, pin.commit), generatedPin(pin, candidate)]).toEqual(
    [
      `github:some.owner/fixture-kernel.v2#${full}`,
      `github:some.owner/fixture-kernel.v2#${candidate}`,
    ],
  );
});
