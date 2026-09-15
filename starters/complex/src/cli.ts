import { resolve } from "node:path";
import { stationsFor } from "./branch-station-catalog.ts";
import { envelope } from "./command-contract.ts";
import { recordDiagnostic } from "./diagnostics.ts";
import {
  completed,
  inspected,
  invalidInput,
  previewed,
  validateSetInput,
} from "./engine.ts";
import { inspectState, setState } from "./runtime.ts";

const COMMANDS = [
  {
    commandIdentity: "example.status",
    effectClass: "inspect",
    route: ["status"],
    summary: "Inspect current state.",
  },
  {
    commandIdentity: "example.set",
    effectClass: "repository-local",
    route: ["set"],
    summary: "Preview or apply a local state change.",
  },
] as const;

function hasJson(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  return (separator === -1 ? argv : argv.slice(0, separator)).includes(
    "--json",
  );
}

function statePath(): string {
  return resolve(process.env.CLI_EXAMPLE_STATE ?? "example-state.json");
}

function writeResult(result: ReturnType<typeof envelope>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const line = `${result.message}\n`;
  if (result.result.outcome === "success") {
    process.stdout.write(line);
  } else {
    process.stderr.write(line);
  }
}

function discoveryData() {
  return {
    commands: COMMANDS,
    contractVersion: "2.0.0",
    effectExclusions: [
      "Template generation and diagnostics are not domain effects.",
    ],
    exitMeanings: {
      "0": "success",
      "1": "internal",
      "2": "usage",
      "3": "domain",
      "4": "schema",
      "75": "transient",
    },
    generationConventionVersion: "2.0.0",
    profile: "complex",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  };
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    const result = inspected(await inspectState(statePath()));
    result.commandIdentity = "example.help";
    result.data = {
      commands: COMMANDS,
      options: [],
      summary: "Complex example CLI.",
      usage: "example status | set --value VALUE [--preview]",
    };
    result.message = "Show help.";
    writeResult(envelope(result), json);
    return 0;
  }
  if (args.length === 1 && args[0] === "--discover") {
    const result = inspected(await inspectState(statePath()));
    result.commandIdentity = "example.discovery";
    result.data = discoveryData();
    result.message = "Describe commands.";
    writeResult(envelope(result), json);
    return 0;
  }
  if (args[0] === "--discover-command" && args.length === 2) {
    const command = COMMANDS.find(
      (candidate) => candidate.commandIdentity === args[1],
    );
    if (command !== undefined) {
      const result = inspected(await inspectState(statePath()));
      result.commandIdentity = "example.command-discovery";
      result.data = {
        command,
        semantics: "possible-outcomes",
        stations: stationsFor(command.commandIdentity),
      };
      result.message = `Describe ${command.commandIdentity}.`;
      writeResult(envelope(result), json);
      return 0;
    }
  }
  if (args.length === 1 && args[0] === "status") {
    await recordDiagnostic("example.status");
    const result = inspected(await inspectState(statePath()));
    writeResult(envelope(result), json);
    return result.exitCode;
  }
  if (args[0] === "set") {
    const valueIndex = args.indexOf("--value");
    const value = valueIndex === -1 ? "" : (args[valueIndex + 1] ?? "");
    const preview = args.includes("--preview");
    const parsed = validateSetInput(value, preview);
    if (!parsed.success) {
      const result = invalidInput("The set value is invalid.");
      writeResult(envelope(result), json);
      return result.exitCode;
    }
    await recordDiagnostic("example.set");
    const result = parsed.data.preview
      ? previewed(parsed.data.value)
      : completed(
          parsed.data.value,
          await setState(statePath(), parsed.data.value),
        );
    writeResult(envelope(result), json);
    return result.exitCode;
  }
  const result = invalidInput("Choose status or set --value VALUE.");
  result.commandIdentity = "example.dispatch";
  result.causeCode = "USAGE_INVALID_INVOCATION";
  result.exitCode = 2;
  result.failureClass = "usage";
  writeResult(envelope(result), json);
  return result.exitCode;
}

process.exitCode = await main(process.argv.slice(2));
