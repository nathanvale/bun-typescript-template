import { basename, isAbsolute, resolve } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  PROFILES,
  type Profile,
  type ProjectRecipe,
  STARTERS,
  type Starter,
  selectRecipe,
} from "./recipe.ts";

export interface BootstrapOptions {
  destination: string;
  json: boolean;
  name: string;
  recipe: ProjectRecipe;
  sourcePacket: string;
  kernelPin?: string;
  kernelCommit?: string;
  lockfile?: Uint8Array | undefined;
}

interface ParsedFlags {
  destination?: string;
  json: boolean;
  monorepo: boolean;
  name?: string;
  profile?: Profile;
  sourcePacket?: string;
  starter?: Starter;
}

type ValueFlag =
  | "destination"
  | "name"
  | "profile"
  | "sourcePacket"
  | "starter";

export const RUNTIME_FAILURE_REPAIR =
  "correct what the message names, then rerun the same command";

export const HELP = `Create a Bun TypeScript repository from an explicit profile.

Usage:
  bun run bootstrap --profile scratch --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]
  bun run bootstrap --profile durable --destination PATH --source-packet PATH_OR_URL [--name NAME] [--monorepo] [--json]
  bun run bootstrap --profile durable --starter simple --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]
  bun run bootstrap --profile durable --starter complex --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]

Profiles:
  scratch  Dump-and-run repository with only run, typecheck, and test essentials.
  durable  Maintained repository with typed ESLint, Biome formatting, native Fallow and one check command.

CLI starters:
  simple   Read-only CLI with Contract Core 2.0 help and discovery.
  complex  State-changing CLI with typed contracts and Branch Stations.

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

function parseWord<T extends string>(
  words: readonly T[],
  flag: "profile" | "starter",
  value: string,
): T {
  const word = words.find((candidate) => candidate === value);
  if (word !== undefined) {
    return word;
  }
  throw new CliError(
    `invalid_${flag}`,
    `unsupported ${flag}: ${value}`,
    `choose ${words.map((candidate) => `--${flag} ${candidate}`).join(" or ")}`,
    2,
    true,
  );
}

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--destination": "destination",
  "--name": "name",
  "--profile": "profile",
  "--source-packet": "sourcePacket",
  "--starter": "starter",
};

function assignValueFlag(
  flags: ParsedFlags,
  flag: ValueFlag,
  value: string,
): void {
  if (flag === "profile") {
    flags.profile = parseWord(PROFILES, "profile", value);
    return;
  }
  if (flag === "starter") {
    flags.starter = parseWord(STARTERS, "starter", value);
    return;
  }
  flags[flag] = value;
}

function assignBooleanFlag(flags: ParsedFlags, token: string): boolean {
  if (token === "--monorepo") {
    flags.monorepo = true;
    return true;
  }
  if (token === "--json") {
    flags.json = true;
    return true;
  }
  return false;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { json: false, monorepo: false };

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
      "--profile, --destination, and --source-packet are required",
      "run bun run bootstrap --help",
      2,
      true,
    );
  }
  return value;
}

function selectProjectRecipe(
  profile: Profile,
  flags: ParsedFlags,
): ProjectRecipe {
  const choice = selectRecipe({
    profile,
    monorepo: flags.monorepo,
    starter: flags.starter,
  });
  if (choice.status === "selected") {
    return choice.recipe;
  }
  throw new CliError(
    "profile_option_mismatch",
    choice.message,
    choice.repair,
    2,
    true,
  );
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
  const profile = parseWord(PROFILES, "profile", requireFlag(flags.profile));
  const destination = requireFlag(flags.destination);
  const sourcePacket = requireFlag(flags.sourcePacket);
  const recipe = selectProjectRecipe(profile, flags);
  validateSourcePacket(sourcePacket);

  return {
    destination: resolve(destination),
    json: flags.json,
    name: resolveRepositoryName(destination, flags.name),
    recipe,
    sourcePacket,
  };
}
