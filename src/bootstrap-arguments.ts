import { basename, isAbsolute, resolve } from "node:path";
import { CliError, RUNTIME_FAILURE_REPAIR } from "./cli-error.ts";

export interface BootstrapOptions {
  destination: string;
  json: boolean;
  name: string;
  sourcePacket: string;
}

interface ParsedFlags {
  destination?: string;
  json: boolean;
  name?: string;
  sourcePacket?: string;
}

type ValueFlag = "destination" | "name" | "sourcePacket";

export const HELP = `Create a Bun TypeScript repository with the kernel at the template's Pin.

Usage:
  bun run bootstrap --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]

The generated repository names the kernel by the template's Pin, and gets the
kernel lockfile and a pointer skill for each kernel skill. Bootstrap reads the
kernel repository beside the template, or at KERNEL_REPOSITORY.

Safety:
  An existing non-empty destination is refused and never overwritten.
`;

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
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

function tokenAt(argv: string[], index: number): string {
  const token = argv[index];
  if (token === undefined) {
    throw new CliError(
      "runtime_failure",
      "argument parser reached an invalid position",
      RUNTIME_FAILURE_REPAIR,
      1,
      false,
    );
  }
  return token;
}

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--destination": "destination",
  "--name": "name",
  "--source-packet": "sourcePacket",
};

function assignValueFlag(
  flags: ParsedFlags,
  flag: ValueFlag,
  value: string,
): void {
  flags[flag] = value;
}

function assignBooleanFlag(flags: ParsedFlags, token: string): boolean {
  if (token === "--json") {
    flags.json = true;
    return true;
  }
  return false;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = tokenAt(argv, index);
    const valueFlag = VALUE_FLAGS[token];
    if (valueFlag !== undefined) {
      assignValueFlag(flags, valueFlag, valueAfter(argv, index, token));
      index += 1;
      continue;
    }
    if (assignBooleanFlag(flags, token)) {
      continue;
    }
    throw new CliError(
      "unknown_argument",
      `unknown argument: ${token}`,
      "run bun run bootstrap --help",
      2,
      true,
    );
  }
  return flags;
}

function requireFlag(value: string | undefined): string {
  if (value === undefined) {
    throw new CliError(
      "missing_required_argument",
      "--destination and --source-packet are required",
      "run bun run bootstrap --help",
      2,
      true,
    );
  }
  return value;
}

export function resolveRepositoryName(
  destination: string,
  name?: string,
): string {
  const resolvedDestination = resolve(destination);
  const repositoryName = name ?? basename(resolvedDestination);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(repositoryName)) {
    throw new CliError(
      "invalid_repository_name",
      `invalid repository name: ${repositoryName}`,
      "pass a lowercase npm-compatible --name",
      2,
      true,
    );
  }
  return repositoryName;
}

function isHttpUrlWithoutUserInfoOrQuery(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      [parsed.username, parsed.password, parsed.search].every(
        (component) => component === "",
      )
    );
  } catch {
    return false;
  }
}

function isHttpUrlWithUserInfoOrQuery(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      [parsed.username, parsed.password, parsed.search].some(
        (component) => component !== "",
      )
    );
  } catch {
    return false;
  }
}

function isSupportedSourcePacket(sourcePacket: string): boolean {
  return (
    isAbsolute(sourcePacket) || isHttpUrlWithoutUserInfoOrQuery(sourcePacket)
  );
}

function hasUnsafeSourcePacketCharacters(sourcePacket: string): boolean {
  return ["\n", "\r", "`"].some((character) =>
    sourcePacket.includes(character),
  );
}

function invalidSourcePacket(): CliError {
  return new CliError(
    "invalid_source_packet",
    "source packet must be an absolute path or HTTP(S) URL",
    "pass --source-packet an absolute path or an HTTP(S) URL",
    2,
    true,
  );
}

function invalidSourcePacketWithUserInfoOrQuery(): CliError {
  return new CliError(
    "invalid_source_packet",
    "HTTP(S) source packet URLs must not contain username, password, or query data",
    "remove username, password, or query data, or use an absolute local packet path",
    2,
    true,
  );
}

export function validateSourcePacket(sourcePacket: string): void {
  if (hasUnsafeSourcePacketCharacters(sourcePacket)) {
    throw invalidSourcePacket();
  }
  if (isSupportedSourcePacket(sourcePacket)) {
    return;
  }
  if (isHttpUrlWithUserInfoOrQuery(sourcePacket)) {
    throw invalidSourcePacketWithUserInfoOrQuery();
  }
  throw invalidSourcePacket();
}

export function parseArgs(argv: string[]): BootstrapOptions | "help" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }

  const flags = parseFlags(argv);
  const destination = requireFlag(flags.destination);
  const sourcePacket = requireFlag(flags.sourcePacket);
  validateSourcePacket(sourcePacket);

  return {
    destination: resolve(destination),
    json: flags.json,
    name: resolveRepositoryName(destination, flags.name),
    sourcePacket,
  };
}
