import {
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../../starters/contract3/src/kernel/index.ts";
import type {
  ApprovalCapability,
  DiagnosticsCapability,
  RunAddon,
} from "../../../../starters/contract3/src/kernel/index.ts";
import { programsAddon } from "../../../../starters/contract3/src/addons/programs/index.ts";
import { runProcessOn } from "../../../../starters/contract3/src/kernel/lifecycle.ts";
import { processHost } from "../../../../starters/contract3/src/kernel/process-host.ts";
import type {
  AttachedAddon,
  ProcessHost,
} from "../../../../starters/contract3/src/kernel/process-types.ts";
import {
  recordRuntime,
  runtimeOf,
} from "../../../../starters/contract3/src/kernel/runtime.ts";
import type { ContractRuntime } from "../../../../starters/contract3/src/kernel/runtime.ts";
import {
  authority,
  path,
  resource,
} from "../../../../starters/contract3/src/kernel/validation/brands.ts";
import { ledger, sleep } from "../ledger.ts";
import { programStopRow, programStopStation } from "../program-stop.ts";

const mode = process.env.FX_STATUS ?? "available";

const availableStatus = {
  status: "available",
  file: "/private/state/st/diagnostics/run.log",
  sinkFailure: null,
  droppedRecords: 0,
  unflushedRecords: 0,
  truncatedRecords: 0,
  countsComplete: true,
  closed: true,
};
const statuses: Readonly<Record<string, unknown>> = {
  available: availableStatus,
  unavailable: {
    status: "unavailable",
    reason: "status-unavailable",
    trusted: { droppedRecords: 2, countsComplete: false },
  },
  incomplete: {
    ...availableStatus,
    file: "/private/run.log",
    sinkFailure: "flush-timeout",
    closed: false,
  },
  "no-file": { ...availableStatus, file: null, sinkFailure: "setup" },
  "no-file-no-failure": { ...availableStatus, file: null, sinkFailure: null },
  "trusted-file": {
    status: "unavailable",
    reason: "status-invalid",
    trusted: { file: "/private/run.log" },
  },
  "trusted-file-null": {
    status: "unavailable",
    reason: "status-unavailable",
    trusted: { file: null },
  },
  "trusted-sink": {
    status: "unavailable",
    reason: "status-invalid",
    trusted: { sinkFailure: "write" },
  },
  invalid: {
    status: "available",
    file: "relative/run.log",
    sinkFailure: null,
    droppedRecords: 0,
    unflushedRecords: 0,
    truncatedRecords: 0,
    countsComplete: true,
    closed: true,
    secret: "FX-STATUS-PAYLOAD",
  },
};

function hostile(): unknown {
  if (mode === "oversize")
    return { ...availableStatus, file: `/${"a".repeat(16_000)}` };
  if (mode === "accessor") {
    let reads = 0;
    const base = { ...availableStatus };
    Object.defineProperty(base, "file", {
      enumerable: true,
      get: () => (reads++ === 0 ? "/private/run.log" : "relative/run.log"),
    });
    return base;
  }
  return { toJSON: () => availableStatus };
}

async function frozen(limit: number): Promise<unknown> {
  ledger(`freeze-start ${limit} ${Date.now()}`);
  switch (mode) {
    case "throws":
      throw new Error("FX-STATUS-PAYLOAD freeze failed");
    case "never":
      return new Promise(() => undefined);
    case "oversize":
    case "accessor":
    case "nonjson":
      return hostile();
    case "slow":
      await sleep(300);
      return statuses.available;
    default:
      return statuses[mode] ?? availableStatus;
  }
}

const statusAddon: RunAddon<DiagnosticsCapability> = {
  reportsStatus: true,
  attach(run) {
    ledger(`status-attach ${run.commandIdentity}`);
    if (mode === "attach-throws") throw new Error("Fixture attach fault.");
    const capability = {
      record: (event: string) => ledger(`record ${event}`),
    };
    if (mode === "bad-capability") Reflect.deleteProperty(capability, "record");
    const attached: AttachedAddon<DiagnosticsCapability> = {
      capability: Object.freeze(capability),
      settle(limit) {
        ledger(`status-settle ${limit ?? "none"}`);
        return Promise.resolve(true);
      },
      killNow: () => ledger("status-kill"),
    };
    return mode === "no-freeze" ? attached : { ...attached, freeze: frozen };
  },
};

const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const integer = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: { kind: "integer", minimum: 1, maximum: 60_000 },
  }) as const;
const flag = <const Name extends string>(name: Name) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: null,
  }) as const;
const input = {
  arguments: [],
  constraints: [],
  deadlineSupported: true,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const stOwnCauses = {
  DOMAIN_ST_DEADLINE_PROGRAM_STOP_UNCONFIRMED: programStopRow,
  DOMAIN_ST_REPORT_REFUSED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
} as const;
const stCauses = { ...commonCauses, ...stOwnCauses } as const;
const report = command({
  identity: "st.report",
  route: ["report"],
  summary: "Do fixture work that may be observed.",
  input: {
    ...input,
    options: [
      integer("--wait-ms"),
      flag("--record"),
      flag("--bad"),
      flag("--throw"),
      flag("--program"),
      flag("--refuse"),
    ],
  },
  capabilities: { diagnostics: true, programs: true },
  stations: [
    station(commonCauses, {
      commandIdentity: "st.report",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The fixture work finished.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "st.report:done",
    }),
    programStopStation(
      stCauses,
      "st.report",
      "DOMAIN_ST_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
    ),
    station(stCauses, {
      commandIdentity: "st.report",
      causeCode: "DOMAIN_ST_REPORT_REFUSED",
      trigger: "The fixture refused.",
      guidance: {
        next: { kind: "instruction", text: "Inspect the fixture input." },
      },
      repairAction: "Correct the fixture input.",
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "st.report:refused",
    }),
  ],
  programStopCause: "DOMAIN_ST_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
  run: async (options, context) => {
    ledger("handler-entered");
    if (options["--record"] === true) context.diagnostics.record("work", null);
    if (options["--program"] === true) {
      await context.programs.inspect({
        executable: path("/bin/sh"),
        args: ["-c", 'echo "program-done" >> "$FX_LEDGER"'],
        timeoutMilliseconds: 5_000,
        outputLimitBytes: 1024,
        shutdownMilliseconds: 500,
      });
    }
    const wait = options["--wait-ms"];
    if (wait !== undefined) await sleep(wait);
    if (options["--throw"] === true) throw new Error("FX handler fault");
    if (options["--refuse"] === true)
      return context.result(
        { commandIdentity: "st.report", causeCode: "DOMAIN_ST_REPORT_REFUSED" },
        { message: "The fixture refused.", data: null, effects: empty },
      );
    ledger("handler-done");
    return context.result(
      { commandIdentity: "st.report", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The fixture work finished.",
        data: { value: options["--bad"] === true ? Number.NaN : 1 },
        effects: empty,
      },
    );
  },
});

const plain = command({
  identity: "st.plain",
  route: ["plain"],
  summary: "Do fixture work without diagnostics.",
  input: { ...input, options: [] },
  capabilities: {},
  run: (_options, context) =>
    context.result(
      { commandIdentity: "st.plain", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The plain work finished.", data: null, effects: empty },
    ),
});

const guarded = command({
  identity: "st.guarded",
  route: ["guarded"],
  summary: "Do fixture work behind approval that may be observed.",
  input: { ...input, options: [] },
  capabilities: { diagnostics: true, approval: true },
  approval: () => ({
    authority: authority("st.owner"),
    resource: resource("st.item"),
    resourceRevision: "1",
    effects: [],
    preview: "st-preview",
  }),
  stations: [
    station(commonCauses, {
      commandIdentity: "st.guarded",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The guarded fixture work finished.",
      guidance: { next: { kind: "done" } },
      repairAction: null,
      retryDelayPolicy: { kind: "none" },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "st.guarded:done",
    }),
  ],
  run: (_options, context) => {
    ledger("handler-entered");
    return context.result(
      { commandIdentity: "st.guarded", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The guarded work finished.", data: null, effects: empty },
    );
  },
});
const approvalMode = process.env.FX_APPROVAL ?? "grant";
const approvalAddon: RunAddon<ApprovalCapability> = {
  attach() {
    ledger("approval-attach");
    if (approvalMode === "attach-throws")
      throw new Error("Fixture approval attach fault.");
    return {
      capability: {
        check() {
          ledger("check-start");
          if (approvalMode === "sync-throw")
            throw new Error("Fixture check fault.");
          if (approvalMode === "reject")
            return Promise.reject(new Error("Fixture check rejection."));
          return approvalMode === "delay"
            ? sleep(200).then(() => true)
            : Promise.resolve(approvalMode !== "deny");
        },
      },
      settle: () => Promise.resolve(true),
      killNow: () => undefined,
    };
  },
};

function observed(runtime: ContractRuntime): ContractRuntime {
  return {
    ...runtime,
    buildResult: async (result) => {
      const built = await runtime.buildResult(result);
      ledger("result-built");
      return built;
    },
    buildKernelStation: async (selected, facts, effects) => {
      const built = await runtime.buildKernelStation(selected, facts, effects);
      ledger("result-built");
      return built;
    },
  };
}

function host(real: ProcessHost): ProcessHost {
  let calls = 0;
  const jump = Number(process.env.FX_CLOCK_JUMP_MS ?? "0");
  return {
    ...real,
    now() {
      calls += 1;
      return jump > 0 && calls > 1 ? real.now() + jump : real.now();
    },
  };
}

function throwingSettle<C>(addon: RunAddon<C>): RunAddon<C> {
  return {
    attach(run) {
      const attached = addon.attach(run);
      return {
        ...attached,
        settle() {
          ledger("settle-throws");
          if (process.env.FX_SETTLE_THROWS === "async")
            return Promise.reject(new Error("Fixture settle rejection."));
          throw new Error("Fixture settle fault.");
        },
      };
    },
  };
}
const programs =
  process.env.FX_SETTLE_THROWS !== undefined
    ? throwingSettle(programsAddon())
    : programsAddon();

const contract = contractFor({
  cli: "st",
  commands: [report, plain, guarded],
  causes: stOwnCauses,
  installedAddons: ["diagnostics", "programs", "approval"],
});
const runtime = runtimeOf(contract);
if (!runtime) throw new Error("Fixture contract has no runtime.");
const wrapped = {};
recordRuntime(wrapped, observed(runtime));
ledger(`front-door-start ${Date.now()}`);
await runProcessOn(
  wrapped,
  { addons: { diagnostics: statusAddon, programs, approval: approvalAddon } },
  () => host(processHost()),
)(process.argv.slice(2));
