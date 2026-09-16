import { randomUUID } from "node:crypto";

const CONTRACT_VERSION = "2.0.0";
const COMMANDS = [
  {
    commandIdentity: "example.status",
    effectClass: "inspect",
    route: ["status"],
    summary: "Inspect the starter without changing data.",
  },
] as const;

const AVAILABLE_PATHS = [
  "example.command-discovery",
  "example.discovery",
  "example.help",
  "example.status",
];

function effects() {
  return {
    completed: [],
    inventoryComplete: true,
    remaining: [],
    uncertain: [],
  };
}

function success(commandIdentity: string, data: unknown, message: string) {
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message,
    result: {
      causeCode: "SUCCESS_UNCHANGED",
      commandIdentity,
      data,
      effectClass: "inspect",
      effects: effects(),
      exitCode: 0,
      failureClass: null,
      nextAction: "No follow-up is required.",
      outcome: "success",
      repairAction: null,
      retryable: false,
      runId: randomUUID(),
      transactionState: "unchanged",
    },
  };
}

function refusal(message: string) {
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message,
    result: {
      causeCode: "USAGE_INVALID_INVOCATION",
      commandIdentity: "example.dispatch",
      data: null,
      effectClass: "inspect",
      effects: effects(),
      exitCode: 2,
      failureClass: "usage",
      nextAction: "Run example --help and choose a listed command.",
      outcome: "refused",
      repairAction: "Choose one supported command and retry.",
      retryable: false,
      runId: randomUUID(),
      transactionState: "unchanged",
    },
  };
}

type InternalFailureStationBase = {
  commandIdentity: "example.status";
  effectClass: "inspect";
  exitCode: 1;
  failureClass: "internal";
  nextAction: string;
  outcome: "failed";
  retryable: false;
  transactionState: "unchanged";
};

type SerializationFailureStation = InternalFailureStationBase & {
  causeCode: "INTERNAL_RESULT_SERIALIZATION";
  message: "The machine result could not be serialized.";
  repairAction: "Inspect the serialization failure before retrying.";
  trigger: "The machine status result cannot be serialized.";
};

type OutputEmissionFailureStation = InternalFailureStationBase & {
  causeCode: "INTERNAL_RESULT_EMISSION";
  message: "The machine result could not be emitted.";
  nextAction: "Inspect stdout and retry example status.";
  repairAction: "Inspect the output stream before retrying.";
  trigger: "The machine status result cannot be emitted.";
};

type InternalFailureStation =
  | SerializationFailureStation
  | OutputEmissionFailureStation;

const SERIALIZATION_FAILURE_STATION: SerializationFailureStation = {
  commandIdentity: "example.status",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  causeCode: "INTERNAL_RESULT_SERIALIZATION",
  message: "The machine result could not be serialized.",
  nextAction: "Inspect the runtime and retry example status.",
  outcome: "failed",
  repairAction: "Inspect the serialization failure before retrying.",
  retryable: false,
  transactionState: "unchanged",
  trigger: "The machine status result cannot be serialized.",
};

const OUTPUT_EMISSION_FAILURE_STATION: OutputEmissionFailureStation = {
  commandIdentity: "example.status",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  causeCode: "INTERNAL_RESULT_EMISSION",
  message: "The machine result could not be emitted.",
  nextAction: "Inspect stdout and retry example status.",
  outcome: "failed",
  repairAction: "Inspect the output stream before retrying.",
  retryable: false,
  transactionState: "unchanged",
  trigger: "The machine status result cannot be emitted.",
};

function internalFailure(station: InternalFailureStation) {
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message: station.message,
    result: {
      causeCode: station.causeCode,
      commandIdentity: station.commandIdentity,
      data: null,
      effectClass: station.effectClass,
      effects: effects(),
      exitCode: station.exitCode,
      failureClass: station.failureClass,
      nextAction: station.nextAction,
      outcome: station.outcome,
      repairAction: station.repairAction,
      retryable: station.retryable,
      runId: randomUUID(),
      transactionState: station.transactionState,
    },
  };
}

function discoveryData() {
  return {
    commands: COMMANDS,
    contractVersion: CONTRACT_VERSION,
    effectExclusions: [
      "The simple starter never changes user data or configuration.",
    ],
    exitMeanings: {
      "0": "success",
      "1": "internal",
      "2": "usage",
      "3": "domain",
      "4": "schema",
      "75": "transient",
    },
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  };
}

function commandDiscovery() {
  return {
    command: COMMANDS[0],
    semantics: "possible-outcomes",
    stations: [
      {
        causeCode: "SUCCESS_UNCHANGED",
        commandIdentity: "example.status",
        effectClass: "inspect",
        exitCode: 0,
        failureClass: null,
        guidance: { nextAction: "No follow-up is required." },
        outcome: "success",
        reachability: "required",
        repairAction: null,
        retryable: false,
        retryDelayPolicy: { kind: "none" },
        transactionState: "unchanged",
        trigger: "The status inspection completes.",
        unreachableRationale: null,
      },
      failureDiscoveryStation(SERIALIZATION_FAILURE_STATION),
      failureDiscoveryStation(OUTPUT_EMISSION_FAILURE_STATION),
    ],
  };
}

function failureDiscoveryStation(station: InternalFailureStation) {
  return {
    causeCode: station.causeCode,
    commandIdentity: station.commandIdentity,
    effectClass: station.effectClass,
    exitCode: station.exitCode,
    failureClass: station.failureClass,
    guidance: { nextAction: station.nextAction },
    outcome: station.outcome,
    reachability: "required",
    repairAction: station.repairAction,
    retryable: station.retryable,
    retryDelayPolicy: { kind: "none" },
    transactionState: station.transactionState,
    trigger: station.trigger,
    unreachableRationale: null,
  };
}

function hasJson(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  return options.includes("--json");
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function emit(value: string): void {
  process.stdout.write(value);
}

function render(value: unknown, json: boolean, human: string): void {
  emit(json ? serialize(value) : `${human}\n`);
}

function reportInternalFailure(
  station: InternalFailureStation,
  json: boolean,
): number {
  const failure = internalFailure(station);
  if (json) {
    render(failure, true, failure.message);
  } else {
    process.stderr.write(
      `${failure.message}\nRepair: ${failure.result.repairAction}\n`,
    );
  }
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    render(
      success(
        "example.help",
        {
          commands: COMMANDS,
          options: [
            {
              name: "--json",
              summary: "Emit one Contract Core envelope.",
              valueName: null,
            },
          ],
          summary: "Read-only example CLI.",
          usage: "example status [--json]",
        },
        "Show help.",
      ),
      json,
      "Usage: example status [--json]",
    );
    return 0;
  }
  if (args.length === 1 && args[0] === "--discover") {
    render(
      success("example.discovery", discoveryData(), "Describe commands."),
      json,
      "Commands: status (inspect)",
    );
    return 0;
  }
  if (
    args[0] === "--discover-command" &&
    args[1] === "example.status" &&
    args.length === 2
  ) {
    render(
      success(
        "example.command-discovery",
        commandDiscovery(),
        "Describe example.status.",
      ),
      json,
      "example.status: success/unchanged",
    );
    return 0;
  }
  if (args.length === 1 && args[0] === "status") {
    const result = success(
      "example.status",
      { ready: true },
      "Starter is ready.",
    );
    let output: string;
    try {
      output = json ? serialize(result) : "Starter is ready.\n";
    } catch {
      return reportInternalFailure(SERIALIZATION_FAILURE_STATION, json);
    }
    try {
      emit(output);
    } catch {
      return reportInternalFailure(OUTPUT_EMISSION_FAILURE_STATION, json);
    }
    return 0;
  }
  const failure = refusal("Choose a supported command.");
  if (json) {
    process.stdout.write(`${JSON.stringify(failure)}\n`);
  } else {
    process.stderr.write("Choose a supported command. Run example --help.\n");
  }
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
