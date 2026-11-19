import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "../../../src/kernel-reader.ts";
import { checkStamp, stampRecordPath } from "../../../src/stamp-check.ts";
import {
  lockfilePath,
  placeLockfile,
  StampRefusal,
  selectAddons,
  stampCheckerPath,
  stampKernel,
} from "../../../src/stamping.ts";
import { substituteTokens } from "../../../src/token-substitution.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  declarationFor,
  firstLayout,
} from "../../support/kernel-repository-fixture.ts";
import {
  notUtf8,
  smallKernel,
  stampRepairs,
} from "../../support/stamping-fixture.ts";

const folder = ownedFolders();
const origin = {
  kernelRepository: "small-kernel",
  stampCheckSource: join(ROOT, "src/stamp-check.ts"),
};
const tokens = { name: "demo-app", sourcePacket: "/abs/packets/demo" };
const kernelOf = (declaration?: unknown) =>
  smallKernel(folder("stamp-kernel-"), declaration);

async function rendered(files: Readonly<Record<string, string>>) {
  const staging = folder("stamp-staging-");
  for (const [path, text] of Object.entries(files)) write(staging, path, text);
  return (await substituteTokens(staging, tokens)).staging;
}

async function refusalOf(stamp: () => Promise<unknown>) {
  try {
    await stamp();
  } catch (error) {
    if (!(error instanceof StampRefusal)) throw error;
    return {
      code: error.code,
      cause: error.message.split(" Repair: ")[0],
      repair: error.repair,
    };
  }
  throw new Error("The stamp was not refused.");
}

async function conflictOf(
  kernel: Kernel,
  files: Record<string, string>,
  addons: readonly string[] = [],
) {
  const staging = await rendered(files);
  const refusal = await refusalOf(() =>
    stampKernel(staging, kernel, selectAddons(kernel, addons), origin),
  );
  return { ...refusal, left: readdirSync(staging.path).sort() };
}

const settings = { "package.json": "{}\n", ".fallowrc.json": "{}\n" };
const own = "the generated repository's own files";

describe("stamping into a rendered staging folder", () => {
  test.each([stampCheckerPath, stampRecordPath])(
    "refuses %s already in the folder as a stamp conflict, and writes nothing",
    async (path) => {
      expect(
        await conflictOf(kernelOf(), { ...settings, [path]: "own\n" }),
      ).toEqual({
        code: "stamp_conflict",
        cause: `${path} is already in ${own}.`,
        repair: stampRepairs.conflict,
        left: [".fallowrc.json", "package.json", path].sort(),
      });
    },
  );

  test("refuses a file where a folder on the way to a stamp root belongs, and writes nothing", async () => {
    expect(await conflictOf(kernelOf(), { ...settings, lib: "own\n" })).toEqual(
      {
        code: "stamp_conflict",
        cause: `lib is in ${own} and is not a folder, and stamp root "lib/core" needs it to be one.`,
        repair: stampRepairs.conflict,
        left: [".fallowrc.json", "lib", "package.json"],
      },
    );
  });

  test("stamps beside own files in a folder on the way to a stamp root", async () => {
    const kernel = kernelOf();
    const staging = await rendered({ ...settings, "lib/own.ts": "own\n" });
    await stampKernel(staging, kernel, selectAddons(kernel, []), origin);
    expect(checkStamp(staging.path)).toEqual({
      status: "intact",
      commit: kernel.commit,
      addons: [],
      fileCount: 5,
    });
  });

  test("writes no stamp record when it fails after it has written stamped source", async () => {
    const kernel = kernelOf();
    const staging = await rendered(settings);
    const missing = join(folder("stamp-no-checker-"), "absent.ts");
    let failure = "";
    try {
      await stampKernel(staging, kernel, selectAddons(kernel, []), {
        ...origin,
        stampCheckSource: missing,
      });
    } catch (error) {
      failure = String(Reflect.get(Object(error), "code"));
    }
    expect({
      failure,
      stampedSource: existsSync(
        join(staging.path, firstLayout.core, "index.ts"),
      ),
      stampRecord: existsSync(join(staging.path, stampRecordPath)),
    }).toEqual({ failure: "ENOENT", stampedSource: true, stampRecord: false });
  });

  test("leaves settings it merges nothing into as they are", async () => {
    const declaration = declarationFor(firstLayout);
    const kernel = kernelOf({
      ...declaration,
      base: { ...declaration.base, deadCodeEntries: [] },
    });
    const staging = await rendered({ "kept.txt": "kept\n" });
    await stampKernel(staging, kernel, selectAddons(kernel, []), origin);
    expect(readdirSync(staging.path).sort()).toEqual([
      stampRecordPath,
      "kept.txt",
      "lib",
      "settings",
      stampCheckerPath,
    ]);
  });

  test.each([
    {
      name: "is not JSON",
      text: "not json\n",
      why: /^it is not JSON \(/,
    },
    {
      name: "is not an object",
      text: "[]\n",
      why: /^package\.json must be an object\.$/,
    },
  ])(
    "fails before it writes anything when package.json $name, naming the file and the repair",
    async ({ text, why }) => {
      const kernel = kernelOf();
      const staging = await rendered({ ...settings, "package.json": text });
      let message = "";
      try {
        await stampKernel(
          staging,
          kernel,
          selectAddons(kernel, ["beta"]),
          origin,
        );
      } catch (error) {
        message = String(Reflect.get(Object(error), "message"));
      }
      const lead =
        "The stamp merges requirements into package.json, and it cannot be read as a JSON object in the staging folder: ";
      const repair =
        " Repair: restore package.json in the template's own files for a generated repository.";
      expect([message.startsWith(lead), message.endsWith(repair)]).toEqual([
        true,
        true,
      ]);
      expect(message.slice(lead.length, -repair.length)).toMatch(why);
      expect(readdirSync(staging.path).sort()).toEqual([
        ".fallowrc.json",
        "package.json",
      ]);
    },
  );
});

describe("placing the lockfile in a rendered staging folder", () => {
  test("writes the bytes as they are", async () => {
    const staging = await rendered(settings);
    await placeLockfile(staging, notUtf8);
    expect(
      new Uint8Array(readFileSync(join(staging.path, lockfilePath))),
    ).toEqual(notUtf8);
  });

  test("refuses a lockfile already in the folder as a stamp conflict, and keeps it", async () => {
    const staging = await rendered({ [lockfilePath]: "own\n" });
    expect(await refusalOf(() => placeLockfile(staging, notUtf8))).toEqual({
      code: "stamp_conflict",
      cause: `${lockfilePath} is already in ${own}.`,
      repair: stampRepairs.conflict,
    });
    expect(readFileSync(join(staging.path, lockfilePath), "utf8")).toBe(
      "own\n",
    );
  });
});
