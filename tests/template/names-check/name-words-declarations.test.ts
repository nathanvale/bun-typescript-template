import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  keptByRenames,
  keptMoveTargets,
  newPathItems,
  parseNameStatus,
} from "../../../scripts/name-moves.ts";
import { publicSurfaceFile } from "../../../scripts/public-surface.ts";
import { git } from "../../support/git-fixture.ts";
import {
  check,
  namesCheckFixture,
  put,
  samplePlainWords,
  unknownDeclarationLine,
  unknownPathLine,
} from "./names-check-fixture.ts";

const { plainWordsRepository } = namesCheckFixture();

test("replacing an existing default export with a newly named default export is refused while an existing named default export stays untouched", async () => {
  const sharedBody = [
    "const plantedFault = 'long enough for git rename detection';",
    "export const apply = plantedFault;",
  ].join("\n");
  const root = plainWordsRepository(samplePlainWords, {
    "src/apply-pattern.ts": `${sharedBody}\nexport default {};\n`,
    "src/seam.ts": `${sharedBody}\nexport default function gizmoWidget() {\n  return 1;\n}\n`,
  });

  put(
    root,
    "src/seam.ts",
    `\n${sharedBody}\nexport default function gizmoWidget() {\n  return 2;\n}\n`,
  );
  expect(await check(root, ["src/seam.ts"])).toEqual({ code: 0, stderr: "" });
  git(root, "add", "--", "src/seam.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });

  git(root, "mv", "src/seam.ts", "src/pattern-apply.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });

  put(
    root,
    "src/apply-pattern.ts",
    `${sharedBody}\nexport default function gizmoWidget() {}\n`,
  );
  const expected = [
    unknownDeclarationLine("src/apply-pattern.ts", 3, "gizmoWidget", "gizmo"),
    unknownDeclarationLine("src/apply-pattern.ts", 3, "gizmoWidget", "widget"),
    "",
  ].join("\n");

  expect(await check(root, ["src/apply-pattern.ts"])).toEqual({
    code: 1,
    stderr: expected,
  });

  git(root, "add", "--", "src/apply-pattern.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: expected,
  });

  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: expected,
  });

  git(root, "mv", "src/apply-pattern.ts", "src/pattern.ts");
  const renamedExpected = [
    unknownDeclarationLine("src/pattern.ts", 3, "gizmoWidget", "gizmo"),
    unknownDeclarationLine("src/pattern.ts", 3, "gizmoWidget", "widget"),
    "",
  ].join("\n");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: renamedExpected,
  });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: renamedExpected,
  });

  git(root, "commit", "--quiet", "-m", "replace default export");
  expect(await check(root, ["--against", "HEAD~1"])).toEqual({
    code: 1,
    stderr: renamedExpected,
  });
});

test("an existing folder, file and exported symbol with a non-glossary word still pass", async () => {
  const root = plainWordsRepository(samplePlainWords, {
    "src/gizmo-folder/gizmo.ts": "export const gizmoWidget = 1;\n",
    "src/gizmo.ts": "export const gizmoWidget = 1;\n",
  });
  expect(
    await check(root, ["src/gizmo-folder/gizmo.ts", "src/gizmo.ts"]),
  ).toEqual({ code: 0, stderr: "" });

  put(
    root,
    "src/gizmo.ts",
    "\nexport const gizmoWidget = 1;\nexport const applyPattern = 2;\n",
  );
  git(root, "add", "--", "src/gizmo.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });
});

test("a renamed path keeping its last segment is not judged again, while a renamed word or delete-plus-add is refused", async () => {
  const body =
    "export const gizmoWidget = 1;\nexport const plantedFault = 2;\nexport const record = 'long enough for git rename detection';\n";
  const root = plainWordsRepository(samplePlainWords, {
    "src/old-folder/gizmo.ts": body,
    "src/removed-folder/kept.ts": "export const a = 1;\n",
  });
  mkdirSync(join(root, "src/seam"), { recursive: true });
  git(root, "mv", "src/old-folder/gizmo.ts", "src/seam/gizmo.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });

  git(root, "mv", "src/seam/gizmo.ts", "src/seam/widget.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: `${unknownPathLine("src/seam/widget.ts", "widget")}\n`,
  });

  git(root, "mv", "src/seam/widget.ts", "src/seam/gizmo.ts");
  git(root, "rm", "--quiet", "--", "src/removed-folder/kept.ts");
  put(root, "src/seam/removed-folder/apply.ts", "export const apply = 1;\n");
  git(root, "add", "--", "src/seam/removed-folder/apply.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/seam/removed-folder", "removed"),
      unknownPathLine("src/seam/removed-folder", "folder"),
      "",
    ].join("\n"),
  });
});

test("apply_patch Move to keeping its basename passes while moving to an unknown name is refused", async () => {
  const root = plainWordsRepository(samplePlainWords, {
    "src/gizmo.ts": "export const gizmoWidget = 1;\n",
  });
  const keepPatch = [
    "*** Begin Patch",
    "*** Update File: src/gizmo.ts",
    "*** Move to: src/seam/gizmo.ts",
    "@@",
    "-export const gizmoWidget = 1;",
    "+export const gizmoWidget = 2;",
    "*** End Patch",
  ].join("\n");
  expect(
    keptMoveTargets(
      "apply_patch",
      new Map([["command", keepPatch]]),
      root,
      root,
    ).has("src/seam/gizmo.ts"),
  ).toBe(true);
  expect(
    await check(root, ["--tool-call"], () =>
      Promise.resolve(
        JSON.stringify({
          tool_name: "apply_patch",
          tool_input: { command: keepPatch },
        }),
      ),
    ),
  ).toEqual({ code: 0, stderr: "" });

  const renamePatch = keepPatch.replace(
    "src/seam/gizmo.ts",
    "src/seam/widget.ts",
  );
  expect(
    await check(root, ["--tool-call"], () =>
      Promise.resolve(
        JSON.stringify({
          tool_name: "apply_patch",
          tool_input: { command: renamePatch },
        }),
      ),
    ),
  ).toEqual({
    code: 1,
    stderr: `${unknownPathLine("src/seam/widget.ts", "widget")}\n`,
  });
});

test("apply_patch Move to exempts moved ancestor folders while still judging genuinely new folder names", async () => {
  const root = plainWordsRepository(samplePlainWords, {
    "src/gizmo/apply.ts": "export const apply = 1;\n",
  });
  const keepFolderPatch = [
    "*** Begin Patch",
    "*** Update File: src/gizmo/apply.ts",
    "*** Move to: src/seam/gizmo/apply.ts",
    "@@",
    "-export const apply = 1;",
    "+export const apply = 2;",
    "*** End Patch",
  ].join("\n");
  expect(
    keptByRenames([
      { from: "src/gizmo/apply.ts", to: "src/seam/gizmo/apply.ts" },
    ]),
  ).toEqual(new Set(["src", "src/seam/gizmo", "src/seam/gizmo/apply.ts"]));
  const parsedMove = parseNameStatus([
    "R100",
    "src/gizmo/apply.ts",
    "src/seam/gizmo/apply.ts",
  ]);
  expect(
    newPathItems(parsedMove.added, parsedMove.renames, new Set(["src"]))
      .unkeptNew,
  ).toEqual([{ path: "src/seam", isFile: false }]);
  expect(
    await check(root, ["--tool-call"], () =>
      Promise.resolve(
        JSON.stringify({
          tool_name: "apply_patch",
          tool_input: { command: keepFolderPatch },
        }),
      ),
    ),
  ).toEqual({ code: 0, stderr: "" });

  const newFolderPatch = keepFolderPatch.replace(
    "src/seam/gizmo/apply.ts",
    "src/widget/gizmo/apply.ts",
  );
  expect(
    await check(root, ["--tool-call"], () =>
      Promise.resolve(
        JSON.stringify({
          tool_name: "apply_patch",
          tool_input: { command: newFolderPatch },
        }),
      ),
    ),
  ).toEqual({
    code: 1,
    stderr: `${unknownPathLine("src/widget", "widget")}\n`,
  });
});

test("explicit-path checks apply git rename exemptions to moved files, moved folders, and existing declarations", async () => {
  const body =
    "export const gizmoWidget = 1;\nexport const plantedFault = 2;\nexport const record = 'long enough for git rename detection';\n";
  const root = plainWordsRepository(samplePlainWords, {
    [publicSurfaceFile]: JSON.stringify({
      exports: ["src/**/*.ts"],
      consumedExports: [],
      importers: [],
    }),
    "src/old/gizmo.ts": body,
    "src/old/gizmo-folder/apply.ts": body,
  });
  mkdirSync(join(root, "src/seam/gizmo-folder"), { recursive: true });
  git(root, "mv", "src/old/gizmo.ts", "src/seam/gizmo.ts");
  git(
    root,
    "mv",
    "src/old/gizmo-folder/apply.ts",
    "src/seam/gizmo-folder/apply.ts",
  );
  expect(await check(root, ["src/seam/gizmo.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(root, ["src/seam/gizmo-folder/apply.ts"])).toEqual({
    code: 0,
    stderr: "",
  });

  put(root, "src/seam/gizmo.ts", `${body}export const widget = 3;\n`);
  expect(await check(root, ["src/seam/gizmo.ts"])).toEqual({
    code: 1,
    stderr: `${unknownDeclarationLine("src/seam/gizmo.ts", 4, "widget", "widget")}\n`,
  });
});

test("Avoid and Qualify refusals keep their own lines and suppress duplicate unknown-word lines", async () => {
  const root = plainWordsRepository();
  expect(await check(root, ["src/allowlist.ts", "src/host.ts"])).toEqual({
    code: 1,
    stderr: [
      'src/allowlist.ts uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.',
      'src/host.ts uses "host" with no qualifier. Repair: add a word that says which host it is.',
      "",
    ].join("\n"),
  });

  put(
    root,
    "src/planted-fault.ts",
    "export const plantedFault = 1;\nexport const allowlistWidget = 2;\n",
  );
  expect(await check(root, ["src/planted-fault.ts"])).toEqual({
    code: 1,
    stderr: [
      'src/planted-fault.ts:2 public declaration "allowlistWidget" breaks Avoid: uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.',
      unknownDeclarationLine(
        "src/planted-fault.ts",
        2,
        "allowlistWidget",
        "widget",
      ),
      "",
    ].join("\n"),
  });

  put(root, "src/known-hit.ts", "export const knownHit = 1;\n");
  const against = await check(root, ["--against", "HEAD"]);
  expect(against.code).toBe(1);
  expect(against.stderr).toContain(
    'src/known-hit.ts uses "known hit", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.',
  );
  expect(against.stderr).not.toContain('src/known-hit.ts uses "known"');
});
