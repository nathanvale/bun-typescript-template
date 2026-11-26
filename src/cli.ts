import { existsSync } from "node:fs";
import { join } from "node:path";
import { doctor, formatDoctorReport } from "./doctor.ts";

const cliName = "bun-typescript-template";
const doctorIdentity = `${cliName}.doctor` as const;
const root = join(import.meta.dir, "..");
const installRepair = "bun install --frozen-lockfile";

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

export function jsonOutput(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--json") return true;
  }
  return false;
}

async function loadKernel() {
  if (!existsSync(join(root, "node_modules", "agent-cli-kernel")))
    return undefined;
  const [kernel, diagnostics, causes] = await Promise.all([
    import("agent-cli-kernel"),
    import("agent-cli-kernel/addons/diagnostics"),
    import("./causes.ts"),
  ]);
  return { kernel, diagnostics, causes };
}

async function runFrontDoor(argv: readonly string[]): Promise<void> {
  const loaded = await loadKernel();
  if (loaded === undefined) {
    process.stderr.write(
      `${cliName}: node_modules/agent-cli-kernel is missing. Repair: ${installRepair}.\n`,
    );
    process.exit(1);
  }

  const {
    kernel: { command, contractFor, runProcess, station },
    diagnostics: { diagnosticsAddon },
    causes: { cliCauses },
  } = loaded;

  const machineOutput = jsonOutput(argv);

  const doctorCommand = command({
    identity: doctorIdentity,
    route: ["doctor"],
    summary:
      "Check that this checkout can run the check command and gates, and name a repair for each failure.",
    input: noInput,
    capabilities: { diagnostics: true },
    stations: [
      station(cliCauses, {
        commandIdentity: doctorIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Every readiness check passed.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        retryDelayPolicy: { kind: "none" },
        reachability: "required",
        unreachableRationale: null,
        independentObservable: `${doctorIdentity}:ready`,
      }),
      station(cliCauses, {
        commandIdentity: doctorIdentity,
        causeCode: "DOMAIN_DOCTOR_CHECK_FAILED",
        trigger: "At least one readiness check failed.",
        repairAction:
          "Apply each failed check's repair, then run bun run doctor again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Apply each failed check's repair, then run bun run doctor again.",
          },
        },
        retryDelayPolicy: { kind: "none" },
        reachability: "required",
        unreachableRationale: null,
        independentObservable: `${doctorIdentity}:check-failed`,
      }),
    ],
    run: async (_input, context) => {
      const report = await doctor(root);
      const results = report.results.map((result) => ({ ...result }));
      if (report.ready) {
        context.diagnostics.record(
          "doctor.ready",
          { ready: true, resultCount: results.length },
          "info",
        );
        if (!machineOutput) process.stdout.write(formatDoctorReport(report));
        return context.result(
          { commandIdentity: doctorIdentity, causeCode: "SUCCESS_UNCHANGED" },
          {
            message: "Checkout is ready.",
            data: { ready: true, results },
            effects: noEffects,
          },
        );
      }
      const failing = results.filter((result) => result.status === "FAIL");
      context.diagnostics.record(
        "doctor.check-failed",
        {
          ready: false,
          failedChecks: failing.map((result) => result.check),
        },
        "warning",
      );
      if (!machineOutput) process.stdout.write(formatDoctorReport(report));
      const summary = failing
        .map((result) => `${result.check}: ${result.detail}`)
        .join(" ");
      return context.result(
        {
          commandIdentity: doctorIdentity,
          causeCode: "DOMAIN_DOCTOR_CHECK_FAILED",
        },
        {
          message: summary,
          data: { ready: false, results },
          effects: noEffects,
        },
      );
    },
  });

  const contract = contractFor({
    cli: cliName,
    commands: [doctorCommand] as const,
    causes: cliCauses,
    installedAddons: ["diagnostics"],
  });

  await runProcess(contract, {
    addons: {
      diagnostics: diagnosticsAddon({
        cli: cliName,
        environment: process.env,
        argv,
      }),
    },
  })(argv);
}

if (import.meta.main) await runFrontDoor(process.argv.slice(2));
