import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const TEMPLATE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NAME_TOKEN = "__REPOSITORY_NAME__";
const PACKET_TOKEN = "__SOURCE_PACKET__";

type Profile = "scratch" | "durable";

interface BootstrapOptions {
  destination: string;
  json: boolean;
  monorepo: boolean;
  name: string;
  profile: Profile;
  sourcePacket: string;
}

interface ParsedFlags {
  destination?: string;
  json: boolean;
  monorepo: boolean;
  name?: string;
  profile?: Profile;
  sourcePacket?: string;
}

type ValueFlag = "destination" | "name" | "profile" | "sourcePacket";

interface BootstrapResult {
  destination: string;
  generatedFiles: number;
  profile: Profile;
  runId: string;
  schemaVersion: number;
  sourcePacket: string;
  status: "created";
  variant: "single-package" | "monorepo";
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repair: string,
    readonly exitCode: number,
    readonly retrySafe: boolean,
  ) {
    super(message);
  }
}

const HELP = `Create a Bun TypeScript repository from an explicit profile.

Usage:
  bun run bootstrap --profile scratch --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]
  bun run bootstrap --profile durable --destination PATH --source-packet PATH_OR_URL [--name NAME] [--monorepo] [--json]

Profiles:
  scratch  Dump-and-run repository with only run, typecheck, and test essentials.
  durable  Maintained repository with Biome, native Fallow, and uniform checks.

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
      "retry the same command after repairing the template checkout",
      1,
      false,
    );
  }
  return token;
}

function parseProfile(value: string): Profile {
  if (value === "scratch" || value === "durable") {
    return value;
  }
  throw new CliError(
    "invalid_profile",
    `unsupported profile: ${value}`,
    "choose --profile scratch or --profile durable",
    2,
    true,
  );
}

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--destination": "destination",
  "--name": "name",
  "--profile": "profile",
  "--source-packet": "sourcePacket",
};

function assignValueFlag(
  flags: ParsedFlags,
  flag: ValueFlag,
  value: string,
): void {
  if (flag === "profile") {
    flags.profile = parseProfile(value);
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

function validateProfileOptions(profile: Profile, monorepo: boolean): void {
  if (monorepo && profile !== "durable") {
    throw new CliError(
      "profile_option_mismatch",
      "--monorepo is available only with --profile durable",
      "remove --monorepo or choose --profile durable",
      2,
      true,
    );
  }
}

function resolveRepositoryName(destination: string, name?: string): string {
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

function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isSupportedSourcePacket(sourcePacket: string): boolean {
  return isAbsolute(sourcePacket) || isWebUrl(sourcePacket);
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
    "pass a portable project-packet URL or an absolute local packet path",
    2,
    true,
  );
}

function validateSourcePacket(sourcePacket: string): void {
  if (!isSupportedSourcePacket(sourcePacket)) {
    throw invalidSourcePacket();
  }
  if (hasUnsafeSourcePacketCharacters(sourcePacket)) {
    throw invalidSourcePacket();
  }
}

function parseArgs(argv: string[]): BootstrapOptions | "help" {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }

  const flags = parseFlags(argv);
  const profile = parseProfile(requireFlag(flags.profile));
  const destination = requireFlag(flags.destination);
  const sourcePacket = requireFlag(flags.sourcePacket);
  validateProfileOptions(profile, flags.monorepo);
  validateSourcePacket(sourcePacket);

  return {
    destination: resolve(destination),
    json: flags.json,
    monorepo: flags.monorepo,
    name: resolveRepositoryName(destination, flags.name),
    profile,
    sourcePacket,
  };
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isInsideTemplate(destination: string): boolean {
  const fromTemplate = relative(TEMPLATE_ROOT, destination);
  return (
    fromTemplate === "" ||
    (!fromTemplate.startsWith("..") && !isAbsolute(fromTemplate))
  );
}

function destinationRefusal(message: string): CliError {
  return new CliError(
    "destination_not_empty",
    message,
    "choose a new or empty directory; existing bytes were preserved",
    3,
    true,
  );
}

function requireOrdinaryDirectory(
  stats: Awaited<ReturnType<typeof lstat>>,
): void {
  if (!stats.isDirectory()) {
    throw destinationRefusal(
      "destination already exists and is not an empty directory",
    );
  }
  if (stats.isSymbolicLink()) {
    throw destinationRefusal(
      "destination already exists and is not an empty directory",
    );
  }
}

async function validateDestination(
  destination: string,
): Promise<"absent" | "empty"> {
  if (isInsideTemplate(destination)) {
    throw new CliError(
      "destination_inside_template",
      "destination must be outside the template repository",
      "choose a fresh destination outside this checkout",
      3,
      true,
    );
  }

  const stats = await lstatIfPresent(destination);
  if (stats === undefined) {
    return "absent";
  }
  requireOrdinaryDirectory(stats);
  if ((await readdir(destination)).length > 0) {
    throw destinationRefusal("destination already contains files");
  }
  return "empty";
}

async function copyDirectoryContents(
  source: string,
  destination: string,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "TEMPLATE-SOURCE.md") {
      continue;
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      errorOnExist: true,
      force: false,
      recursive: entry.isDirectory(),
    });
  }
}

async function substituteTokens(
  root: string,
  options: BootstrapOptions,
): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await substituteTokens(path, options);
      continue;
    }
    if (!entry.isFile()) {
      throw new CliError(
        "unsupported_template_entry",
        `template entry is not a regular file: ${relative(root, path)}`,
        "replace the entry with a regular file",
        1,
        false,
      );
    }
    const current = await readFile(path, "utf8");
    const rendered = current
      .replaceAll(NAME_TOKEN, options.name)
      .replaceAll(PACKET_TOKEN, options.sourcePacket);
    await writeFile(path, rendered, "utf8");
    count += 1;
  }
  return count;
}

function selectedProfileSource(options: BootstrapOptions): string {
  if (options.profile === "scratch") {
    return join(TEMPLATE_ROOT, "profiles", "scratch");
  }
  if (options.monorepo) {
    return join(TEMPLATE_ROOT, "examples", "monorepo");
  }
  return join(TEMPLATE_ROOT, "profiles", "durable");
}

async function requireProfileSource(source: string): Promise<void> {
  if ((await lstatIfPresent(source)) !== undefined) {
    return;
  }
  throw new CliError(
    "profile_source_missing",
    `profile source is missing: ${relative(TEMPLATE_ROOT, source)}`,
    "restore the selected profile in the template repository",
    1,
    false,
  );
}

async function installStaging(
  staging: string,
  destination: string,
  destinationState: "absent" | "empty",
): Promise<void> {
  if (destinationState === "empty") {
    await rmdir(destination);
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (destinationState === "empty") {
      await mkdir(destination);
    }
    throw error;
  }
}

async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const destinationState = await validateDestination(options.destination);
  const variant = options.monorepo ? "monorepo" : "single-package";
  const source = selectedProfileSource(options);
  await requireProfileSource(source);

  await mkdir(dirname(options.destination), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(options.destination), ".repo-bootstrap-"),
  );
  try {
    await copyDirectoryContents(source, staging);
    const generatedFiles = await substituteTokens(staging, options);
    await installStaging(staging, options.destination, destinationState);
    return {
      destination: options.destination,
      generatedFiles,
      profile: options.profile,
      runId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      sourcePacket: options.sourcePacket,
      status: "created",
      variant,
    };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

function writeError(error: unknown, json: boolean): number {
  const failure =
    error instanceof CliError
      ? error
      : new CliError(
          "runtime_failure",
          error instanceof Error ? error.message : "unexpected runtime failure",
          "inspect the template checkout and retry with the same inputs after repair",
          1,
          false,
        );
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    status: "refused",
    error: {
      code: failure.code,
      message: failure.message,
      repair: failure.repair,
      retrySafe: failure.retrySafe,
    },
  };
  process.stderr.write(
    json
      ? `${JSON.stringify(envelope)}\n`
      : `${failure.message}\nRepair: ${failure.repair}\n`,
  );
  return failure.exitCode;
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    if (options === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    const result = await bootstrap(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Created ${result.profile} ${result.variant} repository at ${result.destination}\n`,
    );
    return 0;
  } catch (error) {
    return writeError(error, json);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
