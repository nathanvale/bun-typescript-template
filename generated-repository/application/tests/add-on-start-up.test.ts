import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { contractFor } from "agent-cli-kernel";
import { approval } from "agent-cli-kernel/addons/approval";
import { diagnosticsAddon } from "agent-cli-kernel/addons/diagnostics";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { commands } from "../src/commands.ts";
import { testFolder } from "./support/test-folder.ts";

const cli = "__REPOSITORY_NAME__";

type Installed = NonNullable<
  Parameters<typeof contractFor>[0]["installedAddons"]
>;

function startsWith(installedAddons: Installed): boolean {
  const root = testFolder("state-");
  try {
    const state = installedAddons.includes("state")
      ? { state: stateAddon({ root, report: `${cli}.status` }).descriptor }
      : {};
    contractFor({ cli, commands, installedAddons, ...state });
    return true;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the command-line tool starts on the kernel", () => {
  test("with no add-on", () => {
    expect(startsWith([])).toBe(true);
  });

  test.each([
    ["state", ["state"], stateAddon],
    ["programs", ["programs"], programsAddon],
    ["diagnostics", ["diagnostics"], diagnosticsAddon],
    ["approval, with the state it needs", ["state", "approval"], approval],
  ] as const)("with the %s add-on", (_name, installed, factory) => {
    expect([typeof factory, startsWith(installed)]).toEqual(["function", true]);
  });

  test("with every add-on together", () => {
    expect(startsWith(["state", "approval", "programs", "diagnostics"])).toBe(
      true,
    );
  });

  test("and refuses approval without state", () => {
    expect(() => startsWith(["approval"])).toThrow(
      "Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.",
    );
  });
});
