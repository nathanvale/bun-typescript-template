import { expect, test, afterAll } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  publicDeclarations,
  declarationProblems,
} from "../../../scripts/public-declarations.ts";
import {
  publicNameProblems,
  publicSurfaceFile,
  readPublicSurface,
  surfaceTexts,
} from "../../../scripts/public-surface.ts";
import {
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  recordedUnusedTermsFile,
} from "../../../scripts/glossary.ts";
import { type PublicSurface } from "../../../scripts/surface-match.ts";
import { stagedTexts } from "../../../scripts/staged-texts.ts";
import { KERNEL_RECIPE, LINT_RULE_FILES } from "../../../src/recipe.ts";
import { git } from "../../support/git-fixture.ts";
import { check, namesCheckFixture, put } from "./names-check-fixture.ts";
import {
  checkNames,
  fixtureRepository,
  removeFixtureTrees,
  repository,
  runFixtureGit,
} from "./fixture-tree.ts";

const { namesRepository } = namesCheckFixture();
afterAll(removeFixtureTrees);
const surface: PublicSurface = {
  exports: ["src/public.ts"],
  consumedExports: [],
  importers: [],
};
const refusal =
  'src/public.ts:1 public declaration "proof" breaks Qualify: uses "proof" with no qualifier. Repair: add a word that says which proof it is.\n';

function sourceRepository(text: string, scope: PublicSurface = surface) {
  const root = namesRepository();
  put(root, publicSurfaceFile, JSON.stringify(scope));
  put(root, "src/public.ts", text);
  git(root, "add", "--", publicSurfaceFile, "src/public.ts");
  return root;
}

test("symbol gate refuses an exported name with the exact file, line, rule and repair", async () => {
  const root = sourceRepository("export const proof = 1;\n");
  expect(await check(root, ["src/public.ts"])).toEqual({
    code: 1,
    stderr: refusal,
  });
  put(root, "src/public.ts", "export const testProof = 1;\n");
  expect(await check(root, ["src/public.ts"])).toEqual({ code: 0, stderr: "" });
});

test("symbol gate applies the shared Avoid rule to camel-case plurals", async () => {
  const root = sourceRepository("export const layoutMutations = 1;\n");
  expect(await check(root, ["src/public.ts"])).toEqual({
    code: 1,
    stderr:
      'src/public.ts:1 public declaration "layoutMutations" breaks Avoid: uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.\n',
  });
});

test("symbol gate judges the name of a default exported declaration", async () => {
  const root = sourceRepository("export default function proof() {}\n");
  expect(await check(root, ["src/public.ts"])).toEqual({
    code: 1,
    stderr: refusal,
  });
});

test("symbol gate judges public names with leading underscores and string member names in full", async () => {
  const root = sourceRepository(
    'export const __proof = 1;\nexport interface Result { "test/proof": string; "test/mutations": string }\n',
  );
  const problems = await publicNameProblems(root, false);
  expect(problems).toHaveLength(2);
  expect(problems[0]).toStartWith(
    'src/public.ts:1 public declaration "__proof" breaks Qualify:',
  );
  expect(problems[1]).toStartWith(
    'src/public.ts:2 public declaration "test/mutations" breaks Avoid:',
  );
});

test("symbol gate judges immediate members, method parameters, destructured parameters and return properties", async () => {
  const root = sourceRepository(`export interface CommandResult {
  proof: string;
  nested: { host: string };
  run(host: string): void;
}
export function execute({ proof }: { proof: string }) {
  const host = proof;
  return { proof: host };
}
`);
  const problems = await publicNameProblems(root, false);
  expect(problems).toHaveLength(4);
  expect(problems.map((problem) => problem.split(" breaks")[0])).toEqual([
    'src/public.ts:2 public declaration "proof"',
    'src/public.ts:4 public declaration "host"',
    'src/public.ts:6 public declaration "proof"',
    'src/public.ts:8 public declaration "proof"',
  ]);
});

test("symbol gate judges a destructured parameter by its property key, never its local alias or nested names", async () => {
  const root =
    sourceRepository(`export function first({ proof: testProof }: { proof: string }) {}
export function second({ testProof: proof }: { testProof: string }) {}
export function third({ nested: { host } }: { nested: { host: string } }) {}
export function fourth({ "test/mutations": value }: { "test/mutations": string }) {}
`);
  expect(
    (await publicNameProblems(root, false)).map(
      (problem) => problem.split(" breaks")[0],
    ),
  ).toEqual([
    'src/public.ts:1 public declaration "proof"',
    'src/public.ts:4 public declaration "test/mutations"',
  ]);
});

test("symbol gate judges immediate properties in explicit and inferred async returns", async () => {
  const root = sourceRepository(
    'export async function execute() { return { proof: "value" }; }\nexport async function finish(): Promise<{ host: string }> { return { host: "value" }; }\n',
  );
  const problems = await publicNameProblems(root, false);
  expect(problems).toHaveLength(2);
  expect(problems.map((problem) => problem.split(" breaks")[0])).toEqual([
    'src/public.ts:1 public declaration "proof"',
    'src/public.ts:2 public declaration "host"',
  ]);
});

test("symbol gate judges the return properties of public methods one level deep", async () => {
  const root = sourceRepository(`export interface CommandResult {
  run(): { proof: string; nested: { host: string } };
}
export class Runner {
  async finish() { return { host: "value" }; }
  private hidden() { return { proof: "value" }; }
}
`);
  expect(
    (await publicNameProblems(root, false)).map(
      (problem) => problem.split(" breaks")[0],
    ),
  ).toEqual([
    'src/public.ts:2 public declaration "proof"',
    'src/public.ts:5 public declaration "host"',
  ]);
});

test("symbol gate leaves locals, private and protected members and nested properties outside the public surface", async () => {
  const root = sourceRepository(`const proof = 1;
export class CommandResult {
  private host = proof;
  protected proof = 1;
  #host = 1;
  nested = { proof: 1 };
  run() { const host = 1; return host; }
}
`);
  expect(await check(root, ["src/public.ts"])).toEqual({ code: 0, stderr: "" });
});

test("symbol gate includes public constructor parameters, static members and each union branch", async () => {
  const root = sourceRepository(`export class CommandResult {
  static proof = 1;
  constructor(host: string, private proof: string) {}
}
export type Result = { proof: string } | { host: string };
`);
  expect(
    (await publicNameProblems(root, false)).map(
      (problem) => problem.split(" breaks")[0],
    ),
  ).toEqual([
    'src/public.ts:2 public declaration "proof"',
    'src/public.ts:3 public declaration "host"',
    'src/public.ts:5 public declaration "host"',
    'src/public.ts:5 public declaration "proof"',
  ]);
});

test("symbol gate checks consumed exports and their original names, and leaves unused exports alone", async () => {
  const scope = {
    exports: [],
    consumedExports: ["src/public.ts"],
    importers: ["tests/client.ts"],
  };
  const root = sourceRepository(
    "export const proof = 1;\nexport const host = 2;\n",
    scope,
  );
  put(
    root,
    "tests/client.ts",
    'import { proof as testProof } from "../src/public.ts";\n',
  );
  expect(await check(root, ["src/public.ts"])).toEqual({
    code: 1,
    stderr: refusal,
  });
  put(
    root,
    "tests/client.ts",
    'import { host as testHost } from "../src/public.ts";\n',
  );
  expect(await publicNameProblems(root, false)).toEqual([
    'src/public.ts:2 public declaration "host" breaks Qualify: uses "host" with no qualifier. Repair: add a word that says which host it is.',
  ]);
});

test("symbol gate checks named re-exports, star re-exports, namespace imports and JavaScript exports", () => {
  const texts = new Map([
    [
      "src/public.ts",
      'export { proof as testProof } from "./other.ts";\nexport * from "./more.ts";\n',
    ],
    ["src/other.ts", "export const proof = 1;\n"],
    ["src/more.ts", "export interface Result { host: string }\n"],
    ["src/javascript.mjs", "export const proof = 1;\n"],
    ["tests/client.ts", 'import * as values from "../src/javascript.mjs";\n'],
  ]);
  const declarations = publicDeclarations(repository, texts, {
    exports: ["src/public.ts"],
    consumedExports: ["src/javascript.mjs"],
    importers: ["src/*.ts", "tests/client.ts"],
  });
  expect(declarations.map(({ name }) => name)).toContain("testProof");
  expect(declarations.map(({ name }) => name)).toContain("host");
  expect(declarations.map(({ name }) => name)).toContain("proof");
  const problems = declarationProblems(
    declarations,
    readGlossary("_Qualify_: proof, host\n"),
    [],
  );
  expect(problems).toHaveLength(2);
});

test("symbol gate follows re-exports from the listed entry files into the files they re-export", async () => {
  const root = sourceRepository(
    'export * from "./other.ts";\nexport type { Result } from "./result.ts";\nexport * from "./barrel.ts";\n',
  );
  const files = {
    "src/other.ts": "export const proof = 1;\n",
    "src/result.ts": "export interface Result { host: string }\n",
    "src/barrel.ts": 'export { deep } from "./deep.ts";\n',
    "src/deep.ts": "export const deep = { proof: 1 };\n",
    "src/unrelated.ts": "export const proof = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) put(root, path, text);
  git(root, "add", "--", ...Object.keys(files));
  const expected = [
    'src/deep.ts:1 public declaration "proof"',
    'src/other.ts:1 public declaration "proof"',
    'src/result.ts:1 public declaration "host"',
  ];
  for (const staged of [false, true])
    expect(
      (await publicNameProblems(root, staged)).map(
        (problem) => problem.split(" breaks")[0],
      ),
    ).toEqual(expected);
});

test("symbol gate reads modified source from the index, including partially staged files", async () => {
  const root = sourceRepository("export const testProof = 1;\n");
  git(root, "commit", "--quiet", "-m", "source");
  put(root, "src/public.ts", "export const proof = 1;\n");
  git(root, "add", "--", "src/public.ts");
  put(root, "src/public.ts", "export const testProof = 1;\n");
  expect(
    stagedTexts(root, (path) => path === "src/public.ts").get("src/public.ts"),
  ).toBe("export const proof = 1;\n");
  expect(await check(root, ["--staged"])).toEqual({ code: 1, stderr: refusal });
  git(root, "add", "--", "src/public.ts");
  put(root, "src/public.ts", "export const proof = 1;\n");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
});

test("symbol gate reads its public surface, glossary and recorded hits from the index", async () => {
  const root = sourceRepository("export const proof = 1;\n");
  put(
    root,
    publicSurfaceFile,
    JSON.stringify({ exports: [], consumedExports: [], importers: [] }),
  );
  put(root, "GLOSSARY.md", "_Qualify_: none\n");
  put(
    root,
    recordedHitsFile,
    JSON.stringify({
      hits: [
        {
          path: "src/public.ts",
          declaration: "proof",
          word: "proof",
          reason: "fixture",
        },
      ],
    }),
  );
  expect(await check(root, ["--staged"])).toEqual({ code: 1, stderr: refusal });
});

test("symbol gate runs in the hosted --against check too", async () => {
  const root = sourceRepository("export const proof = 1;\n");
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  git(root, "add", "--", recordedUnusedTermsFile);
  git(root, "commit", "--quiet", "-m", "source");
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: refusal,
  });
});

test("symbol gate recorded hits name a declaration independently of its line and cannot admit sibling names", async () => {
  const root = sourceRepository(
    "\nexport const proof = 1;\nexport function execute(proof: string) {}\n",
  );
  const record = {
    path: "src/public.ts",
    declaration: "proof",
    word: "proof",
    reason: "fixture",
    approved: "Symbol gate (template)",
  };
  put(root, recordedHitsFile, JSON.stringify({ hits: [record] }));
  expect(
    readRecordedHits(readFileSync(join(root, recordedHitsFile), "utf8")),
  ).toEqual([
    {
      path: record.path,
      declaration: record.declaration,
      word: record.word,
      reason: record.reason,
    },
  ]);
  expect(await publicNameProblems(root, false, undefined, true)).toHaveLength(
    1,
  );
  put(root, "src/public.ts", "export const testProof = 1;\n");
  expect(await publicNameProblems(root, false, undefined, true)).toEqual([
    `${recordedHitsFile} records "proof" in src/public.ts declaration proof, which no longer occurs. Repair: remove the recorded hit.`,
  ]);
  put(
    root,
    publicSurfaceFile,
    JSON.stringify({ exports: [], consumedExports: [], importers: [] }),
  );
  expect(await publicNameProblems(root, false, undefined, true)).toEqual([
    `${recordedHitsFile} records "proof" in src/public.ts declaration proof, which no longer occurs. Repair: remove the recorded hit.`,
  ]);
});

test("symbol gate requires approval for a new declaration record at an already recorded path", async () => {
  const root = sourceRepository("export const proof = 1;\n");
  const pathHit = { path: "src/public.ts", word: "proof", reason: "fixture" };
  put(root, recordedHitsFile, JSON.stringify({ hits: [pathHit] }));
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  git(root, "add", "--", recordedHitsFile, recordedUnusedTermsFile);
  git(root, "commit", "--quiet", "-m", "source");
  const declarationHit = { ...pathHit, declaration: "proof" };
  put(root, recordedHitsFile, JSON.stringify({ hits: [declarationHit] }));
  const refused = await check(root, ["--against", "HEAD"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toStartWith(
    `${recordedHitsFile} adds a recorded hit for "proof" in src/public.ts declaration proof,`,
  );
  put(
    root,
    recordedHitsFile,
    JSON.stringify({
      hits: [{ ...declarationHit, approved: "Symbol gate (template)" }],
    }),
  );
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });
});

test("symbol gate refuses an empty declaration identity in a recorded hit", () => {
  expect(() =>
    readRecordedHits(
      JSON.stringify({
        hits: [
          {
            path: "src/public.ts",
            word: "proof",
            reason: "fixture",
            declaration: "",
          },
        ],
      }),
    ),
  ).toThrow(
    `${recordedHitsFile}: declaration needs a non-empty string. Repair: name the public declaration, or omit declaration for a file or folder hit.`,
  );
});

test("symbol gate refuses missing surface files and malformed surface records", async () => {
  expect(() => readPublicSurface("{}")).toThrow(
    `${publicSurfaceFile} needs a "exports" array of non-empty glob patterns. Repair: list the public surface's files.`,
  );
  const root = sourceRepository("export const testProof = 1;\n", {
    ...surface,
    exports: ["src/missing.ts"],
  });
  expect(await check(root, ["--staged"])).toEqual({
    code: 2,
    stderr: `${publicSurfaceFile}: "src/missing.ts" matches no file. Repair: restore its source files or update the public surface.\n`,
  });
});

test("symbol gate is reachable through the production names check entry", async () => {
  const root = await fixtureRepository();
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  put(root, publicSurfaceFile, JSON.stringify(surface));
  put(root, "src/public.ts", "export const proof = 1;\n");
  await runFixtureGit(root, "add", "--", publicSurfaceFile, "src/public.ts");
  expect(await checkNames(root, ["--staged"])).toMatchObject({
    exit: 1,
    stderr: refusal,
  });
});

test("the template public surface follows Bootstrap's copied code and consumed src exports", () => {
  const { surface: actual, texts } = surfaceTexts(repository, false);
  expect(actual.consumedExports).toEqual(["src/*.ts"]);
  expect(actual.importers).toEqual([
    "src/**/*.ts",
    "scripts/**/*.ts",
    "tests/**/*.ts",
  ]);
  const copied = KERNEL_RECIPE.copies
    .flatMap(({ from, only }) => {
      if (only !== undefined)
        return only
          .filter((path) => /\.(?:ts|mjs)$/.test(path))
          .map((path) => `${from}/${path}`);
      return [
        ...new Bun.Glob(`${from}/**/*.{ts,mjs}`).scanSync({
          cwd: repository,
          onlyFiles: true,
        }),
      ];
    })
    .sort();
  const declared = [...texts.keys()]
    .filter((path) =>
      actual.exports.some((pattern) => new Bun.Glob(pattern).match(path)),
    )
    .sort();
  expect(declared).toEqual(copied);
  expect(declared.filter((path) => path.startsWith("config/"))).toHaveLength(
    LINT_RULE_FILES.length,
  );
});

test("every public declaration in the template uses glossary words", async () => {
  expect(await publicNameProblems(repository, false, undefined, true)).toEqual(
    [],
  );
});
