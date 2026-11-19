import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { testFolder } from "../support/test-folder.ts";

const ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];
type Observed = Record<string, unknown>;

function object(value: unknown): Observed {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an observed JSON object.");
  return value as Observed;
}

function fixture() {
  const root = testFolder("complex-diagnostics-");
  roots.push(root);
  const xdg = join(root, "xdg");
  return { root, xdg, directory: join(xdg, "example", "diagnostics") };
}

async function invoke(
  root: string,
  xdg: string,
  args = ["status"],
  preload?: string,
  environment: Record<string, string> = {},
) {
  const start = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      ...(preload ? ["--preload", preload] : []),
      "src/cli.ts",
      ...args,
      "--json",
    ],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"),
        HOME: root,
        XDG_STATE_HOME: xdg,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
        ...environment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  const value: unknown = JSON.parse(stdout);
  return {
    exit,
    document: object(value),
    milliseconds: performance.now() - start,
  };
}

function domain(document: Observed) {
  const facts = { ...object(document.result) };
  delete facts.runId;
  const envelope: Observed = { ...document, result: facts };
  delete envelope.diagnostics;
  return envelope;
}

function diagnosticFile(document: Observed): string {
  const diagnostics = object(document.diagnostics);
  expect(diagnostics).toMatchObject({
    status: "available",
    closed: true,
    sinkFailure: null,
  });
  if (typeof diagnostics.file !== "string")
    throw new Error("Missing log path.");
  return diagnostics.file;
}

async function preload(root: string, source: string): Promise<string> {
  const path = join(root, "preload.ts");
  await writeFile(path, source);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("diagnostics create private files, preserve current closed files, and prune seven-day closed files only", async () => {
  const { root, xdg, directory } = fixture();
  const first = await invoke(root, xdg);
  expect(first.exit).toBe(0);
  const closed = diagnosticFile(first.document);
  expect((await stat(closed)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const second = await invoke(root, xdg);
  expect(second.exit).toBe(0);
  expect(await Bun.file(closed).exists()).toBe(true);
  const active = join(directory, "active.jsonl");
  const ambiguous = join(directory, "ambiguous.jsonl");
  await writeFile(active, "active evidence", { mode: 0o600 });
  await writeFile(ambiguous, "ambiguous evidence", { mode: 0o600 });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(active, old, old);
  await utimes(ambiguous, old, old);
  const fd = openSync(active, "a");
  try {
    const clock = await preload(
      root,
      "const now = Date.now(); Date.now = () => now + 8 * 24 * 60 * 60 * 1000;",
    );
    const pruned = await invoke(root, xdg, ["status"], clock);
    expect(pruned.exit).toBe(0);
    expect(await Bun.file(closed).exists()).toBe(false);
    expect(await Bun.file(diagnosticFile(second.document)).exists()).toBe(
      false,
    );
    expect(await readFile(active, "utf8")).toBe("active evidence");
    expect(await readFile(ambiguous, "utf8")).toBe("ambiguous evidence");
    diagnosticFile(pruned.document);
  } finally {
    closeSync(fd);
  }
});

test("ambiguous active reservations refuse diagnostics without deleting evidence or preventing a set", async () => {
  const { root, xdg, directory } = fixture();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 10; index += 1)
    await writeFile(
      join(directory, `active-${index}.jsonl`),
      `evidence ${index}`,
      { mode: 0o600 },
    );
  const result = await invoke(root, xdg, ["set", "--value", "enabled"]);
  expect(result.exit).toBe(0);
  expect(object(result.document.result)).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
    transactionState: "completed",
  });
  expect(result.document.diagnostics).toMatchObject({
    status: "unavailable",
    trusted: { sinkFailure: "capacity" },
  });
  expect(
    (await readdir(directory)).filter((name) => name.endsWith(".jsonl")),
  ).toHaveLength(10);
  for (let index = 0; index < 10; index += 1)
    expect(
      await readFile(join(directory, `active-${index}.jsonl`), "utf8"),
    ).toBe(`evidence ${index}`);
  expect(JSON.parse(await readFile(join(root, "state.json"), "utf8"))).toEqual({
    value: "enabled",
  });
});

test("concurrent pruning keeps active evidence and contains all log allocations", async () => {
  const { root, xdg, directory } = fixture();
  const original = diagnosticFile((await invoke(root, xdg)).document);
  const active = join(directory, "active.jsonl");
  await writeFile(active, "still active", { mode: 0o600 });
  const clock = await preload(
    root,
    "const now = Date.now(); Date.now = () => now + 8 * 24 * 60 * 60 * 1000;",
  );
  const results = await Promise.all([
    invoke(root, xdg, ["status"], clock),
    invoke(root, xdg, ["status"], clock),
  ]);
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.exit).toBe(0);
    expect(object(result.document.result)).toMatchObject({
      causeCode: "SUCCESS_UNCHANGED",
    });
  }
  expect(
    results.some(
      (result) => object(result.document.diagnostics).status === "available",
    ),
  ).toBe(true);
  expect(await Bun.file(original).exists()).toBe(false);
  expect(await readFile(active, "utf8")).toBe("still active");
  const logs = (await readdir(directory)).filter((name) =>
    name.endsWith(".jsonl"),
  );
  expect(logs.length).toBeGreaterThanOrEqual(2);
  expect(logs.length).toBeLessThanOrEqual(3);
  const sizes = await Promise.all(
    logs.map(async (name) => (await stat(join(directory, name))).size),
  );
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
    10_000_000,
  );
});

test.each(["fifo", "symlink", "writable-ancestor"])(
  "diagnostics contain a hostile %s without changing the domain result",
  async (kind) => {
    const { root, xdg, directory } = fixture();
    const normal = await invoke(root, join(root, "normal"));
    diagnosticFile(normal.document);
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    if (kind === "symlink") await symlink(outside, xdg);
    else if (kind === "writable-ancestor") {
      await mkdir(xdg, { mode: 0o700 });
      await chmod(xdg, 0o777);
    } else {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const fifo = Bun.spawnSync(["mkfifo", join(directory, "occupied.jsonl")]);
      expect(fifo.exitCode).toBe(0);
    }
    const result = await invoke(root, xdg);
    expect(result.exit).toBe(0);
    expect(domain(result.document)).toEqual(domain(normal.document));
    expect(result.document.diagnostics).toMatchObject({
      status: "unavailable",
      trusted: { sinkFailure: "setup" },
    });
    expect(await readdir(outside)).toEqual([]);
    if (kind === "fifo")
      expect((await lstat(join(directory, "occupied.jsonl"))).isFIFO()).toBe(
        true,
      );
    if (kind === "writable-ancestor") expect(await readdir(xdg)).toEqual([]);
  },
);

test("exclusive diagnostic creation never appends to an existing final file", async () => {
  const { root, xdg } = fixture();
  const fixedIdentity = await preload(
    root,
    `import { mock } from "bun:test"; import * as crypto from "node:crypto"; mock.module("node:crypto", () => ({ ...crypto, randomUUID: () => "11111111-1111-4111-8111-111111111111" }));`,
  );
  const first = await invoke(root, xdg, ["status"], fixedIdentity);
  const file = diagnosticFile(first.document);
  const bytes = await readFile(file);
  const second = await invoke(root, xdg, ["status"], fixedIdentity);
  expect(second.exit).toBe(0);
  expect(domain(second.document)).toEqual(domain(first.document));
  expect(second.document.diagnostics).toMatchObject({
    status: "unavailable",
    trusted: { sinkFailure: "setup" },
  });
  expect(await readFile(file)).toEqual(bytes);
});

async function faultPreload(root: string, fault: string): Promise<string> {
  return preload(
    root,
    `
import { mock } from "bun:test";
import * as fs from "node:fs";
const originalOpen = fs.openSync, originalWrite = fs.write;
const fds = new Set();
const fault = ${JSON.stringify(fault)};
const hit = () => fs.writeFileSync(${JSON.stringify(join(root, "fault-observed"))}, fault);
mock.module("node:fs", () => ({ ...fs,
  openSync(path, ...args) {
    const target = String(path).includes("/example/diagnostics/") && String(path).endsWith(".jsonl");
    if (target && ["EACCES", "ENOSPC"].includes(fault)) { hit(); throw Object.assign(new Error("injected setup error"), { code: fault }); }
    const fd = originalOpen(path, ...args); if (target) fds.add(fd); return fd;
  },
  write(fd, ...args) {
    if (!fds.has(fd)) return originalWrite(fd, ...args);
    if (fault === "write-throw") { hit(); throw new Error("injected sink error"); }
    if (fault === "stuck-write") { hit(); return; }
    return originalWrite(fd, ...args);
  }
}));
`,
  );
}

test.each(["missing-home", "EACCES", "ENOSPC", "write-throw", "stuck-write"])(
  "diagnostic %s preserves the complete set result, state and one completed effect",
  async (fault) => {
    const { root, xdg } = fixture();
    const normal = await invoke(root, join(root, "normal"), [
      "set",
      "--value",
      "enabled",
    ]);
    expect(normal.exit).toBe(0);
    diagnosticFile(normal.document);
    const state = join(root, "state.json");
    const bytes = await readFile(state);
    await rm(state);
    await rm(`${state}.journal.jsonl`);
    const injection =
      fault === "missing-home" ? undefined : await faultPreload(root, fault);
    const environment =
      fault === "missing-home" ? { HOME: "", XDG_STATE_HOME: "" } : {};
    const result = await invoke(
      root,
      xdg,
      ["set", "--value", "enabled"],
      injection,
      environment,
    );
    expect(result.exit).toBe(0);
    expect(domain(result.document)).toEqual(domain(normal.document));
    expect(await readFile(state)).toEqual(bytes);
    const journal = (await readFile(`${state}.journal.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)));
    expect(journal.map((row) => row.phase)).toEqual(["intent", "completed"]);
    expect(object(result.document.result).effects).toEqual({
      completed: ["effect.set-state"],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    });
    if (fault !== "missing-home")
      expect(await readFile(join(root, "fault-observed"), "utf8")).toBe(fault);
    const diagnostics = object(result.document.diagnostics);
    if (["missing-home", "EACCES", "ENOSPC"].includes(fault))
      expect(diagnostics).toMatchObject({
        status: "unavailable",
        trusted: { sinkFailure: "setup" },
      });
    else
      expect(diagnostics).toMatchObject({
        status: "available",
        sinkFailure: fault === "stuck-write" ? "flush-timeout" : "write",
        unflushedRecords: 1,
      });
    if (fault === "stuck-write") {
      expect(result.milliseconds).toBeGreaterThanOrEqual(450);
      expect(result.milliseconds).toBeLessThan(1200);
    }
  },
);
