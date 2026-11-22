import { expect, test } from "bun:test";
import { readGlossary } from "../../../scripts/glossary.ts";
import {
  blockedBaseWords,
  matchesWord,
  readNameWords,
  segmentWords,
  unknownPathProblems,
} from "../../../scripts/plain-words.ts";
import { git } from "../../support/git-fixture.ts";
import { repository } from "./fixture-tree.ts";
import {
  avoidPathLine,
  check,
  glossary,
  namesCheckFixture,
  put,
  samplePlainWords,
  unknownDeclarationLine,
  unknownPathLine,
} from "./names-check-fixture.ts";

const { plainWordsRepository } = namesCheckFixture();

test("NW.e leading calendar date prefixes on filenames are not judged while the slug and non-prefix dates are", async () => {
  const datedGlossary = `${glossary}\n**Change note**:\nA dated record.\n\n**Template upgrade**:\nA planned move.\n`;
  const parsed = readGlossary(datedGlossary);
  const words = readNameWords(datedGlossary, samplePlainWords);
  expect(
    segmentWords("change-notes/2026-11-22-template-upgrade.json", true),
  ).toEqual(["template", "upgrade"]);
  expect(matchesWord(words.known, "upgrades")).toBe(true);
  expect(blockedBaseWords(words.avoidTerms, datedGlossary).has("proof")).toBe(
    true,
  );
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "change-notes/2026-11-22-template-upgrade.json",
        isFile: true,
      },
      {
        path: "change-notes/2024-02-29-template-upgrade.json",
        isFile: true,
      },
    ]),
  ).toEqual([]);
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "change-notes/2026-11-22-gizmo.json",
        isFile: true,
      },
    ]),
  ).toEqual([unknownPathLine("change-notes/2026-11-22-gizmo.json", "gizmo")]);
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "notes-2026-11-22.json",
        isFile: true,
      },
    ]),
  ).toEqual([
    unknownPathLine("notes-2026-11-22.json", "2026"),
    unknownPathLine("notes-2026-11-22.json", "11"),
    unknownPathLine("notes-2026-11-22.json", "22"),
  ]);
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "change-notes/2026-02-29-template-upgrade.json",
        isFile: true,
      },
      {
        path: "change-notes/2026-13-01-template-upgrade.json",
        isFile: true,
      },
      {
        path: "change-notes/2026-11-22.json",
        isFile: true,
      },
      {
        path: "change-notes/2026-11-22-template-upgrade",
        isFile: false,
      },
      {
        path: "change-notes/2026-11-22-.json",
        isFile: true,
      },
      {
        path: "change-notes/2026-11-22-2026-11-23-template-upgrade.json",
        isFile: true,
      },
    ]),
  ).toEqual([
    unknownPathLine("change-notes/2026-02-29-template-upgrade.json", "2026"),
    unknownPathLine("change-notes/2026-02-29-template-upgrade.json", "02"),
    unknownPathLine("change-notes/2026-02-29-template-upgrade.json", "29"),
    unknownPathLine("change-notes/2026-13-01-template-upgrade.json", "2026"),
    unknownPathLine("change-notes/2026-13-01-template-upgrade.json", "13"),
    unknownPathLine("change-notes/2026-13-01-template-upgrade.json", "01"),
    unknownPathLine("change-notes/2026-11-22.json", "2026"),
    unknownPathLine("change-notes/2026-11-22.json", "11"),
    unknownPathLine("change-notes/2026-11-22.json", "22"),
    unknownPathLine("change-notes/2026-11-22-template-upgrade", "2026"),
    unknownPathLine("change-notes/2026-11-22-template-upgrade", "11"),
    unknownPathLine("change-notes/2026-11-22-template-upgrade", "22"),
    unknownPathLine("change-notes/2026-11-22-.json", "2026"),
    unknownPathLine("change-notes/2026-11-22-.json", "11"),
    unknownPathLine("change-notes/2026-11-22-.json", "22"),
    unknownPathLine(
      "change-notes/2026-11-22-2026-11-23-template-upgrade.json",
      "2026",
    ),
    unknownPathLine(
      "change-notes/2026-11-22-2026-11-23-template-upgrade.json",
      "11",
    ),
    unknownPathLine(
      "change-notes/2026-11-22-2026-11-23-template-upgrade.json",
      "23",
    ),
  ]);

  const root = plainWordsRepository();
  put(root, "GLOSSARY.md", datedGlossary);
  git(root, "add", "--", "GLOSSARY.md");
  git(root, "commit", "--quiet", "-m", "dated glossary");
  expect(
    await check(root, ["change-notes/2026-11-22-template-upgrade.json"]),
  ).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["change-notes/2026-11-22-gizmo.json"])).toEqual({
    code: 1,
    stderr: `${unknownPathLine("change-notes/2026-11-22-gizmo.json", "gizmo")}\n`,
  });
  expect(await check(root, ["notes-2026-11-22.json"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("notes-2026-11-22.json", "2026"),
      unknownPathLine("notes-2026-11-22.json", "11"),
      unknownPathLine("notes-2026-11-22.json", "22"),
      "",
    ].join("\n"),
  });
});

test("NW.f parameters, object fields, type members and local names with a new word are not judged while a new exported symbol with the same word is", async () => {
  const root = plainWordsRepository();
  const safeExports = [
    "export const plantedFault = 1;",
    "export type PatternSeam = { readonly gizmoMember: string };",
    "export const applySeam = { gizmoField: 1 };",
    "export function applyPattern(gizmoParam: string) {",
    "  const gizmoLocal = gizmoParam;",
    "  return { gizmoReturn: gizmoLocal };",
    "}",
    "",
  ].join("\n");
  put(root, "src/planted-fault.ts", safeExports);
  expect(await check(root, ["src/planted-fault.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  git(root, "add", "--", "src/planted-fault.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });

  put(
    root,
    "src/planted-fault.ts",
    `${safeExports}export const gizmoParam = 2;\n`,
  );
  const expected = [
    unknownDeclarationLine("src/planted-fault.ts", 8, "gizmoParam", "gizmo"),
    unknownDeclarationLine("src/planted-fault.ts", 8, "gizmoParam", "param"),
    "",
  ].join("\n");
  expect(await check(root, ["src/planted-fault.ts"])).toEqual({
    code: 1,
    stderr: expected,
  });
  git(root, "add", "--", "src/planted-fault.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: expected,
  });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: expected,
  });
});

test("NW.g base-branch words pass in new names while Avoid and Qualify words never leak from base", async () => {
  const leakGlossary = `${glossary}
**Template**:
The repository owner.

**Hosted check**:
Forge checks.
_Avoid_: CI (unqualified)

**Gate**:
A validation check.
_Avoid_: proof, admission, guard (for a gate), check (unqualified)
`;
  const root = plainWordsRepository(samplePlainWords, {
    "GLOSSARY.md": leakGlossary,
    ".github/workflows/ci.yml": "name: Hosted check\n",
    "docs/standards/test-proof.md": "# Test proof\n",
    "tests/planted-faults/patches/927f750-symbol-gate-recorded-approval.patch":
      "diff --git a/a b/a\n",
    "tests/planted-faults/patches/016b761-kernel-reader-none-helper.patch":
      "diff --git a/a b/a\n",
    "src/apply.ts": "export const applyToken = 1;\n",
  });

  expect(await check(root, ["src/recorded-approval.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(root, ["src/template-helper.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(root, ["src/template-token.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(root, ["src/ci.ts"])).toEqual({
    code: 1,
    stderr: `${avoidPathLine("src/ci.ts", "ci", "Hosted check")}\n`,
  });
  expect(await check(root, ["src/gate-proof.ts"])).toEqual({
    code: 1,
    stderr: `${avoidPathLine("src/gate-proof.ts", "proof", "Gate")}\n`,
  });
  expect(await check(root, ["src/proof.ts"])).toEqual({
    code: 1,
    stderr:
      'src/proof.ts uses "proof" with no qualifier. Repair: add a word that says which proof it is.\n',
  });

  put(root, "src/recorded-approval.ts", "export const apply = 1;\n");
  put(root, "src/template-helper.ts", "export const apply = 1;\n");
  git(root, "add", "--", "src/recorded-approval.ts", "src/template-helper.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });

  put(root, "src/ci.ts", "export const apply = 1;\n");
  put(root, "src/gate-proof.ts", "export const apply = 1;\n");
  git(root, "add", "--", "src/ci.ts", "src/gate-proof.ts");
  const expectedLeaks = [
    avoidPathLine("src/ci.ts", "ci", "Hosted check"),
    avoidPathLine("src/gate-proof.ts", "proof", "Gate"),
    "",
  ].join("\n");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: expectedLeaks,
  });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: expectedLeaks,
  });

  expect(await check(repository, ["src/recorded-approval.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(repository, ["src/template-helper.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await check(repository, ["src/ci.ts"])).toEqual({
    code: 1,
    stderr: `${avoidPathLine("src/ci.ts", "ci", "Hosted check")}\n`,
  });
  expect(await check(repository, ["src/gate-proof.ts"])).toEqual({
    code: 1,
    stderr: `${avoidPathLine("src/gate-proof.ts", "proof", "Gate")}\n`,
  });
  expect(await check(repository, ["src/gizmo-tools/gizmo.ts"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/gizmo-tools", "gizmo"),
      unknownPathLine("src/gizmo-tools/gizmo.ts", "gizmo"),
      "",
    ].join("\n"),
  });
});
