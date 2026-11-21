import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CauseTable } from "agent-cli-kernel";
import {
  command,
  commonCauses,
  contractFor,
  runInProcess,
  scriptedTerminal,
  station,
} from "agent-cli-kernel";
import { approval } from "agent-cli-kernel/addons/approval";
import { diagnosticsAddon } from "agent-cli-kernel/addons/diagnostics";
import { menuAddon } from "agent-cli-kernel/addons/menu";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { commands } from "../src/commands.ts";
import { testFolder } from "./support/test-folder.ts";

const cli = "__REPOSITORY_NAME__";
const identity = `${cli}.probe` as const;
const notInteractiveCause = "DOMAIN_PROBE_NEEDS_TERMINAL" as const;
const capabilityAddons = [
  "approval",
  "diagnostics",
  "menu",
  "programs",
] as const;

type Addon = "state" | (typeof capabilityAddons)[number];

const probeCauses = {
  ...commonCauses,
  [notInteractiveCause]: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const satisfies CauseTable;

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

function probe(declares: readonly Addon[]) {
  const usesMenu = declares.includes("menu");
  return command({
    identity,
    route: ["probe"],
    summary: "Report which add-ons this run attached.",
    input: noInput,
    capabilities: Object.fromEntries(
      capabilityAddons
        .filter((addon) => declares.includes(addon))
        .map((addon) => [addon, true]),
    ),
    ...(usesMenu ? { notInteractiveCause } : {}),
    stations: [
      station(probeCauses, {
        commandIdentity: identity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The run attached its add-ons.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        retryDelayPolicy: { kind: "none" },
        reachability: "required",
        unreachableRationale: null,
        independentObservable: `${identity}:attached`,
      }),
      ...(usesMenu
        ? [
            station(probeCauses, {
              commandIdentity: identity,
              causeCode: notInteractiveCause,
              trigger: "The run has no interactive terminal.",
              guidance: {
                next: {
                  kind: "instruction",
                  text: "Run in an interactive terminal.",
                },
              },
              repairAction: "Run this command in an interactive terminal.",
              retryDelayPolicy: { kind: "none" },
              reachability: "required",
              unreachableRationale: null,
              independentObservable: `${identity}:needs-terminal`,
            }),
          ]
        : []),
    ],
    run: (_input, context) =>
      context.result(
        { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
        {
          message: "The run attached its add-ons.",
          data: {
            attached: capabilityAddons.filter((addon) =>
              Object.keys(context).includes(addon),
            ),
          },
          effects: noEffects,
        },
      ),
  });
}

async function runWith(
  installed: readonly Addon[],
  declares: readonly Addon[],
  interactive = false,
) {
  const root = testFolder("add-ons-");
  try {
    const state = installed.includes("state")
      ? stateAddon({ root: join(root, "state"), report: identity })
      : undefined;
    const contract = contractFor({
      cli,
      commands: [probe(declares)],
      causes: probeCauses,
      installedAddons: installed,
      ...(state === undefined ? {} : { state: state.descriptor }),
    });
    const store = {
      grants: join(root, "grants"),
      consumed: join(root, "consumed"),
    };
    return await runInProcess(contract, {
      addons: {
        ...(installed.includes("programs")
          ? { programs: programsAddon() }
          : {}),
        ...(installed.includes("diagnostics")
          ? { diagnostics: diagnosticsAddon({ cli, environment: {} }) }
          : {}),
        ...(installed.includes("menu") ? { menu: menuAddon() } : {}),
        ...(installed.includes("approval")
          ? {
              approval: {
                attach: (control) => ({
                  capability: approval({
                    operation: identity,
                    runId: control.runId,
                    store,
                  }).capability,
                  settle: () => Promise.resolve(true),
                  killNow: () => undefined,
                }),
              },
            }
          : {}),
      },
      ...(interactive ? { terminal: scriptedTerminal([]) } : {}),
      ...(state === undefined
        ? {}
        : { emergencyRecord: state.emergencyRecord }),
    })(interactive ? ["probe"] : ["probe", "--json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function succeeded(attached: readonly string[]) {
  return {
    kind: "envelope",
    exitCode: 0,
    envelope: {
      result: { causeCode: "SUCCESS_UNCHANGED", data: { attached } },
    },
  };
}

describe("the command-line tool runs a command on the kernel", () => {
  test("with no add-on", async () => {
    expect(await runWith([], [])).toMatchObject(succeeded([]));
  });

  test.each([
    ["state", ["state"], []],
    ["programs", ["programs"], ["programs"]],
    ["diagnostics", ["diagnostics"], ["diagnostics"]],
  ] as const)(
    "with the %s add-on attached",
    async (_name, installed, attached) => {
      expect(await runWith(installed, installed)).toMatchObject(
        succeeded(attached),
      );
    },
  );

  test("with the menu add-on attached in an interactive run, and refusing a non-interactive run", async () => {
    expect(await runWith(["menu"], ["menu"], true)).toMatchObject(
      succeeded(["menu"]),
    );
    expect(await runWith(["menu"], ["menu"])).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: notInteractiveCause } },
    });
  });

  test("with the approval add-on and the state it needs, which refuses a command no grant approves", async () => {
    expect(await runWith(["state", "approval"], ["approval"])).toMatchObject({
      kind: "envelope",
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_AUTHORITY_REQUIRED" } },
    });
  });

  test("with every add-on attached together", async () => {
    const every = [
      "state",
      "approval",
      "programs",
      "diagnostics",
      "menu",
    ] as const;
    expect(
      await runWith(every, ["programs", "diagnostics", "menu"], true),
    ).toMatchObject(succeeded(["diagnostics", "menu", "programs"]));
    expect(await runWith(every, ["programs", "diagnostics"])).toMatchObject(
      succeeded(["diagnostics", "programs"]),
    );
    expect(await runWith(every, every, true)).toMatchObject({
      exitCode: 3,
      envelope: { result: { causeCode: "DOMAIN_AUTHORITY_REQUIRED" } },
    });
  });

  test("and refuses approval without state", () => {
    expect(() =>
      contractFor({ cli, commands, installedAddons: ["approval"] }),
    ).toThrow(
      "Approval requires the state add-on: list state in installedAddons and pass the add-on made by contractFor.stateAddon.",
    );
  });

  test("and refuses a menu command when menu is not installed", () => {
    expect(() =>
      contractFor({
        cli,
        commands: [probe(["menu"])],
        causes: probeCauses,
        installedAddons: [],
      }),
    ).toThrow("Declared capability add-on is not installed.");
  });

  test("and refuses a menu command without notInteractiveCause", () => {
    expect(() =>
      command({
        identity,
        route: ["probe"],
        summary: "Report which add-ons this run attached.",
        input: noInput,
        capabilities: { menu: true },
        run: (_input, context) =>
          context.result(
            { commandIdentity: identity, causeCode: "SUCCESS_UNCHANGED" },
            {
              message: "The run attached its add-ons.",
              data: null,
              effects: noEffects,
            },
          ),
      }),
    ).toThrow(
      `${identity} declares menu, so it must declare its not-interactive station (notInteractiveCause).`,
    );
  });
});
