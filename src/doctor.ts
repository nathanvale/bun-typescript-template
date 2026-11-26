import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { resolveToolchain } from "./toolchain-resolution.ts";

export type CheckResult = {
  readonly status: "ok" | "FAIL" | "WARN";
  readonly check: string;
  readonly detail: string;
};

export type DoctorReport = {
  readonly ready: boolean;
  readonly results: readonly CheckResult[];
};

const install = "bun install --frozen-lockfile";
const kernelPinFile = "kernel-pin.json";
const installedKernelFolder = "node_modules/agent-cli-kernel";
const fullCommit = /^[0-9a-f]{40}$/;

async function pinnedBun(root: string): Promise<string | undefined> {
  try {
    const manifest = (await Bun.file(join(root, "package.json")).json()) as {
      packageManager?: unknown;
    };
    return /^bun@([^+]+)/.exec(String(manifest.packageManager))?.[1];
  } catch {
    return undefined;
  }
}

async function bunVersion(root: string): Promise<CheckResult> {
  const pinned = await pinnedBun(root);
  if (pinned === undefined)
    return {
      status: "FAIL",
      check: "bun",
      detail:
        'package.json has no toolchain pin. Repair: add "packageManager": "bun@<version>" to package.json.',
    };
  if (pinned === Bun.version)
    return {
      status: "ok",
      check: "bun",
      detail: `Bun ${Bun.version} matches the toolchain pin.`,
    };
  return {
    status: "FAIL",
    check: "bun",
    detail: `found Bun ${Bun.version}, pinned ${pinned}. Repair: run each command as mise exec bun@${pinned} -- <command>. If mise reports bun@${pinned} missing, run mise install bun@${pinned} first. In a hosted check, set bun-version: ${pinned} on setup-bun.`,
  };
}

function pinnedKernelCommit(root: string): string | undefined {
  const path = join(root, kernelPinFile);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${kernelPinFile} is not readable JSON.`);
  }
  const commit: unknown =
    typeof parsed === "object" && parsed !== null
      ? Object.getOwnPropertyDescriptor(parsed, "commit")?.value
      : undefined;
  if (typeof commit !== "string" || !fullCommit.test(commit))
    throw new Error(`${kernelPinFile} has no valid full commit.`);
  return commit;
}

function installedKernelProblem(root: string): string | undefined {
  const pinnedCommit = pinnedKernelCommit(root);
  if (pinnedCommit === undefined) return undefined;
  const kernelDirectory = join(root, installedKernelFolder);
  if (!existsSync(kernelDirectory))
    return `${installedKernelFolder} is missing.`;
  const tagFile = join(kernelDirectory, ".bun-tag");
  const tag = existsSync(tagFile)
    ? readFileSync(tagFile, "utf8").trim()
    : undefined;
  const installedCommit = /([0-9a-f]{7,40})$/.exec(tag ?? "")?.[1];
  if (
    installedCommit === undefined ||
    !pinnedCommit.startsWith(installedCommit)
  )
    return `${installedKernelFolder} is at ${tag ?? "no tag"}, and ${kernelPinFile} pins ${pinnedCommit}.`;
  return undefined;
}

function toolchain(root: string): CheckResult {
  if (!existsSync(join(root, "node_modules")))
    return {
      status: "FAIL",
      check: "toolchain",
      detail: `node_modules is missing. Repair: ${install}.`,
    };
  try {
    resolveToolchain(root);
    const kernelProblem = installedKernelProblem(root);
    if (kernelProblem !== undefined)
      return {
        status: "FAIL",
        check: "toolchain",
        detail: `${kernelProblem} Repair: ${install}.`,
      };
    return {
      status: "ok",
      check: "toolchain",
      detail:
        "node_modules resolves the accepted lint, compiler and semantic backends.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.split("\n")[0]?.replace(/\.?$/, ".");
    return {
      status: "FAIL",
      check: "toolchain",
      detail: `${reason} Repair: ${install}.`,
    };
  }
}

export type FallowCheck = {
  id: string;
  status: string;
  message: string;
  repair: string | undefined;
};

export type FallowReport = { status: string; checks: FallowCheck[] };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function fallowCheck(value: unknown): FallowCheck | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = text(Reflect.get(value, "id"));
  const status = text(Reflect.get(value, "status"));
  const message = text(Reflect.get(value, "message"));
  if (id === undefined || status === undefined || message === undefined)
    return undefined;
  const remediation: unknown = Reflect.get(value, "remediation");
  const repair =
    typeof remediation === "object" && remediation !== null
      ? text(Reflect.get(remediation, "command"))
      : undefined;
  return { id, status, message, repair };
}

export function fallowReport(output: string): FallowReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const status = text(Reflect.get(parsed, "status"));
  const listed: unknown = Reflect.get(parsed, "checks");
  if (status === undefined || !Array.isArray(listed)) return undefined;
  const checks = listed.map(fallowCheck);
  if (checks.some((check) => check === undefined)) return undefined;
  return { status, checks: checks.filter((check) => check !== undefined) };
}

export function fallowReadiness(root: string): CheckResult {
  const fallow = join(root, "node_modules/.bin/fallow");
  if (!existsSync(fallow))
    return {
      status: "FAIL",
      check: "fallow",
      detail: `node_modules/.bin/fallow is missing. Repair: ${install}.`,
    };
  const result = Bun.spawnSync(
    [fallow, "doctor", "--format", "json", "--quiet"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const report = fallowReport(result.stdout.toString());
  if (report === undefined)
    return {
      status: "FAIL",
      check: "fallow",
      detail: `fallow doctor exited ${result.exitCode} without a readiness report. Repair: ${install}, then run node_modules/.bin/fallow doctor to read its error.`,
    };
  if (report.status === "pass")
    return {
      status: "ok",
      check: "fallow",
      detail: "fallow doctor passes.",
    };
  const flagged =
    report.checks.find((check) => check.status === "fail") ??
    report.checks.find((check) => check.status === "warn");
  const message = flagged
    ? `${flagged.id}: ${flagged.message.replace(/\.?$/, ".")}`
    : `fallow doctor reported ${report.status}.`;
  const repair = flagged?.repair
    ? ` Repair: run ${flagged.repair} from the repository root.`
    : " Repair: run node_modules/.bin/fallow doctor for the details.";
  return {
    status: report.status === "fail" ? "FAIL" : "WARN",
    check: "fallow",
    detail: `${message}${repair}`,
  };
}

function hostLoad(): CheckResult {
  const load = loadavg()[0] ?? 0;
  const cores = availableParallelism();
  const summary = `one-minute load ${load.toFixed(1)} on ${cores} cores`;
  if (load > cores)
    return {
      status: "WARN",
      check: "load",
      detail: `${summary}. Repair: run the full suite and timing-sensitive cases where AGENTS.md (Checks) says.`,
    };
  return { status: "ok", check: "load", detail: `${summary}.` };
}

export async function doctor(root: string): Promise<DoctorReport> {
  const installed = toolchain(root);
  const results = [
    await bunVersion(root),
    installed,
    ...(installed.status === "ok" ? [fallowReadiness(root)] : []),
    hostLoad(),
  ];
  return {
    ready: results.every((result) => result.status !== "FAIL"),
    results,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.results.map(
    ({ status, check, detail }) => `${status} ${check}: ${detail}\n`,
  );
  if (!report.ready) lines.push("Done when bun run doctor passes.\n");
  return lines.join("");
}
