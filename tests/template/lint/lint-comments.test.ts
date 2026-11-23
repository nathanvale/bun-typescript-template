import { expect, test } from "bun:test";
import {
  commentCases,
  commentRepairs,
} from "../../support/lint-comment-cases.ts";
import { hits, templateSourceFile } from "../../support/template-lint.ts";

for (const [filePath, code, lines] of commentCases)
  test(`no-comments ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = await hits("no-comments", filePath, code);
    expect(found.map(({ line }) => line)).toEqual([...lines]);
    for (const { message } of found)
      expect(message).toContain(
        "say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.",
      );
  });

for (const [code, repair] of commentRepairs)
  test(`no-comments tells the agent to ${repair} for ${JSON.stringify(code)}`, async () => {
    const found = await hits("no-comments", templateSourceFile, code);
    expect(found.map(({ message }) => message.includes(repair))).toEqual([
      true,
    ]);
  });
