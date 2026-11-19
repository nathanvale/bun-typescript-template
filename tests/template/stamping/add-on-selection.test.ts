import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  committedLockfiles,
  lockfileFor,
  StampRefusal,
  selectAddons,
} from "../../../src/stamping.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { refused } from "../../support/kernel-refusal.ts";
import {
  declarationFor,
  firstLayout,
} from "../../support/kernel-repository-fixture.ts";
import {
  declarationWith,
  notUtf8,
  smallKernel,
  stampRepairs,
} from "../../support/stamping-fixture.ts";

const folder = ownedFolders();
const kernelOf = (declaration?: unknown) =>
  smallKernel(folder("selection-kernel-"), declaration);

function refusalOf(select: () => unknown) {
  try {
    select();
  } catch (error) {
    if (!(error instanceof StampRefusal)) throw error;
    return { code: error.code, message: error.message, repair: error.repair };
  }
  throw new Error("The selection was not refused.");
}

describe("an add-on selection", () => {
  test("holds the named add-ons in name order, whatever order they were named in", () => {
    const selection = selectAddons(kernelOf(), ["beta", "alpha", "beta"]);
    expect(selection.addons.map(({ name }) => name)).toEqual(["alpha", "beta"]);
  });

  test("names its package set after the selected add-ons that declare a package, and base when none does", () => {
    const kernel = kernelOf();
    expect({
      none: selectAddons(kernel, []).packageSet,
      beta: selectAddons(kernel, ["beta"]).packageSet,
      both: selectAddons(kernel, ["alpha", "beta"]).packageSet,
    }).toEqual({ none: "base", beta: "beta", both: "beta" });
  });

  test("cannot be changed after it is checked", () => {
    const selection = selectAddons(kernelOf(), ["beta"]);
    expect([
      Object.isFrozen(selection),
      Object.isFrozen(selection.addons),
    ]).toEqual([true, true]);
  });

  test("refuses an add-on at a commit that declares none, saying so", () => {
    const kernel = kernelOf({ ...declarationFor(firstLayout), addons: {} });
    expect(refusalOf(() => selectAddons(kernel, ["beta"]))).toEqual(
      refused(
        "addon_unknown",
        `"beta" is not an add-on at kernel commit ${kernel.commit}. That commit declares no add-on.`,
        stampRepairs.unknown,
      ),
    );
  });

  test.each(["../../outside", "base", "one+two", "Upper", "9lives"])(
    "refuses the selected add-on name %j, which a lockfile path or a stamp record cannot hold",
    (name) => {
      const kernel = kernelOf(declarationWith(firstLayout, { [name]: [] }));
      expect(refusalOf(() => selectAddons(kernel, [name]))).toEqual(
        refused(
          "addon_name_unsupported",
          `Add-on name ${JSON.stringify(name)} at kernel commit ${kernel.commit} is not one a stamp record and a lockfile path can hold: a name is lowercase letters, digits and hyphens, starts with a letter, and is not "base".`,
          stampRepairs.name,
        ),
      );
    },
  );

  test("accepts a kernel that declares such a name while the selection leaves it out", () => {
    const kernel = kernelOf(
      declarationWith(firstLayout, { "../../outside": [], plain: [] }),
    );
    expect(
      selectAddons(kernel, ["plain"]).addons.map(({ name }) => name),
    ).toEqual(["plain"]);
  });

  test("refuses a package the kernel and a selected add-on require at different versions, naming both", () => {
    const declaration = declarationFor(firstLayout);
    const kernel = kernelOf({
      ...declaration,
      base: { ...declaration.base, packages: { "left-pad": "1.0.0" } },
    });
    expect(refusalOf(() => selectAddons(kernel, ["beta"]))).toEqual(
      refused(
        "addon_requirements_disagree",
        `Kernel commit ${kernel.commit} requires package "left-pad" at "1.0.0" for the kernel and at "1.3.0" for add-on "beta".`,
        stampRepairs.disagree,
      ),
    );
    expect(selectAddons(kernel, []).packageSet).toBe("base");
  });
});

describe("the lockfile for an add-on selection", () => {
  test("is the template's committed lockfile for the selection's package set, byte for byte", () => {
    const template = folder("selection-template-");
    mkdirSync(join(template, committedLockfiles), { recursive: true });
    writeFileSync(join(template, committedLockfiles, "beta.lock"), notUtf8);
    writeFileSync(join(template, committedLockfiles, "base.lock"), "base\n");
    const selection = selectAddons(kernelOf(), ["beta"]);
    const bytes = lockfileFor({ source: "committed" }, selection, template);
    expect(new Uint8Array(bytes ?? [])).toEqual(notUtf8);
  });

  test("is the supplied bytes, and is absent when none is asked for, without reading the template", () => {
    const selection = selectAddons(kernelOf(), []);
    const nowhere = join(folder("selection-nowhere-"), "absent");
    expect({
      supplied: lockfileFor(
        { source: "supplied", bytes: notUtf8 },
        selection,
        nowhere,
      ),
      none: lockfileFor({ source: "none" }, selection, nowhere),
    }).toEqual({ supplied: notUtf8, none: undefined });
  });
});
