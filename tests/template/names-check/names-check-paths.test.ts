import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { namesOnPaths, recordedHitsFile } from "../../../scripts/glossary.ts";
import {
  check,
  glossary,
  hostHit,
  hostRefusal,
  namesCheckFixture,
  put,
  thrownBy,
} from "./names-check-fixture.ts";

const { emptyRepository, folder, namesRepository, outsideRepository } =
  namesCheckFixture();

const usage =
  "Usage: bun run check:names <path> [path ...] | --staged | --tool-call | --against <revision>";

const allowlistRefusal =
  'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: Look in the glossary first; rename it with "Recorded hit".\n';
const proofRefusal =
  'src/allowlist/proof uses "proof" with no qualifier. Repair: Look in the glossary first; add a word that says which proof it is.\n';

function hook(call: unknown): () => Promise<string> {
  return () => Promise.resolve(JSON.stringify(call));
}

function writeCall(filePath: string, cwd?: string) {
  return {
    tool_name: "Write",
    tool_input: { file_path: filePath },
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function patchCall(...hunks: string[]) {
  return {
    tool_name: "apply_patch",
    tool_input: {
      command: ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n"),
    },
  };
}

class ClosedEarly {
  readonly name = "ClosedEarly";
  readonly message = "closed";

  toString(): string {
    return "input closed early";
  }
}

test.each([
  [
    "an Avoid word",
    "docs/mutation-notes.md",
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: Look in the glossary first; rename it with "Planted fault".\n',
  ],
  ["a qualify word alone", "docs/host.md", hostRefusal],
])(
  "in process: a given path that uses %s is refused with its word and repair",
  async (_kind, path, line) => {
    expect(await check(namesRepository(), [path])).toEqual({
      stderr: line,
      code: 1,
    });
  },
);

test("in process: given paths that use only glossary words pass in silence", async () => {
  expect(
    await check(namesRepository(), [
      "docs/planted-fault-notes.md",
      "src/test-host.ts",
    ]),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: a recorded hit passes the given path it covers", async () => {
  expect(await check(namesRepository([hostHit]), ["docs/host.md"])).toEqual({
    stderr: "",
    code: 0,
  });
});

test("in process: every folder on the given paths is judged once, by its own name", async () => {
  expect(
    await check(namesRepository(), [
      "src/allowlist/proof/index.ts",
      "src/allowlist/other.ts",
    ]),
  ).toEqual({ stderr: allowlistRefusal + proofRefusal, code: 1 });
});

test("in process: an absolute path inside the root is judged by its path from the root", async () => {
  const root = namesRepository();
  expect(await check(root, [join(root, "docs/host.md")])).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
});

test("in process: a relative path is resolved from the folder the check runs in, and judged by its path from the root", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  const elsewhere = folder();
  mkdirSync(docs);
  expect(await check(root, ["host.md"], undefined, docs)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["../docs/host.md"], undefined, docs)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["host.md"], undefined, elsewhere)).toEqual({
    stderr: `${usage}. host.md is outside this repository.\n`,
    code: 2,
  });
});

test.each([
  ["no path", [], "Give at least one path, --staged or --tool-call."],
  ["an option it does not know", ["--stagd"], 'Unknown option "--stagd".'],
  [
    "an unknown option after a path",
    ["docs/host.md", "--x"],
    'Unknown option "--x".',
  ],
  [
    "a path beside --staged",
    ["--staged", "docs/host.md"],
    "--staged takes no path.",
  ],
  [
    "a path beside --tool-call",
    ["--tool-call", "docs/host.md"],
    "--tool-call takes no path.",
  ],
  [
    "a path outside the root",
    ["../elsewhere/host.ts"],
    "../elsewhere/host.ts is outside this repository.",
  ],
  ["the root itself", ["."], ". is outside this repository."],
  [
    "a folder whose name only begins with two dots",
    ["..hidden/notes.md"],
    null,
  ],
])(
  "in process: %s is judged as a usage matter",
  async (_kind, args, reason) => {
    const outcome = await check(namesRepository(), args);
    expect(outcome).toEqual(
      reason === null
        ? { stderr: "", code: 0 }
        : { stderr: `${usage}. ${reason}\n`, code: 2 },
    );
  },
);

test("in process: a check that cannot run exits 2 without the usage line", async () => {
  const root = namesRepository();
  put(root, recordedHitsFile, "{}");
  expect(await check(root, ["docs/host.md"])).toEqual({
    stderr: `${recordedHitsFile} has no "hits" array. Repair: add "hits": [] at its top level.\n`,
    code: 2,
  });
});

test("in process: standard input is read only for --tool-call", async () => {
  const root = namesRepository();
  const unread = () => Promise.reject(new Error("stdin was read"));
  expect(await check(root, ["docs/host.md"], unread)).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
  expect(await check(root, ["--staged"], unread)).toEqual({
    stderr: "",
    code: 0,
  });
});

test("in process: --tool-call refuses a Write that creates a badly named file", async () => {
  const root = namesRepository();
  expect(
    await check(root, ["--tool-call"], hook(writeCall("docs/host.md", root))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call judges each new folder and the new file once", async () => {
  const root = namesRepository();
  put(root, "src/kept.ts", "");
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("src/allowlist/proof/index.ts", root)),
    ),
  ).toEqual({ stderr: allowlistRefusal + proofRefusal, code: 1 });
});

test("in process: --tool-call leaves a file or folder that already exists unjudged", async () => {
  const root = namesRepository();
  put(root, "docs/host.md", "old\n");
  put(root, "src/allowlist/kept.ts", "");
  expect(
    await check(root, ["--tool-call"], hook(writeCall("docs/host.md", root))),
  ).toEqual({ stderr: "", code: 0 });
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("src/allowlist/proof/index.ts", root)),
    ),
  ).toEqual({ stderr: proofRefusal, code: 1 });
});

test("in process: --tool-call resolves a relative path from the call's folder", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  mkdirSync(docs);
  expect(
    await check(root, ["--tool-call"], hook(writeCall("host.md", docs))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call resolves a relative folder of the call from the injected folder, not the process's own", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  mkdirSync(docs);
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(writeCall("host.md", "../docs")),
      docs,
    ),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call resolves a relative path from the process folder when the call names none", async () => {
  const root = namesRepository();
  const docs = join(root, "docs");
  mkdirSync(docs);
  expect(
    await check(root, ["--tool-call"], hook(writeCall("host.md")), docs),
  ).toEqual({ stderr: hostRefusal, code: 1 });
  expect(
    await check(
      root,
      ["--tool-call"],
      hook({ ...writeCall("host.md"), cwd: 7 }),
      docs,
    ),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call judges a file by the repository that owns it, not the root it is given", async () => {
  const given = namesRepository();
  const owner = namesRepository();
  expect(
    await check(
      given,
      ["--tool-call"],
      hook(writeCall(join(owner, "docs/host.md"), given)),
    ),
  ).toEqual({ stderr: hostRefusal, code: 1 });
  put(owner, recordedHitsFile, JSON.stringify({ hits: [hostHit] }));
  expect(
    await check(
      given,
      ["--tool-call"],
      hook(writeCall(join(owner, "docs/host.md"), given)),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: --tool-call passes a file outside any repository, and in another repository with no names check", async () => {
  const outside = outsideRepository();
  const given = namesRepository();
  expect(
    await check(
      given,
      ["--tool-call"],
      hook(writeCall(join(outside, "docs/host.md"), outside)),
    ),
  ).toEqual({ stderr: "", code: 0 });
  const bare = emptyRepository();
  expect(
    await check(given, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  put(bare, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(
    await check(given, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  rmSync(join(bare, recordedHitsFile));
  put(bare, "GLOSSARY.md", glossary);
  expect(
    await check(given, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: "", code: 0 });
  put(bare, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(
    await check(given, ["--tool-call"], hook(writeCall("docs/host.md", bare))),
  ).toEqual({ stderr: hostRefusal, code: 1 });
});

test("in process: --tool-call reads each file an apply_patch adds or moves to, and no other hunk", async () => {
  const root = namesRepository();
  put(root, "docs/proof-old.md", "");
  expect(
    await check(
      root,
      ["--tool-call"],
      hook(
        patchCall(
          "*** Add File: docs/host.md",
          "+notes",
          "*** Update File: docs/mutation-update.md",
          "@@",
          "-a",
          "+b",
          "*** Delete File: docs/mutation-delete.md",
          "*** Update File: docs/proof-old.md",
          "*** Move to: docs/allowlist-moved.md",
          "@@",
          "-a",
          "+b",
        ),
      ),
    ),
  ).toEqual({
    stderr: [
      hostRefusal,
      'docs/allowlist-moved.md uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: Look in the glossary first; rename it with "Recorded hit".\n',
    ].join(""),
    code: 1,
  });
});

test("in process: --tool-call reads a *** Add File line only at the start of a line", async () => {
  expect(
    await check(
      namesRepository(),
      ["--tool-call"],
      hook(
        patchCall(
          "*** Update File: docs/notes.md",
          "+*** Add File: docs/host.md",
          "+ *** Move to: docs/host.md",
        ),
      ),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: a check that fails with something other than an Error reports it as text", async () => {
  const failure: Error = new ClosedEarly();
  expect(
    await check(namesRepository(), ["--tool-call"], () =>
      Promise.reject(failure),
    ),
  ).toEqual({ stderr: "input closed early\n", code: 2 });
});

test("in process: --tool-call passes an apply_patch that adds no file", async () => {
  expect(
    await check(
      namesRepository(),
      ["--tool-call"],
      hook(patchCall("*** Delete File: docs/mutation-delete.md")),
    ),
  ).toEqual({ stderr: "", code: 0 });
});

test.each([
  ["a tool it does not read", { tool_name: "Bash", tool_input: {} }, "Bash"],
  ["a call with no tool", { tool_input: {} }, "undefined"],
  ["a call that is not an object", null, "undefined"],
])(
  "in process: --tool-call refuses %s and names the two tools it reads",
  async (_kind, call, tool) => {
    expect(await check(namesRepository(), ["--tool-call"], hook(call))).toEqual(
      {
        stderr: `--tool-call reads a Write call's file_path and an apply_patch call's command, not a ${tool} call. Repair: wire the names check hook to those two tools.\n`,
        code: 2,
      },
    );
  },
);

test.each([
  ["Write", "file_path", "a number", { tool_input: { file_path: 7 } }],
  ["Write", "file_path", "no object", { tool_input: null }],
  ["apply_patch", "command", "a list", { tool_input: { command: ["x"] } }],
  ["apply_patch", "command", "a string", { tool_input: "patch" }],
])(
  "in process: --tool-call refuses a %s call whose tool_input has no string %s (%s)",
  async (tool, field, _kind, rest) => {
    expect(
      await check(
        namesRepository(),
        ["--tool-call"],
        hook({ tool_name: tool, ...rest }),
      ),
    ).toEqual({
      stderr: `--tool-call got a ${tool} call whose tool_input has no string ${field}, so it cannot tell which names the call creates. Repair: pass the tool call as the hook receives it.\n`,
      code: 2,
    });
  },
);

test("in process: --tool-call given input that is not JSON exits 2 with the parser's reason", async () => {
  const reason = thrownBy(() => JSON.parse("not json"));
  expect(
    await check(namesRepository(), ["--tool-call"], () =>
      Promise.resolve("not json"),
    ),
  ).toEqual({ stderr: `${reason}\n`, code: 2 });
});

test("in process: namesOnPaths lists each path and each folder above it once, in first-seen order", () => {
  expect(namesOnPaths([])).toEqual([]);
  expect(namesOnPaths(["README.md"])).toEqual(["README.md"]);
  expect(namesOnPaths(["a/b/c.ts"])).toEqual(["a", "a/b", "a/b/c.ts"]);
  expect(namesOnPaths(["src/a.ts", "src/b/c.ts", "src/a.ts"])).toEqual([
    "src",
    "src/a.ts",
    "src/b",
    "src/b/c.ts",
  ]);
});
