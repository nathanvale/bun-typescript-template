import { existsSync, readFileSync } from "node:fs";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  station,
} from "../../../../starters/contract3/src/kernel/index.ts";
import type {
  CauseTable,
  JsonValue,
  ProgramRequest,
  ProgramsCapability,
  RecordedEffect,
  RunSetup,
  StateAddonDescriptor,
  StateCapability,
  StateIssuer,
  StateObservation,
  StateFactoryResult,
  ApprovalCapability,
  DiagnosticsCapability,
  RunAddon,
} from "../../../../starters/contract3/src/kernel/index.ts";
import {
  callerProgramDisclosure,
  programDetails,
  programsAddon,
} from "../../../../starters/contract3/src/addons/programs/index.ts";
import { runProcessOn } from "../../../../starters/contract3/src/kernel/lifecycle.ts";
import { processHost } from "../../../../starters/contract3/src/kernel/process-host.ts";
import type { ProcessHost } from "../../../../starters/contract3/src/kernel/process-types.ts";
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
import { record } from "../../../../starters/contract3/src/kernel/validation/primitives.ts";
import { ledger, ledgerPath, sleep } from "../ledger.ts";
import { programStopRow, programStopStation } from "../program-stop.ts";

const streamProbe = new URL(
  "../../programs/fixtures/stream-probe.sh",
  import.meta.url,
).pathname;
const scenario = new Set((process.env.FX_SCENARIO ?? "").split("+"));
const marker = "FX-REJECTED-PAYLOAD";

async function ledgerHas(prefix: string, milliseconds: number) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    if (
      ledgerPath &&
      existsSync(ledgerPath) &&
      readFileSync(ledgerPath, "utf8")
        .split("\n")
        .some((line) => line.startsWith(prefix))
    )
      return true;
    await sleep(5);
  }
  return false;
}

const causes = {
  DOMAIN_FX_READ_FAILED: {
    outcome: "failed",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
  },
  DOMAIN_FX_CHANGE_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_CHANGE_UNCERTAIN: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_LOCK_HELD: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_UNRESOLVED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_FX_DEADLINE_PROGRAM_STOP_UNCONFIRMED: programStopRow,
} as const satisfies CauseTable;
const allCauses = { ...commonCauses, ...causes };

function programStopDeclaration<const Identity extends string>(
  identity: Identity,
) {
  return {
    stations: [
      station(allCauses, {
        ...words,
        commandIdentity: identity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The fixture program finished.",
        guidance: { next: { kind: "done" } },
        repairAction: null,
        independentObservable: `${identity}:done`,
      }),
      programStopStation(
        allCauses,
        identity,
        "DOMAIN_FX_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
      ),
    ],
    programStopCause: "DOMAIN_FX_DEADLINE_PROGRAM_STOP_UNCONFIRMED",
  } as const;
}

const none = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;
const empty = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
const words = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;
const inspectLedger = {
  owner: "operator",
  reason: "The fixture effect needs inspection.",
  inspect: [{ kind: "command", command: "fx.pending", args: [] }],
} as const;
const integer = <const Name extends string>(
  name: Name,
  minimum: number,
  maximum: number,
) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: false,
    repeatable: false,
    value: { kind: "integer", minimum, maximum },
  }) as const;
const choice = <const Name extends string>(
  name: Name,
  choices: readonly string[],
) =>
  ({
    name,
    aliases: [],
    summary: `Fixture ${name}.`,
    required: true,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 64,
      choices: [...choices],
      pattern: null,
    },
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

function program(
  script: string,
  overrides: Partial<Omit<ProgramRequest, "executable" | "args">> = {},
): ProgramRequest {
  return {
    executable: path("/bin/sh"),
    args: ["-c", script],
    timeoutMilliseconds: 30_000,
    outputLimitBytes: 4096,
    shutdownMilliseconds: 2_000,
    ...overrides,
  };
}

const read = command({
  identity: "fx.read",
  route: ["read"],
  summary: "Read fixture data.",
  input: { ...none, options: [integer("--size", 0, 8_388_608)] },
  capabilities: {},
  run: (input, context) => {
    ledger("dispatch-start");
    if (scenario.has("abort")) process.abort();
    return context.result(
      { commandIdentity: "fx.read", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read fixture data.",
        data: { text: "x".repeat(input["--size"] ?? 16) },
        effects: empty,
      },
    );
  },
});

const refuse = command({
  identity: "fx.refuse",
  route: ["refuse"],
  summary: "Refuse on a fixture precondition.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.refuse",
      causeCode: "DOMAIN_PRECONDITION_UNMET",
      trigger: "The fixture precondition is unmet.",
      repairAction: "Repair the fixture precondition.",
      guidance: { next: { kind: "instruction", text: "Repair the fixture." } },
      independentObservable: "fx:refuse",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.refuse", causeCode: "DOMAIN_PRECONDITION_UNMET" },
      {
        message: "The fixture precondition is unmet.",
        data: null,
        effects: empty,
      },
    ),
});

const fail = command({
  identity: "fx.fail",
  route: ["fail"],
  summary: "Fail a fixture read.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.fail",
      causeCode: "DOMAIN_FX_READ_FAILED",
      trigger: "The fixture read failed.",
      repairAction: "Inspect the fixture.",
      guidance: { next: { kind: "instruction", text: "Inspect the fixture." } },
      independentObservable: "fx:fail",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.fail", causeCode: "DOMAIN_FX_READ_FAILED" },
      { message: "The fixture read failed.", data: null, effects: empty },
    ),
});

const busy = command({
  identity: "fx.busy",
  route: ["busy"],
  summary: "Report a temporary fixture refusal.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      commandIdentity: "fx.busy",
      causeCode: "TRANSIENT_NOT_STARTED",
      trigger: "The fixture is busy.",
      repairAction: "Retry after the delay.",
      guidance: { next: { kind: "retry" } },
      retryDelayPolicy: {
        kind: "bounded",
        minimumMilliseconds: 10,
        maximumMilliseconds: 20,
      },
      reachability: "required",
      unreachableRationale: null,
      independentObservable: "fx:busy",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.busy", causeCode: "TRANSIENT_NOT_STARTED" },
      {
        message: "The fixture is busy.",
        data: null,
        effects: empty,
        retryDelayMilliseconds: 15,
      },
    ),
});

function depthWithin(value: unknown, limit: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  for (let item = stack.pop(); item; item = stack.pop()) {
    if (item.value === null || typeof item.value !== "object") continue;
    if (item.depth > limit) return false;
    for (const child of Object.values(item.value))
      stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

const json = command({
  identity: "fx.json",
  route: ["json"],
  summary: "Accept one fixture JSON payload.",
  input: {
    ...none,
    options: [
      {
        name: "--payload",
        aliases: [],
        summary: "Fixture JSON payload.",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 0,
          maxLength: 65_536,
          choices: null,
          pattern: null,
        },
      },
    ],
  },
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.json",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "The payload was accepted.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "fx:json",
    }),
    station(allCauses, {
      ...words,
      commandIdentity: "fx.json",
      causeCode: "SCHEMA_INVALID_INPUT",
      trigger: "The payload is not bounded plain JSON.",
      repairAction: "Correct the payload shape.",
      guidance: {
        next: { kind: "instruction", text: "Correct the payload shape." },
      },
      independentObservable: "fx:json-invalid",
    }),
  ],
  run: (input, context) => {
    let accepted: boolean;
    try {
      const parsed: unknown = JSON.parse(input["--payload"]);
      accepted = depthWithin(parsed, 64);
    } catch {
      accepted = false;
    }
    return accepted
      ? context.result(
          { commandIdentity: "fx.json", causeCode: "SUCCESS_UNCHANGED" },
          { message: "The payload was accepted.", data: null, effects: empty },
        )
      : context.result(
          { commandIdentity: "fx.json", causeCode: "SCHEMA_INVALID_INPUT" },
          {
            message: "The payload is not bounded plain JSON.",
            data: null,
            effects: empty,
          },
        );
  },
});

const badVariants = [
  "cycle",
  "over-depth",
  "undefined",
  "function",
  "function-tojson",
  "bigint",
  "date",
  "nan",
  "infinity",
  "negative-infinity",
  "class-instance",
  "map",
  "depth",
  "depth-scalar",
  "throw",
] as const;
class FixtureThing {
  readonly field = marker;
}
function nested(levels: number, scalar?: string): JsonValue {
  let value: JsonValue = scalar === undefined ? [] : [scalar];
  for (let level = 1; level < levels; level++) value = [value];
  return value;
}
function badData(variant: string, depth: number): JsonValue {
  const box: Record<string, JsonValue> = { marker };
  const values: Record<string, unknown> = {
    undefined,
    function: () => marker,
    bigint: 10n,
    date: new Date(0),
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    "negative-infinity": Number.NEGATIVE_INFINITY,
    "class-instance": new FixtureThing(),
    map: new Map([[marker, 1]]),
  };
  if (variant === "cycle") box.self = box;
  else if (variant === "over-depth") box.value = nested(70);
  else if (variant === "depth") return nested(depth);
  else if (variant === "depth-scalar") return nested(depth, "x");
  else if (variant === "function-tojson")
    Reflect.set(box, "toJSON", () => marker);
  else if (variant === "throw") throw new Error(marker);
  else Reflect.set(box, "value", values[variant]);
  return box;
}

const bad = command({
  identity: "fx.bad",
  route: ["bad"],
  summary: "Return fixture data that may not be plain JSON.",
  input: {
    ...none,
    options: [choice("--variant", badVariants), integer("--depth", 1, 200)],
  },
  capabilities: {},
  run: (input, context) =>
    context.result(
      { commandIdentity: "fx.bad", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Returned fixture data.",
        data: badData(input["--variant"], input["--depth"] ?? 1),
        effects: empty,
      },
    ),
});

const longChild = (ignoreTerm: boolean) =>
  `${ignoreTerm ? "trap 'echo child-term-received >> \"$FX_LEDGER\"' TERM; " : ""}echo "child-started $$" >> "$FX_LEDGER"; while :; do /bin/sleep 0.05; done`;

async function slowWork(programs: ProgramsCapability, ignoreTerm: boolean) {
  ledger("dispatch-start");
  const hold = Number(process.env.FX_HOLD_MS ?? "0");
  if (hold > 0) await sleep(hold);
  try {
    await programs.inspect(program(longChild(ignoreTerm)));
    ledger("program-returned");
  } catch {
    ledger("start-refused");
  }
  try {
    await programs.inspect(
      program('echo "late-start $$" >> "$FX_LEDGER"', {
        timeoutMilliseconds: 1000,
      }),
    );
  } catch {
    ledger("late-start-refused");
  }
}

const slow = command({
  identity: "fx.slow",
  route: ["slow"],
  summary: "Run one long fixture program.",
  input: { ...none, deadlineSupported: true, options: [flag("--ignore-term")] },
  capabilities: { programs: true },
  ...programStopDeclaration("fx.slow"),
  run: async (input, context) => {
    await slowWork(context.programs, input["--ignore-term"] === true);
    return context.result(
      { commandIdentity: "fx.slow", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The fixture program finished.", data: null, effects: empty },
    );
  },
});

const wait = command({
  identity: "fx.wait",
  route: ["wait"],
  summary: "Wait for a fixed time, then finish.",
  input: {
    ...none,
    deadlineSupported: true,
    options: [integer("--wait-ms", 1, 60_000)],
  },
  capabilities: {},
  run: async (input, context) => {
    ledger("handler-entered");
    await sleep(input["--wait-ms"] ?? 300);
    ledger("handler-done");
    return context.result(
      { commandIdentity: "fx.wait", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The fixture wait finished.", data: null, effects: empty },
    );
  },
});

const lateStart = command({
  identity: "fx.late-start",
  route: ["late-start"],
  summary: "Ask for a program after a stop request.",
  input: none,
  capabilities: { programs: true },
  run: async (_input, context) => {
    void context.programs
      .inspect(program(longChild(true)))
      .catch(() => undefined);
    await ledgerHas("child-started", 5_000);
    ledger("handler-ready");
    await ledgerHas("child-term-received", 5_000);
    ledger("late-call");
    try {
      await context.programs.inspect(program(lateChild));
      ledger("late-returned");
    } catch {
      ledger("late-refused");
    }
    return context.result(
      { commandIdentity: "fx.late-start", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The late program finished.", data: null, effects: empty },
    );
  },
});
const spawnReturn = command({
  identity: "fx.spawn-return",
  route: ["spawn-return"],
  summary: "Start a program and return without awaiting it.",
  input: {
    ...none,
    deadlineSupported: true,
    options: [integer("--return-after-ms", 1, 60_000), flag("--slow-term")],
  },
  capabilities: { programs: true },
  ...programStopDeclaration("fx.spawn-return"),
  run: async (input, context) => {
    const child =
      input["--slow-term"] === true
        ? `trap 'echo child-term-received >> "$FX_LEDGER"; /bin/sleep 0.4; exit 0' TERM; echo "child-started $$" >> "$FX_LEDGER"; while :; do /bin/sleep 0.05; done`
        : longChild(true);
    void context.programs
      .inspect(program(child, { shutdownMilliseconds: 5_000 }))
      .catch(() => undefined);
    await ledgerHas("child-started", 5_000);
    const after = input["--return-after-ms"];
    if (after !== undefined) await sleep(after);
    ledger("handler-returned");
    return context.result(
      { commandIdentity: "fx.spawn-return", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Started a program.", data: null, effects: empty },
    );
  },
});

const lateChild =
  ': FX-LATE-MARKER; echo "late-child $$" >> "$FX_LEDGER"; /bin/sleep 30';

const escapedWriter = `/usr/bin/perl -e 'use POSIX qw(setsid); pipe(my $r, my $w); my $p = fork(); if ($p == 0) { close $r; setsid(); open(my $f, ">>", $ENV{FX_LEDGER}); print $f "escaped $$\\n"; close $f; close $w; close STDERR; $| = 1; for my $i (0 .. 9) { print sprintf("FX-DRAIN-%02d-", $i) . ("d" x 187) . "\\n"; select(undef, undef, undef, 0.1); } exit 0 } close $w; my $b; sysread($r, $b, 1); exit 0'`;

const programModes = {
  isolation: {
    ...program(""),
    args: [streamProbe],
    timeoutMilliseconds: 10_000,
  },
  capture: program(
    "/usr/bin/yes FX | /usr/bin/head -c 268435456; /usr/bin/yes FX | /usr/bin/head -c 268435456 >&2",
    { timeoutMilliseconds: 20_000 },
  ),
  timeout: program(
    'echo "child-pgid $(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d " ")" >> "$FX_LEDGER"; /bin/sleep 1000 & echo "grandchild $!" >> "$FX_LEDGER"; wait',
    { timeoutMilliseconds: 300, shutdownMilliseconds: 1000 },
  ),
  "timeout-ignore-term": program(
    'trap "" TERM; echo "child-pgid $(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d " ")" >> "$FX_LEDGER"; /bin/sleep 1000 & echo "grandchild $!" >> "$FX_LEDGER"; wait',
    { timeoutMilliseconds: 300, shutdownMilliseconds: 300 },
  ),
  orphan: program(longChild(true), { shutdownMilliseconds: 300 }),
  "term-trap-sleeper": program(
    'trap \'echo term-received >> "$FX_LEDGER"\' TERM; /bin/sleep 0.3; echo child-done >> "$FX_LEDGER"; exit 0',
  ),
  "escaped-writer": program(escapedWriter, { timeoutMilliseconds: 10_000 }),
  escape: program(
    `/usr/bin/perl -e 'use POSIX qw(setsid); my $p = fork(); if ($p == 0) { setsid(); open(my $f, ">>", $ENV{FX_LEDGER}); print $f "escaped $$\\n"; close $f; close STDOUT; close STDERR; sleep 1000; exit 0 } waitpid(-1, 1); exit 0'; /bin/sleep 0.2`,
    { timeoutMilliseconds: 5_000, shutdownMilliseconds: 500 },
  ),
} as const;

const programCommand = command({
  identity: "fx.program",
  route: ["program"],
  summary: "Run one fixture inspection program.",
  input: {
    ...none,
    options: [
      choice("--mode", Object.keys(programModes)),
      integer("--timeout-ms", 1, Number.MAX_SAFE_INTEGER),
      integer("--shutdown-ms", 1, Number.MAX_SAFE_INTEGER),
    ],
  },
  capabilities: { programs: true },
  run: async (input, context) => {
    const mode = input["--mode"];
    const chosen = Object.entries(programModes).find(
      ([name]) => name === mode,
    )?.[1];
    if (!chosen) throw new Error("Unknown fixture mode.");
    const timeoutMs = input["--timeout-ms"];
    const shutdownMs = input["--shutdown-ms"];
    const request: ProgramRequest = {
      ...chosen,
      timeoutMilliseconds: timeoutMs ?? chosen.timeoutMilliseconds,
      shutdownMilliseconds: shutdownMs ?? chosen.shutdownMilliseconds,
    };
    if (mode === "orphan") {
      void context.programs.inspect(request).catch(() => undefined);
      await ledgerHas("child-started", 5_000);
      return context.result(
        { commandIdentity: "fx.program", causeCode: "SUCCESS_UNCHANGED" },
        { message: "Started an orphan program.", data: null, effects: empty },
      );
    }
    const result = await context.programs.inspect(request);
    const detail = programDetails(result);
    return context.result(
      { commandIdentity: "fx.program", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The fixture program finished.",
        data: {
          stdoutBytes: new TextEncoder().encode(result.stdout).byteLength,
          stderrBytes: new TextEncoder().encode(result.stderr).byteLength,
          markerSeen: result.stdout.includes("FX-CHILD-STREAM-MARKER"),
          stdoutSha256: new Bun.CryptoHasher("sha256")
            .update(result.stdout)
            .digest("hex"),
          exitCode: result.exitCode,
          terminationConfirmed: result.terminationConfirmed,
          outputTruncated: result.outputTruncated,
          timedOut: detail?.timedOut ?? null,
          stdoutTruncated: detail?.stdoutTruncated ?? null,
          stderrTruncated: detail?.stderrTruncated ?? null,
          attempts: detail?.attempts.map((attempt) => attempt.signal) ?? [],
          pid: detail?.pid ?? null,
        },
        effects: empty,
      },
    );
  },
});

const supplied = command({
  identity: "fx.supplied",
  route: ["supplied"],
  summary: `Run one fixture program. ${callerProgramDisclosure}`,
  input: {
    ...none,
    arguments: [
      {
        name: "program",
        summary: "Absolute path of the caller's program.",
        required: true,
        value: {
          kind: "string",
          minLength: 2,
          maxLength: 1024,
          choices: null,
          pattern: "/[A-Za-z0-9._/-]+",
        },
      },
    ],
  },
  capabilities: { programs: true },
  run: async (input, context) => {
    const result = await context.programs.supplied({
      executable: path(input.program),
      args: [],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4096,
      shutdownMilliseconds: 1000,
    });
    return context.result(
      { commandIdentity: "fx.supplied", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The caller program finished.",
        data: {
          markerSeen: result.stdout.includes("FX-CHILD-STREAM-MARKER"),
          exitCode: result.exitCode,
        },
        effects: empty,
      },
    );
  },
});

const itemArgument = (choices: readonly string[] | null) =>
  ({
    name: "item",
    summary: "Fixture item.",
    required: true,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 16,
      choices: choices === null ? null : [...choices],
      pattern: null,
    },
  }) as const;

const target = command({
  identity: "fx.target",
  route: ["target"],
  summary: "Read one fixture target.",
  input: { ...none, arguments: [itemArgument(["alpha"])] },
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.target", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Read the fixture target.", data: null, effects: empty },
    ),
});

const sourceStation = station(allCauses, {
  ...words,
  commandIdentity: "fx.source",
  causeCode: "SUCCESS_UNCHANGED",
  trigger: "The fixture source was read.",
  repairAction: null,
  guidance: {
    next: { kind: "command", command: "fx.target", args: ["{binding.item}"] },
  },
  independentObservable: "fx:source",
});

const source = command({
  identity: "fx.source",
  route: ["source"],
  summary: "Read one fixture source.",
  input: {
    ...none,
    deadlineSupported: true,
    arguments: [itemArgument(null)],
  },
  futureBindings: { item: "item" },
  capabilities: {},
  stations: [sourceStation],
  run: (input, context) => {
    ledger("dispatch-start");
    return context.result(sourceStation, {
      message: "Read the fixture source.",
      data: null,
      bindings: { item: input.item },
      effects: empty,
    });
  },
});

const undisclosed = command({
  identity: "fx.undisclosed",
  route: ["undisclosed"],
  summary: "Run one fixture program.",
  input: { ...none, arguments: [{ ...supplied.input.arguments[0] }] },
  capabilities: { programs: true },
  run: async (input, context) => {
    await context.programs.supplied({
      executable: path(input.program),
      args: [],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 4096,
      shutdownMilliseconds: 1000,
    });
    return context.result(
      { commandIdentity: "fx.undisclosed", causeCode: "SUCCESS_UNCHANGED" },
      { message: "The program finished.", data: null, effects: empty },
    );
  },
});

const crash = command({
  identity: "fx.crash",
  route: ["crash"],
  summary: "Crash after starting a fixture program.",
  input: {
    ...none,
    options: [choice("--kind", ["uncaught-exception", "unhandled-rejection"])],
  },
  capabilities: { programs: true },
  run: async (input, context) => {
    void context.programs
      .inspect(program(longChild(true)))
      .catch(() => undefined);
    await ledgerHas("child-started", 5_000);
    if (input["--kind"] === "uncaught-exception")
      setTimeout(() => {
        throw new Error(`${marker} crash`);
      }, 1);
    else void Promise.reject(new Error(`${marker} rejection`));
    await new Promise(() => undefined);
    return context.result(
      { commandIdentity: "fx.crash", causeCode: "SUCCESS_UNCHANGED" },
      { message: "Unreachable.", data: null, effects: empty },
    );
  },
});

const pending = command({
  identity: "fx.pending",
  route: ["pending"],
  summary: "Report unfinished fixture changes.",
  input: none,
  capabilities: {},
  stations: [
    station(allCauses, {
      ...words,
      commandIdentity: "fx.pending",
      causeCode: "SUCCESS_UNCHANGED",
      trigger: "Unfinished fixture changes were read.",
      repairAction: null,
      guidance: {
        next: { kind: "instruction", text: "Inspect the fixture ledger." },
      },
      independentObservable: "fx:pending",
    }),
  ],
  run: (_input, context) =>
    context.result(
      { commandIdentity: "fx.pending", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "Read unfinished fixture changes.",
        data: null,
        effects: empty,
      },
    ),
});

let intended: readonly string[] | undefined;

function observe<Effect extends string>(
  declared: readonly Effect[],
  completed: ReadonlySet<Effect>,
  uncertain: ReadonlySet<Effect>,
): StateObservation<Effect> {
  const done = [...completed].sort();
  const unsure = [...uncertain].sort();
  const remaining = declared
    .filter(
      (effect) =>
        (intended ?? declared).includes(effect) &&
        !completed.has(effect) &&
        !uncertain.has(effect),
    )
    .sort();
  const [firstUnsure, ...moreUnsure] = unsure;
  if (firstUnsure !== undefined)
    return {
      transactionState: "unknown",
      effects: {
        completed: done,
        remaining,
        uncertain: [firstUnsure, ...moreUnsure],
        inventoryComplete: true,
      },
    };
  const [firstDone, ...moreDone] = done;
  if (firstDone === undefined)
    return {
      transactionState: "unchanged",
      effects: {
        completed: [],
        remaining,
        uncertain: [],
        inventoryComplete: true,
      },
    };
  const [firstRemaining, ...moreRemaining] = remaining;
  return firstRemaining === undefined
    ? {
        transactionState: "completed",
        effects: {
          completed: [firstDone, ...moreDone],
          remaining: [],
          uncertain: [],
          inventoryComplete: true,
        },
      }
    : {
        transactionState: "partially-completed",
        effects: {
          completed: [firstDone, ...moreDone],
          remaining: [firstRemaining, ...moreRemaining],
          uncertain: [],
          inventoryComplete: true,
        },
      };
}

export function syntheticState(issuer: StateIssuer): StateFactoryResult {
  return {
    ifNoResult: issuer.ifNoResult({
      kind: "command",
      command: "fx.pending",
      args: [],
    }),
    attach<Effect extends string>(
      runId: string,
      effects: readonly Effect[],
    ): StateCapability<Effect> {
      return {
        async transaction(work) {
          const completed = new Set<Effect>();
          const uncertain = new Set<Effect>();
          let active = true;
          await work({
            async record<T>(
              effect: Effect,
              operation: (capability: RecordedEffect<Effect>) => Promise<T>,
              readBack: (result: T) => Promise<boolean>,
            ) {
              if (!active || !effects.includes(effect))
                throw new Error("Inactive or undeclared fixture effect.");
              const capability = issuer.recordedEffect(
                runId,
                effect,
                async <S>(
                  owner: string,
                  name: Effect,
                  start: () => Promise<S>,
                ) => {
                  if (!active || owner !== runId || name !== effect)
                    throw new Error("The fixture effect is not active.");
                  return start();
                },
              );
              ledger(`effect-start ${effect}`);
              const value = await operation(capability);
              let confirmed: boolean;
              try {
                confirmed = await readBack(value);
              } catch {
                confirmed = false;
              }
              (confirmed ? completed : uncertain).add(effect);
              ledger(
                `effect-${confirmed ? "confirmed" : "uncertain"} ${effect}`,
              );
              return value;
            },
          });
          active = false;
          return issuer.transactionProof(
            runId,
            observe(effects, completed, uncertain),
          );
        },
      };
    },
  };
}

const changeModes = [
  "complete",
  "partial",
  "unknown",
  "unchanged",
  "throw",
  "deadline-none",
  "deadline-complete",
  "deadline-partial",
  "deadline-stall",
] as const;
const coordination = <
  const Identity extends
    | "fx.change"
    | "fx.wide"
    | "fx.guarded"
    | "fx.guarded-owned"
    | "fx.wide-status"
    | "fx.guarded-status",
>(
  identity: Identity,
) =>
  [
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_FX_LOCK_HELD",
      trigger: "The fixture lock is held.",
      repairAction: "Inspect the fixture lock owner.",
      guidance: { handoff: inspectLedger },
      independentObservable: `${identity}:lock`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "DOMAIN_FX_UNRESOLVED",
      trigger: "An unfinished fixture change conflicts.",
      repairAction: "Inspect the unfinished fixture change.",
      guidance: { handoff: inspectLedger },
      independentObservable: `${identity}:unresolved`,
    }),
    station(allCauses, {
      ...words,
      commandIdentity: identity,
      causeCode: "SUCCESS_COMPLETED",
      trigger: "Every fixture effect was confirmed.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: `${identity}:completed`,
    }),
  ] as const;

function makeChange(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.change",
    route: ["change"],
    summary: "Apply fixture effects.",
    input: {
      ...none,
      deadlineSupported: true,
      options: [choice("--mode", changeModes)],
    },
    capabilities: { programs: true },
    effectClass: "repository-local",
    effects: ["fx.alpha", "fx.beta"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [
      ...coordination("fx.change"),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Nothing needed changing.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: "fx.change:noop",
      }),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "DOMAIN_FX_CHANGE_PARTIAL",
        trigger: "A known subset of fixture effects completed.",
        repairAction: "Inspect the fixture effects.",
        guidance: { handoff: inspectLedger },
        independentObservable: "fx.change:partial",
      }),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.change",
        causeCode: "DOMAIN_FX_CHANGE_UNCERTAIN",
        trigger: "A fixture effect could not be confirmed.",
        repairAction: "Inspect the fixture effects.",
        guidance: { handoff: inspectLedger },
        independentObservable: "fx.change:uncertain",
      }),
    ],
    run: async (input, context) => {
      const mode = input["--mode"];
      intended = mode === "unchanged" ? [] : undefined;
      const apply =
        (effect: "fx.alpha" | "fx.beta", confirmed = true) =>
        (transaction: {
          readonly record: <T>(
            effect: "fx.alpha" | "fx.beta",
            operation: () => Promise<T>,
            readBack: (result: T) => Promise<boolean>,
          ) => Promise<T>;
        }) =>
          transaction.record(
            effect,
            () => Promise.resolve(ledger(`applied ${effect}`)),
            () => Promise.resolve(confirmed),
          );
      const waitForDeadline = async () => {
        try {
          await context.programs.inspect(program(longChild(false)));
        } catch {
          ledger("start-refused");
        }
      };
      const proof = await context.state.transaction(async (transaction) => {
        if (mode === "throw") throw new Error(marker);
        if (mode === "deadline-none") return waitForDeadline();
        if (mode === "unchanged") return;
        await apply("fx.alpha")(transaction);
        if (mode === "deadline-stall") {
          await sleep(5_000);
          return;
        }
        if (mode === "partial") return;
        if (mode === "deadline-partial") return waitForDeadline();
        await apply("fx.beta", mode !== "unknown")(transaction);
        if (mode === "deadline-complete") await waitForDeadline();
      });
      const selected =
        proof.transactionState === "completed"
          ? "SUCCESS_COMPLETED"
          : proof.transactionState === "partially-completed"
            ? "DOMAIN_FX_CHANGE_PARTIAL"
            : proof.transactionState === "unknown"
              ? "DOMAIN_FX_CHANGE_UNCERTAIN"
              : "SUCCESS_UNCHANGED";
      return context.result(
        { commandIdentity: "fx.change", causeCode: selected },
        {
          message: "Applied fixture effects.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

const wideCount = Number(process.env.FX_WIDE_COUNT ?? "40");
const wideEffects = Array.from(
  { length: 40 },
  (_unused, index) =>
    `fx.wide.${String(index).padStart(2, "0")}.${"w".repeat(480)}`,
);

function recordWideEffects(state: StateCapability<string>) {
  return state.transaction(async (transaction) => {
    for (const effect of wideEffects.slice(0, wideCount))
      await transaction.record(
        effect,
        () => Promise.resolve(undefined),
        () => Promise.resolve(true),
      );
  });
}

function makeWide(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.wide",
    route: ["wide"],
    summary: "Apply many fixture effects.",
    input: { ...none, options: [flag("--go")] },
    capabilities: {},
    effectClass: "repository-local",
    effects: [wideEffects[0] ?? "fx.wide", ...wideEffects.slice(1, wideCount)],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [...coordination("fx.wide")],
    run: async (_input, context) => {
      intended = undefined;
      const proof = await recordWideEffects(context.state);
      return context.result(
        { commandIdentity: "fx.wide", causeCode: "SUCCESS_COMPLETED" },
        {
          message: "Applied many fixture effects.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

function makeGuarded(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.guarded",
    route: ["guarded"],
    summary: "Apply one approved fixture effect.",
    input: { ...none, options: [flag("--go")] },
    capabilities: { programs: true, approval: true },
    approval: () => ({
      authority: authority("fx.owner"),
      resource: resource("fx.item"),
      resourceRevision: "1",
      effects: ["fx.alpha"],
    }),
    effectClass: "repository-local",
    effects: ["fx.alpha"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [...coordination("fx.guarded")],
    run: async (_input, context) => {
      intended = undefined;
      await context.programs.inspect(
        program('echo "guarded-child $$" >> "$FX_LEDGER"', {
          timeoutMilliseconds: 5_000,
        }),
      );
      const proof = await context.state.transaction(async (transaction) => {
        await transaction.record(
          "fx.alpha",
          () => Promise.resolve(ledger("applied fx.alpha")),
          () => Promise.resolve(true),
        );
      });
      return context.result(
        { commandIdentity: "fx.guarded", causeCode: "SUCCESS_COMPLETED" },
        {
          message: "Applied the approved effect.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

function makeGuardedOwned(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.guarded-owned",
    route: ["guarded-owned"],
    summary: "Apply one fixture effect the fixture desk approves.",
    input: { ...none, options: [flag("--go")] },
    capabilities: { approval: true },
    approval: () => ({
      authority: authority("fx.desk"),
      resource: resource("fx.item"),
      resourceRevision: "1",
      effects: ["fx.alpha"],
    }),
    effectClass: "repository-local",
    effects: ["fx.alpha"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [
      ...coordination("fx.guarded-owned"),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.guarded-owned",
        causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        trigger: "The fixture desk has not approved this item.",
        repairAction: "Ask the fixture desk for an exact-item grant.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The fixture desk must approve this item.",
            inspect: [
              { kind: "instruction", text: "Fixture desk: review the item." },
            ],
          },
        },
        independentObservable: "fx.guarded-owned:denial",
      }),
    ],
    run: () =>
      Promise.reject(new Error("The owned denial fixture never dispatches.")),
  });
}

function makeWideStatus(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.wide-status",
    route: ["wide-status"],
    summary: "Apply many fixture effects.",
    input: { ...none, options: [flag("--go")] },
    capabilities: { diagnostics: true },
    effectClass: "repository-local",
    effects: [
      wideEffects[0] ?? "fx.wide-status",
      ...wideEffects.slice(1, wideCount),
    ],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [...coordination("fx.wide-status")],
    run: async (_input, context) => {
      intended = undefined;
      const proof = await recordWideEffects(context.state);
      return context.result(
        { commandIdentity: "fx.wide-status", causeCode: "SUCCESS_COMPLETED" },
        {
          message: "Applied many fixture effects.",
          data: null,
          transaction: proof,
        },
      );
    },
  });
}

function makeGuardedStatus(state: StateAddonDescriptor) {
  return changing({
    identity: "fx.guarded-status",
    route: ["guarded-status"],
    summary: "Apply one fixture effect the fixture desk approves.",
    input: { ...none, options: [flag("--go")] },
    capabilities: { approval: true, diagnostics: true },
    approval: () => ({
      authority: authority("fx.desk"),
      resource: resource("fx.item"),
      resourceRevision: "1",
      effects: ["fx.alpha"],
    }),
    effectClass: "repository-local",
    effects: ["fx.alpha"],
    ifNoResult: state.ifNoResult,
    heldLockCause: "DOMAIN_FX_LOCK_HELD",
    unresolvedCaseCause: "DOMAIN_FX_UNRESOLVED",
    stations: [
      ...coordination("fx.guarded-status"),
      station(allCauses, {
        ...words,
        commandIdentity: "fx.guarded-status",
        causeCode: "DOMAIN_AUTHORITY_REQUIRED",
        trigger: "The fixture desk has not approved this item.",
        repairAction: "Ask the fixture desk for an exact-item grant.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The fixture desk must approve this item.",
            inspect: [
              { kind: "instruction", text: "Fixture desk: review the item." },
            ],
          },
        },
        independentObservable: "fx.guarded-status:denial",
      }),
    ],
    run: () =>
      Promise.reject(new Error("The owned denial fixture never dispatches.")),
  });
}

const fixtureStatus = {
  status: "available",
  file: "/private/state/st/diagnostics/run.log",
  sinkFailure: null,
  droppedRecords: 0,
  unflushedRecords: 0,
  truncatedRecords: 0,
  countsComplete: true,
  closed: true,
};
const statusReporter: RunAddon<DiagnosticsCapability> = {
  reportsStatus: true,
  attach(run) {
    ledger(`status-attach ${run.commandIdentity}`);
    return {
      capability: Object.freeze({ record: () => undefined }),
      settle: () => Promise.resolve(true),
      killNow: () => undefined,
      freeze() {
        ledger("freeze-start");
        const length = Number(process.env.FX_STATUS_FILE_LENGTH ?? "0");
        return Promise.resolve(
          length > 1
            ? { ...fixtureStatus, file: `/${"f".repeat(length - 1)}` }
            : fixtureStatus,
        );
      },
    };
  },
};

function corrupt(kind: string, value: unknown): unknown {
  if (!record(value) || !record(value.result)) return value;
  const envelope = structuredClone(value);
  const result = envelope.result;
  if (!record(result)) return value;
  const effects = record(result.effects) ? result.effects : {};
  switch (kind) {
    case "wrong-exit":
      result.exitCode = 1;
      break;
    case "undeclared-cause":
      result.causeCode = "DOMAIN_FX_NEVER_DECLARED";
      break;
    case "fixed-field":
      result.repairAction = "Different repair words.";
      break;
    case "pair":
      result.transactionState = "partially-completed";
      break;
    case "unsorted":
      if (Array.isArray(effects.completed)) effects.completed.reverse();
      break;
    case "overlap":
      if (
        Array.isArray(effects.completed) &&
        Array.isArray(effects.uncertain)
      ) {
        const done: readonly unknown[] = effects.completed;
        const unsure: readonly unknown[] = effects.uncertain;
        effects.completed = [...done, ...unsure];
      }
      break;
    case "delay":
      result.retryDelayMilliseconds = 5;
      break;
    case "both-arms":
      result.handoff = inspectLedger;
      break;
    case "nan-data":
      result.data = { value: Number.NaN };
      break;
    default:
      envelope.message = "";
  }
  return envelope;
}

function faultRuntime(runtime: ContractRuntime): ContractRuntime {
  const kind = [...scenario]
    .find((entry) => entry.startsWith("corrupt:"))
    ?.slice("corrupt:".length);
  const stations = scenario.has("fallback-stations-missing")
    ? new Map(
        [...runtime.stations].map(([identity, entries]) => [
          identity,
          entries.filter((entry) => !entry.causeCode.startsWith("INTERNAL_")),
        ]),
      )
    : runtime.stations;
  const tamper = (
    built: Awaited<ReturnType<ContractRuntime["buildKernelStation"]>>,
  ) =>
    kind && built.ok
      ? ({ ok: true, value: corrupt(kind, built.value) } as const)
      : built;
  return {
    ...runtime,
    stations,
    buildKernelStation: async (selected, facts, effects) =>
      tamper(await runtime.buildKernelStation(selected, facts, effects)),
    buildResult: async (result) => tamper(await runtime.buildResult(result)),
    validate: scenario.has("validation-always-fails")
      ? () =>
          Promise.resolve({
            ok: false,
            path: "$",
            reason: "fixture fault",
          } as const)
      : runtime.validate,
  };
}

function fallbackCause(bytes: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const result = record(parsed) ? parsed.result : undefined;
    const cause = record(result) ? result.causeCode : undefined;
    return (
      cause === "INTERNAL_PREPARATION" ||
      (typeof cause === "string" && cause.startsWith("INTERNAL_RESULT_"))
    );
  } catch {
    return false;
  }
}

const clockJump = Number(process.env.FX_CLOCK_JUMP_MS ?? "1000000000");

function faultHost(host: ProcessHost): ProcessHost {
  const clockStart = host.now();
  let clockCalls = 0;
  let held = false;
  return {
    async write(stream, bytes) {
      if (stream !== "stdout") return host.write(stream, bytes);
      const fallback = fallbackCause(bytes);
      ledger(`stdout-write ${fallback ? "fallback" : "result"}`);
      if (scenario.has("fallback-write-fails") && fallback) return false;
      if (scenario.has("output-began-fails")) {
        await host.write(
          stream,
          bytes.subarray(0, Math.floor(bytes.byteLength / 2)),
        );
        return false;
      }
      return host.write(stream, bytes);
    },
    exit(code) {
      const holding =
        scenario.has("hold-after-drain") ||
        scenario.has("hold-after-drain-until-release");
      if (!holding || held || code === 130 || code === 143) {
        host.exit(code);
        return;
      }
      held = true;
      ledger(`drained ${code}`);
      const release = `${ledgerPath ?? ""}.release`;
      setInterval(() => {
        if (
          scenario.has("hold-after-drain-until-release") &&
          existsSync(release)
        )
          host.exit(code);
      }, 5);
    },
    onSignal(listener) {
      if (scenario.has("hook-install-fails"))
        throw new Error("Fixture hook installation failure.");
      host.onSignal(listener);
    },
    onCrash: (listener) => host.onCrash(listener),
    now() {
      clockCalls += 1;
      const real = host.now();
      return scenario.has("clock-jump") && clockCalls > 1
        ? clockStart + clockJump + (real - clockStart)
        : real;
    },
  };
}

function ledgered<C>(name: string, addon: RunAddon<C>): RunAddon<C> {
  return {
    attach(run) {
      ledger(`attach ${name}`);
      return addon.attach(run);
    },
  };
}
const approvalAddon: RunAddon<ApprovalCapability> = {
  attach: () => ({
    capability: Object.freeze({
      check: () => Promise.resolve(process.env.FX_APPROVAL === "grant"),
    }),
    settle: () => Promise.resolve(true),
    killNow: () => undefined,
  }),
};

export async function main(state?: StateAddonDescriptor): Promise<number> {
  const inspectCommands = [
    read,
    refuse,
    fail,
    busy,
    json,
    bad,
    slow,
    wait,
    lateStart,
    spawnReturn,
    programCommand,
    supplied,
    undisclosed,
    source,
    target,
    crash,
    pending,
  ] as const;
  const contract = state
    ? contractFor({
        cli: "fx",
        commands: [
          ...inspectCommands,
          makeChange(state),
          makeWide(state),
          makeGuarded(state),
          makeGuardedOwned(state),
          makeWideStatus(state),
          makeGuardedStatus(state),
        ],
        causes,
        state,
        installedAddons: ["state", "programs", "approval", "diagnostics"],
      })
    : contractFor({
        cli: "fx",
        commands: inspectCommands,
        causes,
        installedAddons: ["programs"],
      });
  const runtime = runtimeOf(contract);
  if (!runtime) throw new Error("Fixture contract has no runtime.");
  const faulted = {};
  recordRuntime(faulted, faultRuntime(runtime));
  const base: RunSetup = {
    addons: {
      programs: ledgered("programs", programsAddon()),
      approval: ledgered("approval", approvalAddon),
      diagnostics: statusReporter,
    },
  };
  const setup: RunSetup = scenario.has("emergency-recorder")
    ? {
        ...base,
        emergencyRecord: (facts) =>
          ledger(`emergency ${facts.phase} ${facts.commandIdentity ?? "none"}`),
      }
    : base;
  ledger(`front-door-start ${Date.now()}`);
  return runProcessOn(faulted, setup, () => faultHost(processHost()))(
    process.argv.slice(2),
  );
}

if (import.meta.main) await main();
