import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Kernel, readKernel } from "../../../src/kernel-reader.ts";
import { stampRecordPath } from "../../../src/stamp-check.ts";
import {
  StampRefusal,
  selectAddons,
  stampCheckerPath,
  stampKernel,
} from "../../../src/stamping.ts";
import { substituteTokens } from "../../../src/token-substitution.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  declarationFor,
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const origin = {
  kernelRepository: "small-kernel",
  stampCheckSource: resolve(import.meta.dir, "../../../src/stamp-check.ts"),
};
const tokens = { name: "demo-app", sourcePacket: "/abs/packets/demo" };

function smallKernel(declaration: unknown = declarationFor(firstLayout)) {
  const repository = folder("stamp-kernel-");
  const commit = kernelRepository(
    repository,
    kernelEntries(firstLayout, declaration),
  );
  return readKernel({ repository, commit }, declarationPathIn(firstLayout));
}

async function rendered(files: Readonly<Record<string, string>>) {
  const staging = folder("stamp-staging-");
  for (const [path, text] of Object.entries(files)) write(staging, path, text);
  return (await substituteTokens(staging, tokens)).staging;
}

async function conflictOf(kernel: Kernel, files: Record<string, string>) {
  const staging = await rendered(files);
  try {
    await stampKernel(staging, kernel, selectAddons(kernel, []), origin);
  } catch (error) {
    if (!(error instanceof StampRefusal)) throw error;
    return {
      code: error.code,
      cause: error.message.split(" Repair: ")[0],
      written: readdirSync(staging.path).sort(),
    };
  }
  throw new Error("The stamp was not refused.");
}

const settings = { "package.json": "{}\n", ".fallowrc.json": "{}\n" };

describe("stamping into a rendered staging folder", () => {
  test.each([stampCheckerPath, stampRecordPath])(
    "refuses %s already in the folder as a stamp conflict, and writes nothing",
    async (path) => {
      expect(
        await conflictOf(smallKernel(), { ...settings, [path]: "own\n" }),
      ).toEqual({
        code: "stamp_conflict",
        cause: `${path} is already in the generated repository's own files.`,
        written: [".fallowrc.json", "package.json", path].sort(),
      });
    },
  );

  test("writes no stamp record when it fails after it has written stamped source", async () => {
    const kernel = smallKernel();
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
    const kernel = smallKernel({
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

  test("refuses an add-on at a commit that declares none, saying so", () => {
    const kernel = smallKernel({ ...declarationFor(firstLayout), addons: {} });
    expect(() => selectAddons(kernel, ["beta"])).toThrow(
      `"beta" is not an add-on at kernel commit ${kernel.commit}. That commit declares no add-on. Repair: Select only add-ons that commit declares.`,
    );
  });
});
