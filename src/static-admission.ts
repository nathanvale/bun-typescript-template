import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

type Document = Record<string, unknown>;
type Profile = "simple" | "complex";
interface Options {
  project: string;
  profile: Profile;
  evidence: string;
}
interface Receipt {
  name: string;
  argv: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

class Refusal extends Error {
  constructor(readonly causeCode: string) {
    super(causeCode);
  }
}

function requireValue(condition: unknown, cause: string): asserts condition {
  if (!condition) throw new Refusal(cause);
}

function document(value: unknown, cause: string): Document {
  requireValue(value !== null && typeof value === "object", cause);
  requireValue(!Array.isArray(value), cause);
  return value as Document;
}

function parseOptions(): Options {
  const [project, profile, evidence, ...extra] = process.argv.slice(2);
  requireValue(project && evidence && extra.length === 0, "usage");
  requireValue(profile === "simple" || profile === "complex", "usage:profile");
  return { project: resolve(project), profile, evidence: resolve(evidence) };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function jsonFile(path: string): Promise<Document> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throwFileReadError(error, path);
  }
  return document(Bun.JSONC.parse(text), `json:${path}`);
}

function throwFileReadError(error: unknown, path: string): never {
  if (!(error instanceof Error)) throw error;
  if (!("code" in error)) throw error;
  if (error.code === "ENOENT") {
    throw new Refusal(`file:missing:${basename(path)}`);
  }
  throw error;
}

function compare(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    requireValue(JSON.stringify(actual) === JSON.stringify(expected), path);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    compareDocument(document(actual, path), document(expected, path), path);
    return;
  }
  requireValue(actual === expected, path);
}

function compareDocument(left: Document, right: Document, path: string): void {
  for (const key of Object.keys(right).sort()) {
    compare(left[key], right[key], `${path}.${key}`);
  }
  for (const key of Object.keys(left).sort()) {
    requireValue(Object.hasOwn(right, key), `${path}.${key}`);
  }
}

async function visitDirectory(
  root: string,
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".fallow"].includes(entry.name)) continue;
    await inventoryEntry(root, join(directory, entry.name), entry, files);
  }
}

async function inventoryEntry(
  root: string,
  path: string,
  entry: Dirent,
  files: Record<string, string>,
): Promise<void> {
  requireValue(
    !entry.isSymbolicLink(),
    `scope:symlink:${relative(root, path)}`,
  );
  if (entry.isDirectory()) await visitDirectory(root, path, files);
  if (entry.isFile())
    files[relative(root, path)] = digest(await readFile(path));
}

async function inventory(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await visitDirectory(root, root, files);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function checkPolicy(options: Options): Promise<Document> {
  const packet = resolve(
    import.meta.dir,
    "../profiles/static-admission",
    options.profile,
  );
  const actual = await jsonFile(join(options.project, "package.json"));
  const expected = await jsonFile(join(packet, "package.json"));
  for (const key of [
    "packageManager",
    "private",
    "type",
    "scripts",
    "dependencies",
    "devDependencies",
  ]) {
    compare(actual[key], expected[key], `policy:package.json.${key}`);
  }
  for (const file of [
    "tsconfig.base.json",
    "tsconfig.json",
    "biome.json",
    ".fallowrc.json",
  ]) {
    compare(
      await jsonFile(join(options.project, file)),
      await jsonFile(join(packet, file)),
      `policy:${file}`,
    );
  }
  for (const file of [".gitignore", "bunfig.toml"]) {
    compare(
      await readFile(join(options.project, file), "utf8"),
      await readFile(join(packet, file), "utf8"),
      `policy:${file}`,
    );
  }
  await checkLock(options.project, expected);
  return actual;
}

async function checkLock(root: string, expected: Document): Promise<void> {
  const lock = await jsonFile(join(root, "bun.lock"));
  requireValue(lock.lockfileVersion === 2, "policy:bun.lock.lockfileVersion");
  const workspace = document(
    document(lock.workspaces, "policy:bun.lock.workspaces")[""],
    "policy:bun.lock.workspaces.root",
  );
  const packages = document(lock.packages, "policy:bun.lock.packages");
  for (const group of ["dependencies", "devDependencies"]) {
    const pins = document(
      expected[group] ?? {},
      `policy:package.json.${group}`,
    );
    compare(
      workspace[group] ?? {},
      pins,
      `policy:bun.lock.workspaces.root.${group}`,
    );
    checkLockedResolutions(packages, pins);
  }
}

function checkLockedResolutions(packages: Document, pins: Document): void {
  for (const [name, version] of Object.entries(pins)) {
    const resolved = packages[name];
    requireValue(Array.isArray(resolved), `policy:bun.lock.packages.${name}`);
    requireValue(
      resolved[0] === `${name}@${version}`,
      `policy:bun.lock.packages.${name}`,
    );
  }
}

function nativeEnvironment(): Record<string, string | undefined> {
  const forbidden = [
    "FALLOW_PRODUCTION",
    "FALLOW_PRODUCTION_DEAD_CODE",
    "FALLOW_CHANGED_SINCE",
    "FALLOW_DIFF_FILE",
    "FALLOW_ROOT",
    "FALLOW_EXTRA_ARGS",
    "FALLOW_MAX_FILE_SIZE",
  ];
  for (const name of forbidden)
    requireValue(!process.env[name], `environment:${name}`);
  return { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
}

async function execute(
  options: Options,
  name: string,
  argv: string[],
): Promise<Receipt> {
  const result = Bun.spawnSync(argv, {
    cwd: options.project,
    env: nativeEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const receipt: Receipt = {
    name,
    argv,
    cwd: options.project,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  await writeFile(
    join(options.evidence, `${name}.json`),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}

function parseReceipt(receipt: Receipt): Document {
  let value: unknown;
  try {
    value = JSON.parse(receipt.stdout);
  } catch {
    throw new Refusal(`${receipt.name}:non-json`);
  }
  return document(value, `${receipt.name}:non-object`);
}

async function successful(
  options: Options,
  name: string,
  argv: string[],
): Promise<Receipt> {
  const receipt = await execute(options, name, argv);
  requireValue(receipt.exitCode === 0, `${name}:exit`);
  return receipt;
}

function sourcePaths(files: Record<string, string>): string[] {
  const paths = Object.keys(files).filter((path) => path.endsWith(".ts"));
  requireValue(paths.length > 0, "scope:empty");
  for (const path of paths)
    requireValue(
      /^(src|tests)\/.+\.ts$/.test(path),
      `scope:outside-includes:${path}`,
    );
  return paths.sort();
}

function normalizedPaths(root: string, value: unknown): string[] {
  requireValue(Array.isArray(value), "scope:path-list-missing");
  return value
    .map((item: unknown) => {
      requireValue(typeof item === "string", "scope:path-missing");
      return relative(root, resolve(root, item));
    })
    .sort();
}

async function compilerScope(options: Options, paths: string[]): Promise<void> {
  const receipt = await successful(options, "compiler-config", [
    "node_modules/.bin/tsc",
    "--showConfig",
    "-p",
    "tsconfig.json",
  ]);
  const config = parseReceipt(receipt);
  compare(
    normalizedPaths(options.project, config.files),
    paths,
    "scope:compiler-files",
  );
}

async function discoveryScope(
  options: Options,
  paths: string[],
): Promise<string[]> {
  const receipt = await successful(options, "whole-discovery", [
    "node_modules/.bin/fallow",
    "list",
    "--files",
    "--entry-points",
    "--format",
    "json",
    "--quiet",
  ]);
  const listing = parseReceipt(receipt);
  compare(
    normalizedPaths(options.project, listing.files),
    paths,
    "scope:fallow-files",
  );
  const entries = listing.entry_points;
  requireValue(Array.isArray(entries), "scope:entry-points-missing");
  const entryPaths = normalizedPaths(
    options.project,
    entries.map((entry: unknown) => document(entry, "scope:entry").path),
  );
  const required = paths.filter(
    (path) => path === "src/cli.ts" || path.endsWith(".test.ts"),
  );
  requireValue(required.includes("src/cli.ts"), "scope:front-door-missing");
  requireValue(required.length > 1, "scope:tests-missing");
  for (const path of required)
    requireValue(entryPaths.includes(path), `scope:entry-missing:${path}`);
  return required;
}

function wholeReportScope(whole: Document, requiredEntries: string[]): void {
  const report = document(whole.report, "scope:whole-report");
  const entries = document(report.entry_points, "scope:whole-entries");
  const sources = document(entries.sources, "scope:whole-entry-sources");
  requireValue(
    sources.manual_entry === requiredEntries.length,
    "scope:whole-manual-entries",
  );
  compare(report.workspace_diagnostics ?? [], [], "scope:whole-diagnostics");
}

function semanticState(report: Document, pass: string): string {
  const meta = document(report._meta, `${pass}:semantic-missing`);
  const semantic = document(meta.type_aware, `${pass}:semantic-missing`);
  const identity = document(
    semantic.identity,
    `${pass}:semantic-identity-missing`,
  );
  requireValue(
    semantic.required_completeness === "complete",
    `${pass}:semantic-policy`,
  );
  requireValue(
    identity.completeness === "complete",
    `${pass}:semantic-incomplete`,
  );
  if (semantic.executed === false) {
    unnecessaryEvidence(semantic, identity, pass);
    return "unnecessary";
  }
  executedEvidence(semantic, pass);
  return "complete";
}

function unnecessaryEvidence(
  semantic: Document,
  identity: Document,
  pass: string,
): void {
  requireValue(
    identity.project_config_hash === "deferred:no-semantic-queries",
    `${pass}:unnecessary-evidence`,
  );
  requireValue(
    semantic.candidate_count === 0,
    `${pass}:unnecessary-candidates`,
  );
  compare(semantic.queries ?? [], [], `${pass}:unnecessary-queries`);
}

function executedEvidence(semantic: Document, pass: string): void {
  requireValue(semantic.executed === true, `${pass}:execution-missing`);
  requireValue(
    Array.isArray(semantic.selected_tsconfigs) &&
      semantic.selected_tsconfigs.length > 0,
    `${pass}:projects-missing`,
  );
  const queries = semantic.queries;
  requireValue(
    Array.isArray(queries) && queries.length > 0,
    `${pass}:queries-missing`,
  );
  for (const query of queries)
    requireValue(
      document(query, `${pass}:query`).status === "complete",
      `${pass}:query-incomplete`,
    );
}

async function fallowPass(
  options: Options,
  name: string,
  command: unknown,
): Promise<Document> {
  requireValue(typeof command === "string", `${name}:command`);
  const receipt = await execute(options, name, command.split(" "));
  const report = parseReceipt(receipt);
  if (report.error === true) {
    requireValue(receipt.exitCode !== 0, `${name}:invalid-error-exit`);
    throw new Refusal(`${name}:native-error`);
  }
  requireValue(
    report.kind === "dead-code" && report.version === "3.19.0",
    `${name}:identity`,
  );
  const semantic = semanticState(report, name);
  return { name, exitCode: receipt.exitCode, report, semantic };
}

async function admission(options: Options): Promise<Document> {
  await mkdir(options.evidence, { recursive: true });
  const before = await inventory(options.project);
  await writeFile(
    join(options.evidence, "before.json"),
    JSON.stringify(before, null, 2) + "\n",
  );
  const packageJson = await checkPolicy(options);
  const paths = sourcePaths(before);
  await compilerScope(options, paths);
  const requiredEntries = await discoveryScope(options, paths);
  await successful(options, "biome", [
    "node_modules/.bin/biome",
    "check",
    "--diagnostic-level=error",
    ".",
  ]);
  await successful(options, "compiler", [
    "node_modules/.bin/tsc",
    "--noEmit",
    "-p",
    "tsconfig.json",
  ]);
  await successful(options, "tests", [process.execPath, "test"]);
  const scripts = document(packageJson.scripts, "policy:scripts");
  const whole = await fallowPass(
    options,
    "whole-project",
    scripts["quality:fallow"],
  );
  const production = await fallowPass(
    options,
    "production-dependencies",
    scripts["quality:fallow:dependencies"],
  );
  await writeFile(
    join(options.evidence, "passes.json"),
    JSON.stringify({ whole, production }, null, 2) + "\n",
  );
  wholeReportScope(whole, requiredEntries);
  compare(await inventory(options.project), before, "scope:project-changed");
  requireValue(whole.exitCode === 0, "whole-project:findings");
  requireValue(production.exitCode === 0, "production-dependencies:findings");
  return {
    status: "admitted",
    profile: options.profile,
    authoredFiles: paths,
    wholeEntrypoints: requiredEntries,
    wholeSemantic: whole.semantic,
    productionSemantic: production.semantic,
  };
}

try {
  const options = parseOptions();
  const result = await admission(options);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const cause = error instanceof Refusal ? error.causeCode : "admission:error";
  const detail = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    JSON.stringify({ status: "refused", cause, detail }) + "\n",
  );
  process.exitCode = 1;
}
