import { resolve } from "node:path";
import { CliError } from "./cli-error.ts";

export type TemplateUpgradeAction = "plan" | "apply";

export interface TemplateUpgradeOptions {
  readonly action: TemplateUpgradeAction;
  readonly repository: string;
  readonly targetRef: string;
  readonly skipCheckCommand: boolean;
  readonly json: boolean;
}

interface ParsedTemplateUpgradeFlags {
  repository?: string;
  targetRef?: string;
  skipCheckCommand: boolean;
  json: boolean;
}

type TemplateUpgradeValueFlag = "repository" | "targetRef";

const VALUE_FLAGS = new Map<string, TemplateUpgradeValueFlag>([
  ["--repository", "repository"],
  ["--to", "targetRef"],
]);

export const TEMPLATE_UPGRADE_HELP = `Carry template changes from a repository's recorded base commit to a newer template commit.

Usage:
  bun run upgrade plan --repository PATH [--to REF] [--json]
  bun run upgrade apply --repository PATH [--to REF] [--no-check] [--json]

Options:
  --repository PATH  Path to the generated repository to upgrade.
  --to REF           Target template commit or ref (default: HEAD).
  --no-check         Skip bun install and bun run check during apply.
  --json             Emit machine-readable JSON output.

Safety:
  plan writes nothing to the repository.
  apply works in .worktrees/ and publishes only by creating a branch; it never
  pushes, switches the current branch, or edits the repository's working tree.
`;

function valueAfter(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new CliError(
      "missing_flag_value",
      `${flag} requires a value`,
      `pass ${flag} VALUE`,
      2,
      true,
    );
  }
  return value;
}

function parseAction(token: string | undefined): TemplateUpgradeAction {
  if (token === "plan" || token === "apply") {
    return token;
  }
  throw new CliError(
    "unknown_subcommand",
    `unknown template upgrade subcommand: ${token ?? ""}`,
    "run bun run upgrade plan --repository PATH or bun run upgrade apply --repository PATH",
    2,
    true,
  );
}

function parseFlags(argv: readonly string[]): ParsedTemplateUpgradeFlags {
  const flags: ParsedTemplateUpgradeFlags = {
    json: false,
    skipCheckCommand: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    const valueFlag = VALUE_FLAGS.get(token);
    if (valueFlag !== undefined) {
      flags[valueFlag] = valueAfter(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--no-check") {
      flags.skipCheckCommand = true;
      continue;
    }
    throw new CliError(
      "unknown_argument",
      `unknown argument: ${token}`,
      "run bun run upgrade --help",
      2,
      true,
    );
  }
  return flags;
}

export function parseTemplateUpgradeArgs(
  argv: readonly string[],
): TemplateUpgradeOptions | "help" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }
  const action = parseAction(argv[0]);
  const flags = parseFlags(argv.slice(1));
  if (flags.repository === undefined) {
    throw new CliError(
      "missing_required_argument",
      "--repository is required",
      "pass --repository PATH to the generated repository",
      2,
      true,
    );
  }
  if (action === "plan" && flags.skipCheckCommand) {
    throw new CliError(
      "unsupported_argument",
      "--no-check is only valid with upgrade apply",
      "remove --no-check from upgrade plan, or run upgrade apply --no-check",
      2,
      true,
    );
  }
  return Object.freeze({
    action,
    repository: resolve(flags.repository),
    targetRef: flags.targetRef ?? "HEAD",
    skipCheckCommand: flags.skipCheckCommand,
    json: flags.json,
  });
}
