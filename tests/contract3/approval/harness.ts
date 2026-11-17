import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  AuthoritySource,
  ClosureItem,
  StopItem,
} from "../../../starters/contract3/src/addons/approval/index.ts";
import { writeToolchain } from "../../support/materialised-tree.ts";
import { approvalCases } from "./cases.ts";

const repository = new URL("../../../", import.meta.url).pathname;

export type World = {
  readonly root: string;
  readonly grants: string;
  readonly consumed: string;
  readonly effects: string;
  readonly revision: string;
  readonly clock: string;
  readonly lock: string;
  readonly contacts: string;
  readonly authority: string;
};

export type Observation = {
  readonly outcome: string;
  readonly consumeDelta: number;
  readonly effectDelta: number;
  readonly grantUnchanged: boolean;
};

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function markerName(parts: readonly string[]): string {
  return `${digest(parts)}.consumed`;
}
function recordName(parts: readonly string[]): string {
  return `${digest(parts)}.json`;
}

const tests = "tests/contract3/approval";

export async function materialize(): Promise<{
  readonly root: string;
  readonly driver: string;
}> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contract3-approval-tree-"),
  );
  const source = join(root, "starters/contract3/src");
  await mkdir(join(source, "addons/state"), { recursive: true });
  await mkdir(join(root, tests), { recursive: true });
  for (const part of ["kernel", "addons/approval"])
    await cp(
      join(repository, "starters/contract3/src", part),
      join(source, part),
      { recursive: true },
    );
  const fixtures = new URL("fixtures/", import.meta.url);
  await writeFile(
    join(source, "addons/state/coordination.ts"),
    await readFile(new URL("coordination.ts.txt", fixtures)),
  );
  for (const name of ["harness.ts", "cases.ts"])
    await cp(join(repository, tests, name), join(root, tests, name));
  await mkdir(join(root, "tests/support"), { recursive: true });
  await cp(
    join(repository, "tests/support/materialised-tree.ts"),
    join(root, "tests/support/materialised-tree.ts"),
  );
  const driver = join(root, tests, "driver.ts");
  await writeFile(driver, await readFile(new URL("driver.ts.txt", fixtures)));
  await writeToolchain(root, [
    "starters/contract3/src/**/*.ts",
    `${tests}/**/*.ts`,
    "tests/support/**/*.ts",
  ]);
  return { root, driver };
}

export async function createWorld(): Promise<World> {
  // Platform: Resolved, so fileSeparation judges real directories, not /var's symlink.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contract3-approval-world-"),
  );
  const world = {
    root,
    grants: join(root, "grants"),
    consumed: join(root, "consumed"),
    effects: join(root, "effects.log"),
    revision: join(root, "revision"),
    clock: join(root, "clock"),
    lock: join(root, "scope.lock"),
    contacts: join(root, "contacts.log"),
    authority: join(root, "authority"),
  };
  for (const directory of [world.grants, world.consumed, world.authority])
    await mkdir(directory);
  await writeFile(world.revision, "r0");
  await writeFile(world.clock, "1000");
  await writeFile(world.effects, "");
  await writeFile(world.contacts, "");
  return world;
}

export async function removeAll(...paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

export const grant = {
  format: "contract3.approval-grant",
  version: 1,
  operation: "fixture.approve",
  preview: "p-1",
  authority: "owner-a",
  resource: "resource-1",
  resourceRevision: "r0",
  effects: ["note.write"],
  expiresAt: 5000,
} as const;

export function grantPath(world: World, preview: string): string {
  return join(world.grants, recordName(["approval", preview]));
}

export const closureRecord = {
  format: "contract3.closure-authority",
  version: 1,
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
  expiresAt: 5000,
} as const;
export const closureItem: ClosureItem = {
  operation: "op-1",
  disposition: "outcome-unknown",
  evidence: "ev-1",
  scope: "resource-1",
};
export const stopRecord = {
  format: "contract3.stop-attestation",
  version: 1,
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  expiresAt: 5000,
} as const;
export const stopItem: StopItem = {
  operation: "op-1",
  owner: "owner-1",
  writers: ["w-1", "w-2"],
  scope: "resource-1",
  liveConflict: false,
};
export const unorderedStopItem: StopItem = {
  ...stopItem,
  writers: ["w-2", "w-1"],
};

export function adversarialSource(directory: string): AuthoritySource {
  return { directory, separated: () => Promise.resolve(true) };
}

export function authorityRecordPath(
  world: World,
  kind: "closure" | "stop",
  parts: readonly string[],
): string {
  return join(world.authority, recordName([kind, ...parts]));
}

export async function writeGrant(
  world: World,
  value: unknown,
  preview: string = grant.preview,
): Promise<void> {
  await writeFile(grantPath(world, preview), JSON.stringify(value));
}

export async function snapshot(world: World) {
  const hash = createHash("sha256");
  for (const directory of [world.grants, world.authority])
    for (const name of (await readdir(directory)).sort()) {
      hash.update(name);
      const path = join(directory, name);
      const status = await lstat(path);
      if (!status.isFile()) hash.update(`<${status.mode}>`);
      else
        try {
          hash.update(await readFile(path));
        } catch {
          hash.update("<unreadable>");
        }
    }
  const effects = (await readFile(world.effects, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  return {
    markers: (await readdir(world.consumed)).sort(),
    effects,
    authority: hash.digest("hex"),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

export function observation(
  outcome: string,
  before: Snapshot,
  after: Snapshot,
): Observation {
  return {
    outcome,
    consumeDelta: after.markers.length - before.markers.length,
    effectDelta: after.effects.length - before.effects.length,
    grantUnchanged: before.authority === after.authority,
  };
}

export type DriverConfig = Readonly<Record<string, unknown>>;

export function applyConfig(
  world: World,
  runId: string,
  overrides: DriverConfig = {},
): DriverConfig {
  return {
    mode: "apply",
    world,
    runId,
    operation: grant.operation,
    preview: grant.preview,
    authority: grant.authority,
    resource: grant.resource,
    effects: grant.effects,
    lock: "refuse",
    barriers: [],
    ...overrides,
  };
}

const boundMilliseconds = 15_000;
const live = new Set<Driver>();

export async function stopLiveDrivers(): Promise<void> {
  for (const driver of [...live]) {
    driver.kill();
    await driver.finish().catch(() => undefined);
  }
}

export class Driver {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  readonly events: unknown[] = [];

  constructor(path: string, config: DriverConfig) {
    this.#child = Bun.spawn([process.execPath, path, JSON.stringify(config)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#reader = this.#child.stdout.getReader();
    live.add(this);
  }

  async next(): Promise<unknown> {
    const deadline = Date.now() + boundMilliseconds;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end >= 0) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        const event: unknown = JSON.parse(line);
        this.events.push(event);
        return event;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), deadline - Date.now());
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk === "timeout") throw new Error("Driver phase not reached.");
      if (chunk.done) return undefined;
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async go(): Promise<void> {
    await this.#child.stdin.write("go\n");
    await this.#child.stdin.flush();
  }

  kill(): void {
    this.#child.kill("SIGKILL");
  }

  async finish() {
    for (;;) if ((await this.next()) === undefined) break;
    await this.#child.stdin.end();
    const exit = await this.#child.exited;
    live.delete(this);
    return {
      exit,
      signal: this.#child.signalCode,
      stderr: await new Response(this.#child.stderr).text(),
    };
  }
}

export async function run(path: string, config: DriverConfig) {
  const driver = new Driver(path, config);
  const finished = await driver.finish();
  return { ...finished, events: driver.events };
}

function expectedFor(id: string): Observation {
  const found = approvalCases.find((item) => item.id === id);
  if (found?.status !== "executable")
    throw new Error(`Unknown or non-executable case ${id}.`);
  return found.expected;
}

export function expectCase(id: string, observed: Observation): void {
  expect(observed).toEqual(expectedFor(id));
  const log = process.env.T4_ORACLE_LOG;
  if (log) appendFileSync(log, `${id}\n`);
}

async function foreignDirectory(path: string): Promise<boolean> {
  const caller = process.getuid?.();
  try {
    const facts = await lstat(path);
    return (
      caller !== undefined &&
      facts.isDirectory() &&
      facts.uid !== caller &&
      (facts.mode & 0o022) === 0 &&
      !(await writable(path))
    );
  } catch {
    return false;
  }
}
async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
async function foreignChain(directory: string): Promise<boolean> {
  const parts = directory.split(sep).filter((part) => part.length > 0);
  for (const [index] of [undefined, ...parts].entries()) {
    const path = join(sep, ...parts.slice(0, index));
    if (!(await foreignDirectory(path))) return false;
  }
  return true;
}
const fileRoots = ["/usr/share", "/usr/lib", "/etc", "/usr/include"];
const searchDepth = 3;
const searchBound = 4000;
type FileSearch = {
  found: string | undefined;
  examined: number;
  directories: number;
  rejected: {
    notRegular: number;
    callerOwned: number;
    groupOrWorldWritable: number;
    callerWritable: number;
    directoryChain: number;
    unreadable: number;
  };
};
type Rejection = keyof FileSearch["rejected"];
async function fileRejection(path: string): Promise<Rejection | undefined> {
  let facts;
  try {
    facts = await lstat(path);
  } catch {
    return "unreadable";
  }
  const caller = process.getuid?.();
  const checks: readonly (readonly [
    Rejection,
    () => boolean | Promise<boolean>,
  ])[] = [
    ["notRegular", () => !facts.isFile()],
    ["callerOwned", () => caller === undefined || facts.uid === caller],
    ["groupOrWorldWritable", () => (facts.mode & 0o022) !== 0],
    ["callerWritable", () => writable(path)],
  ];
  for (const [reason, failed] of checks) if (await failed()) return reason;
  return undefined;
}
async function judgeFile(
  path: string,
  directory: string,
  search: FileSearch,
  chains: Map<string, boolean>,
): Promise<boolean> {
  const reason = await fileRejection(path);
  if (reason) {
    search.rejected[reason]++;
    return false;
  }
  const chain = chains.get(directory) ?? (await foreignChain(directory));
  chains.set(directory, chain);
  if (!chain) search.rejected.directoryChain++;
  return chain;
}
async function isDirectoryEntry(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function searchEntry(
  path: string,
  directory: string,
  search: FileSearch,
  chains: Map<string, boolean>,
  subdirectories: string[],
): Promise<void> {
  search.examined++;
  if (await isDirectoryEntry(path)) {
    if (await foreignDirectory(path)) subdirectories.push(path);
  } else if (await judgeFile(path, directory, search, chains))
    search.found = path;
}
async function searchDirectory(
  directory: string,
  depth: number,
  search: FileSearch,
  chains: Map<string, boolean>,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    search.rejected.unreadable++;
    return;
  }
  search.directories++;
  const subdirectories: string[] = [];
  for (const name of names) {
    if (search.found || search.examined >= searchBound) return;
    await searchEntry(
      join(directory, name),
      directory,
      search,
      chains,
      subdirectories,
    );
  }
  if (depth > 0)
    for (const path of subdirectories)
      await searchDirectory(path, depth - 1, search, chains);
}
async function foreignFileSearch(
  roots: readonly string[],
): Promise<FileSearch> {
  const search: FileSearch = {
    found: undefined,
    examined: 0,
    directories: 0,
    rejected: {
      notRegular: 0,
      callerOwned: 0,
      groupOrWorldWritable: 0,
      callerWritable: 0,
      directoryChain: 0,
      unreadable: 0,
    },
  };
  const chains = new Map<string, boolean>();
  for (const root of roots)
    if (!search.found) await searchDirectory(root, searchDepth, search, chains);
  return search;
}
function describeSearch(search: FileSearch, roots: number): string {
  const r = search.rejected;
  return [
    `no qualifying file in ${roots} roots (depth ${searchDepth}, bound ${searchBound}):`,
    `examined ${search.examined} entries in ${search.directories} directories;`,
    `rejected not-regular ${r.notRegular}, caller-owned ${r.callerOwned},`,
    `group-or-world-writable ${r.groupOrWorldWritable},`,
    `caller-writable ${r.callerWritable}, directory-chain ${r.directoryChain},`,
    `unreadable ${r.unreadable}`,
  ].join(" ");
}
const candidateUnusable = new Set<unknown>(["ENOENT", "ENOTDIR", "EACCES"]);
async function writableForeignRoot(): Promise<string | undefined> {
  const caller = process.getuid?.();
  for (const candidate of ["/tmp", tmpdir()]) {
    try {
      const path = await realpath(candidate);
      const facts = await lstat(path);
      if (
        facts.isDirectory() &&
        facts.uid !== caller &&
        (facts.mode & 0o002) !== 0 &&
        (await writable(path))
      )
        return path;
    } catch (error) {
      if (!candidateUnusable.has(Reflect.get(Object(error), "code")))
        throw error;
    }
  }
  return undefined;
}
async function symlinkedForeignRoot() {
  for (const link of ["/etc", "/var", "/lib", "/bin", "/sbin", "/lib64"]) {
    try {
      const facts = await lstat(link);
      if (!facts.isSymbolicLink() || facts.uid === process.getuid?.()) continue;
      const resolved = await realpath(link);
      for (const name of (await readdir(resolved)).sort()) {
        const child = join(resolved, name);
        if ((await foreignDirectory(child)) && (await foreignChain(child)))
          return { viaLink: join(link, name), resolved: child };
      }
    } catch (error) {
      if (!candidateUnusable.has(Reflect.get(Object(error), "code")))
        throw error;
    }
  }
  return undefined;
}

export type PlatformPaths = {
  readonly foreignFile: string | undefined;
  readonly foreignFileMissing: string;
  readonly writableRoot: string | undefined;
  readonly symlinked:
    | { readonly viaLink: string; readonly resolved: string }
    | undefined;
};
export async function foreignFile(
  roots: readonly string[] = fileRoots,
): Promise<{ readonly found: string | undefined; readonly missing: string }> {
  const search = await foreignFileSearch(roots);
  return {
    found: search.found,
    missing: search.found ? "" : describeSearch(search, roots.length),
  };
}
export async function platformPaths(): Promise<PlatformPaths> {
  const file = await foreignFile();
  return {
    foreignFile: file.found,
    foreignFileMissing: file.missing,
    writableRoot: await writableForeignRoot(),
    symlinked: await symlinkedForeignRoot(),
  };
}
