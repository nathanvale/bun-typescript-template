import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  parseTemplateUpgradeArgs,
  TEMPLATE_UPGRADE_HELP,
} from "../../../src/template-upgrade-arguments.ts";

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected parseTemplateUpgradeArgs to throw a CliError.");
}

test("returns help for empty arguments, --help, and -h", () => {
  expect(parseTemplateUpgradeArgs([])).toBe("help");
  expect(parseTemplateUpgradeArgs(["--help"])).toBe("help");
  expect(parseTemplateUpgradeArgs(["plan", "-h"])).toBe("help");
  expect(TEMPLATE_UPGRADE_HELP).toContain(
    "bun run upgrade plan --repository PATH [--to REF] [--json]",
  );
  expect(TEMPLATE_UPGRADE_HELP).toContain(
    "bun run upgrade apply --repository PATH [--to REF] [--no-check] [--json]",
  );
});

test("parses plan and apply options with defaults and overrides", () => {
  expect(
    parseTemplateUpgradeArgs(["plan", "--repository", "demo-repo"]),
  ).toEqual({
    action: "plan",
    repository: resolve("demo-repo"),
    targetRef: "HEAD",
    skipCheckCommand: false,
    json: false,
  });
  expect(
    parseTemplateUpgradeArgs([
      "apply",
      "--repository",
      "demo-repo",
      "--to",
      "origin/main",
      "--no-check",
      "--json",
    ]),
  ).toEqual({
    action: "apply",
    repository: resolve("demo-repo"),
    targetRef: "origin/main",
    skipCheckCommand: true,
    json: true,
  });
});

test("refuses an unknown subcommand", () => {
  const error = captureCliError(() =>
    parseTemplateUpgradeArgs(["status", "--repository", "demo"]),
  );
  expect({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    retrySafe: error.retrySafe,
  }).toEqual({
    code: "unknown_subcommand",
    message: "unknown template upgrade subcommand: status",
    exitCode: 2,
    retrySafe: true,
  });
});

test("refuses missing --repository", () => {
  const error = captureCliError(() =>
    parseTemplateUpgradeArgs(["plan", "--json"]),
  );
  expect({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
  }).toEqual({
    code: "missing_required_argument",
    message: "--repository is required",
    exitCode: 2,
  });
});

test("refuses missing values for --repository and --to", () => {
  const missingRepo = captureCliError(() =>
    parseTemplateUpgradeArgs(["plan", "--repository"]),
  );
  expect({
    code: missingRepo.code,
    message: missingRepo.message,
    exitCode: missingRepo.exitCode,
  }).toEqual({
    code: "missing_flag_value",
    message: "--repository requires a value",
    exitCode: 2,
  });

  const missingTo = captureCliError(() =>
    parseTemplateUpgradeArgs([
      "plan",
      "--repository",
      "demo",
      "--to",
      "--json",
    ]),
  );
  expect({
    code: missingTo.code,
    message: missingTo.message,
    exitCode: missingTo.exitCode,
  }).toEqual({
    code: "missing_flag_value",
    message: "--to requires a value",
    exitCode: 2,
  });
});

test("refuses --no-check on plan and unknown arguments", () => {
  const noCheck = captureCliError(() =>
    parseTemplateUpgradeArgs(["plan", "--repository", "demo", "--no-check"]),
  );
  expect({
    code: noCheck.code,
    message: noCheck.message,
    exitCode: noCheck.exitCode,
  }).toEqual({
    code: "unsupported_argument",
    message: "--no-check is only valid with upgrade apply",
    exitCode: 2,
  });

  const unknown = captureCliError(() =>
    parseTemplateUpgradeArgs([
      "apply",
      "--repository",
      "demo",
      "--allow-major",
    ]),
  );
  expect({
    code: unknown.code,
    message: unknown.message,
    exitCode: unknown.exitCode,
  }).toEqual({
    code: "unknown_argument",
    message: "unknown argument: --allow-major",
    exitCode: 2,
  });
});
