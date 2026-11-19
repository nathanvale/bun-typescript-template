import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_RECIPE, RECIPES } from "../../../src/recipe.ts";
import { committedLockfiles } from "../../../src/stamping.ts";
import { invoke } from "../../support/bootstrap-cli-fixture.ts";
import { repairs as readerRepairs } from "../../support/kernel-refusal.ts";
import {
  declarationFor,
  firstLayout,
  kernelEntries,
  type Layout,
} from "../../support/kernel-repository-fixture.ts";
import {
  declarationWith,
  leftBehind,
  refusalOf,
  stampingFixture,
} from "../../support/stamping-fixture.ts";

const run = stampingFixture();

const repairs = {
  unknown: "Select only add-ons that commit declares.",
  requirement: "Add the add-on it requires to the add-on selection.",
  lockfile:
    "Put the lockfile for that package set at that path in the template, or supply the lockfile's bytes.",
  conflict:
    "Remove it from the template's own files for a generated repository. Stamped source, its requirements, the stamp checker and the stamp record come from the stamp alone.",
};

function refused(code: string, cause: string, repair: string) {
  return { code, message: `${cause} Repair: ${repair}`, repair };
}

describe("refusals before any staging folder exists", () => {
  test("an unknown add-on is refused with the list of valid names", async () => {
    const stamping = run({ addons: ["beta", "gamma"] });
    expect(await refusalOf(stamping.request)).toEqual(
      refused(
        "addon_unknown",
        `"gamma" is not an add-on at kernel commit ${stamping.request.kernel.commit}. The add-ons there are alpha, beta.`,
        repairs.unknown,
      ),
    );
    expect(leftBehind(stamping)).toBe("no folder");
  });

  test("approval without state is refused, naming state as the add-on to add", async () => {
    const declaration = declarationWith(firstLayout, {
      approval: ["state"],
      state: [],
    });
    const stamping = run({
      entries: kernelEntries(firstLayout, declaration),
      addons: ["approval"],
    });
    expect(await refusalOf(stamping.request)).toEqual(
      refused(
        "addon_requirement_missing",
        'Add-on "approval" requires "state", which is not selected.',
        repairs.requirement,
      ),
    );
    expect(leftBehind(stamping)).toBe("no folder");
  });

  test("a missing kernel repository leaves nothing behind", async () => {
    const stamping = run();
    const missing = join(stamping.parent, "no-kernel-here");
    expect(
      await refusalOf({
        ...stamping.request,
        kernel: { ...stamping.request.kernel, repository: missing },
      }),
    ).toEqual(
      refused(
        "kernel_repository_missing",
        `No git repository is at ${missing}: that path does not exist.`,
        readerRepairs.repository,
      ),
    );
    expect(leftBehind(stamping)).toBe("no folder");
  });

  test("a missing commit leaves nothing behind", async () => {
    const stamping = run();
    const commit = "f".repeat(40);
    const { repository } = stamping.request.kernel;
    expect(
      await refusalOf({
        ...stamping.request,
        kernel: { repository, commit },
      }),
    ).toEqual(
      refused(
        "kernel_commit_missing",
        `Commit ${commit} is not in the git repository at ${repository}.`,
        readerRepairs.commit,
      ),
    );
    expect(leftBehind(stamping)).toBe("no folder");
  });

  test("a committed lockfile the template does not hold is refused", async () => {
    const stamping = run({ lockfile: { source: "committed" } });
    expect(await refusalOf(stamping.request)).toEqual(
      refused(
        "lockfile_missing",
        `The template holds no committed lockfile for package set base: ${committedLockfiles}/base.lock is not there.`,
        repairs.lockfile,
      ),
    );
    expect(leftBehind(stamping)).toBe("no folder");
  });
});

const srcLayout: Layout = { ...firstLayout, settings: "src" };

describe("a stamp conflict removes its staging folder and publishes nothing", () => {
  test.each([
    {
      name: "a stamp root the generated repository's own files already hold",
      layout: srcLayout,
      change: {},
      cause:
        'Stamp root "src" is already in the generated repository\'s own files.',
    },
    {
      name: "a package the generated repository already declares",
      layout: firstLayout,
      change: { packages: { eslint: "10.15.0" } },
      cause:
        'package.json already declares package "eslint", which the kernel requires.',
    },
    {
      name: "a dead-code entry the generated repository already holds",
      layout: firstLayout,
      change: { deadCodeEntries: ["tests/cli.test.ts"] },
      cause:
        '.fallowrc.json already holds dead-code entry "tests/cli.test.ts", which the kernel requires.',
    },
  ])("for $name", async ({ layout, change, cause }) => {
    const declaration = declarationFor(layout);
    const stamping = run({
      layout,
      entries: kernelEntries(layout, {
        ...declaration,
        base: { ...declaration.base, ...change },
      }),
    });
    expect(await refusalOf(stamping.request)).toEqual(
      refused("stamp_conflict", cause, repairs.conflict),
    );
    expect(leftBehind(stamping)).toEqual([]);
    expect(existsSync(stamping.destination)).toBe(false);
  });
});

describe("the kernel row stays off the command line", () => {
  test("the recipes the command line selects from do not hold the kernel row", () => {
    expect(RECIPES.includes(KERNEL_RECIPE)).toBe(false);
    expect(RECIPES.map(({ cli }) => cli).includes("kernel")).toBe(false);
  });

  test.each(["--addon", "--kernel", "--lockfile"])(
    "Bootstrap refuses %s as an unknown argument",
    async (option) => {
      const refusal = await invoke(
        "--profile",
        "durable",
        option,
        "state",
        "--destination",
        "/abs/never/made",
        "--source-packet",
        "/abs/packets/demo",
        "--json",
      );
      expect({
        exitCode: refusal.exitCode,
        stderr: JSON.parse(refusal.stderr) as unknown,
      }).toEqual({
        exitCode: 2,
        stderr: {
          schemaVersion: 1,
          status: "refused",
          error: {
            code: "unknown_argument",
            message: `unknown argument: ${option}`,
            repair: "run bun run bootstrap --help",
            retrySafe: true,
          },
        },
      });
    },
  );

  test("--starter kernel is refused as an unsupported starter", async () => {
    const refusal = await invoke(
      "--profile",
      "durable",
      "--starter",
      "kernel",
      "--destination",
      "/abs/never/made",
      "--source-packet",
      "/abs/packets/demo",
      "--json",
    );
    expect({
      exitCode: refusal.exitCode,
      code: (JSON.parse(refusal.stderr) as { error: { code: string } }).error
        .code,
    }).toEqual({ exitCode: 2, code: "invalid_starter" });
  });
});
