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
    ],
  };
}

function hasJson(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  return options.includes("--json");
}

function render(value: unknown, json: boolean, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human}\n`);
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
    render(
      success("example.status", { ready: true }, "Starter is ready."),
      json,
      "Starter is ready.",
    );
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
