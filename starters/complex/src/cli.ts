import { resolve } from "node:path";
import { stationsFor } from "./branch-station-catalog.ts";
import { envelope } from "./command-contract.ts";
import { recordDiagnostic } from "./diagnostics.ts";
import {
  completed,
  inspected,
  invalidInput,
  previewed,
  recovered,
  validateSetInput,
} from "./engine.ts";
import { systemProcessLifecycle } from "./process-lifecycle.ts";
import { inspectRecovery, inspectState, setState } from "./runtime.ts";

const lifecycle = systemProcessLifecycle();
process.on("SIGINT", () => lifecycle.terminate(130));
process.on("SIGTERM", () => lifecycle.terminate(143));

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
  {
    commandIdentity: "example.recover",
    effectClass: "inspect",
    route: ["recover"],
    summary: "Inspect an interrupted state change without replaying it.",
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

async function waitForLifecycleTest(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const milliseconds = Number(process.env.CLI_EXAMPLE_TEST_DELAY_MS ?? "0");
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
    await Bun.sleep(milliseconds);
  }
}

function writeResult(result: ReturnType<typeof envelope>, json: boolean): void {
  if (json) {
    lifecycle.stdout(`${JSON.stringify(result)}\n`);
    return;
  }
  const line = `${result.message}\n`;
  if (result.result.outcome === "success") {
    lifecycle.stdout(line);
  } else {
    lifecycle.stderr(line);
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
    await waitForLifecycleTest();
    const result = inspected(await inspectState(statePath()));
    writeResult(envelope(result), json);
    return result.exitCode;
  }
  if (args.length === 1 && args[0] === "recover") {
    await recordDiagnostic("example.recover");
    const result = recovered(await inspectRecovery(statePath()));
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

await lifecycle.complete(await main(process.argv.slice(2)));
