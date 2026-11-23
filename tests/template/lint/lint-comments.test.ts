import { expect, test } from "bun:test";
import {
  commentCases,
  commentRepairs,
  directiveCases,
} from "../../support/lint-comment-cases.ts";
import {
  hits,
  messages,
  templateSourceFile,
} from "../../support/template-lint.ts";

const REPAIR =
  "say this in code (a clearer name, a type, a test title, or a lint rule whose message states the constraint), then delete the comment.";

for (const [filePath, code, lines] of [...commentCases, ...directiveCases])
  test(`no-comments ${lines.length > 0 ? "refuses" : "admits"} ${JSON.stringify(code)} in ${filePath}`, async () => {
    const found = (await messages(filePath, code)).filter(
      ({ ruleId }) => ruleId === null || ruleId === "repository/no-comments",
    );
    expect([...new Set(found.map(({ line }) => line))]).toEqual([...lines]);
    expect(
      found.filter(
        ({ ruleId, message }) => ruleId && !message.includes(REPAIR),
      ),
    ).toEqual([]);
  });

for (const [code, repair] of commentRepairs)
  test(`no-comments tells the agent to ${repair} for ${JSON.stringify(code)}`, async () => {
    const found = await hits("no-comments", templateSourceFile, code);
    expect(found.map(({ message }) => message.includes(repair))).toEqual([
      true,
    ]);
  });

test.each(["tests/fixtures/cli.ts.txt", "config/template-rules.d.mts"])(
  "no-comments refuses a comment in %s, which the template lints",
  async (filePath) => {
    const found = await messages(filePath, "// Note.\nexport {};\n");
    expect(found.map(({ ruleId, line }) => [ruleId, line])).toEqual([
      ["repository/no-comments", 1],
    ]);
  },
);
