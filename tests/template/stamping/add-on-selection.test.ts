import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKernel } from "../../../src/kernel-reader.ts";
import {
  committedLockfiles,
  lockfileFor,
  selectAddons,
} from "../../../src/stamping.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";
import { notUtf8 } from "../../support/stamping-fixture.ts";

const folder = ownedFolders();

function smallKernel() {
  const repository = folder("selection-kernel-");
  const commit = kernelRepository(repository);
  return readKernel({ repository, commit }, declarationPathIn(firstLayout));
}

describe("an add-on selection", () => {
  test("holds the named add-ons in name order, whatever order they were named in", () => {
    const selection = selectAddons(smallKernel(), ["beta", "alpha", "beta"]);
    expect(selection.addons.map(({ name }) => name)).toEqual(["alpha", "beta"]);
  });

  test("names its package set after the selected add-ons that declare a package, and base when none does", () => {
    const kernel = smallKernel();
    expect({
      none: selectAddons(kernel, []).packageSet,
      beta: selectAddons(kernel, ["beta"]).packageSet,
      both: selectAddons(kernel, ["alpha", "beta"]).packageSet,
    }).toEqual({ none: "base", beta: "beta", both: "beta" });
  });
});

describe("the lockfile for an add-on selection", () => {
  test("is the template's committed lockfile for the selection's package set, byte for byte", () => {
    const template = folder("selection-template-");
    mkdirSync(join(template, committedLockfiles), { recursive: true });
    writeFileSync(join(template, committedLockfiles, "beta.lock"), notUtf8);
    writeFileSync(join(template, committedLockfiles, "base.lock"), "base\n");
    const selection = selectAddons(smallKernel(), ["beta"]);
    const bytes = lockfileFor({ source: "committed" }, selection, template);
    expect(new Uint8Array(bytes ?? [])).toEqual(notUtf8);
  });

  test("is the supplied bytes, and is absent when none is asked for, without reading the template", () => {
    const selection = selectAddons(smallKernel(), []);
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
