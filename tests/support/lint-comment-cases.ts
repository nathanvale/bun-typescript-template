import { templateSourceFile } from "./template-lint.ts";

export const commentCases = [
  [templateSourceFile, "// Loop over the names.\nexport const a = 1;", [1]],
  [
    templateSourceFile,
    "// A workaround until the parser is fixed:\n// it drops the last token.\nexport const a = 1;",
    [1],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "/* Narration */ export const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "/** Adds one. */\nexport const add = (n: number) => n + 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Note.\n// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [1],
  ],
  [templateSourceFile, "export const a = 1; // trailing narration", [1]],
  [
    templateSourceFile,
    "// Note.\n// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [1],
  ],
  [templateSourceFile, "// SAFETY:\nconst x = y as Foo;", [1]],
  [templateSourceFile, "// SAFETY: nothing here is cast.\nconst x = y;", [1]],
  [
    templateSourceFile,
    "// SAFETY: a const assertion needs no proof.\nconst x = y as const;",
    [1],
  ],
  [
    templateSourceFile,
    "// SAFETY: a blank line detaches this from the cast.\n\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "const a = 1; // SAFETY: trailing the previous line.\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "// SAFETY: the cast is two statements down.\nconst a = 1;\nconst x = y as Foo;",
    [1],
  ],
  [
    templateSourceFile,
    "// platform: lower case is not the marker\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Platform: Avoid collisions even when the parser normalizes escaped literal text.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Platform: Resolved, so fileSeparation judges real directories.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Platform: the lint-view parser overflows its stack\n// on deep nesting.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// This follows an accepted decision.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// The station (accepted decisions of 17:06 and 17:24, form H)\n// declares the ruled words.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Accepted decision (Nathan, in chat): keep the loop.\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    [1],
  ],
  [
    templateSourceFile,
    "// eslint-disable-next-line no-console --\nconsole.log(1);",
    [1],
  ],
  [templateSourceFile, "/* eslint no-console: off */\nconsole.log(1);", [1]],
  [
    templateSourceFile,
    "// @ts-expect-error\nexport const a: number = '1';",
    [1],
  ],
  [
    templateSourceFile,
    "// biome-ignore lint/style/useConst:\nexport let a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// fallow-ignore-next-line unused-export\nexport const a = 1;",
    [1],
  ],
  [
    templateSourceFile,
    "// Platform: Bun drains spawn pipes.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: EPERM is another user's live process; only ESRCH\n// proves it is gone.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: <sys/file.h> LOCK_EX LOCK_NB\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: A Map keeps names such as __proto__ as data.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: Every object type resolves the Object.prototype members.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: existsSync follows a symlink; lstatSync reads the link.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: a write follows a symbolic link at the path.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Platform: Both compilers skip type checking when a file fails to parse.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Interface: a host passes the descriptor\n// to contractFor.\nexport const a = 1;",
    [],
  ],
  [
    "tests/template/doctor/doctor.test.ts",
    "// The accepted\n// decision N4a keeps the line on stdout.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Accepted decision (Nathan, 19 November 2026, 12:08 AEDT): at most\n// 64 moves per hold.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// Accepted decision (Command Contract 3 question 4): the summary is\n// any proof the add-on issued.\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// O_CLOEXEC is set here (accepted decision BN-03).\nexport const a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// eslint-disable-next-line no-console -- the CLI prints its result\nconsole.log(1);",
    [],
  ],
  [
    templateSourceFile,
    "/* eslint no-console: off -- the CLI prints its result */\nconsole.log(1);",
    [],
  ],
  [
    templateSourceFile,
    "// @ts-expect-error the fixture passes a string\nexport const a: number = '1';",
    [],
  ],
  [
    templateSourceFile,
    "// biome-ignore lint/style/useConst: the binding is reassigned in a test\nexport let a = 1;",
    [],
  ],
  [
    templateSourceFile,
    "// fallow-ignore-next-line unused-export -- a host imports it by name\nexport const a = 1;",
    [],
  ],
  [templateSourceFile, "// eslint-enable no-console\nexport const a = 1;", []],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape.\nconst x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "export function f(y: unknown) {\n  // SAFETY: the caller passes a Foo.\n  return y as Foo;\n}",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape.\nexport const x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the parser checked the shape,\n// so every key is present.\nconst x = y as Foo;",
    [],
  ],
  [
    templateSourceFile,
    "// SAFETY: the cast sits in the second argument.\nconsole.log(1, y as Foo);",
    [],
  ],
  [
    templateSourceFile,
    'export const text = "// not a comment";\nexport const tpl = `/* nor this */`;',
    [],
  ],
] as const;

export const commentRepairs = [
  ["// Loop over the names.\nexport const a = 1;", "Repair: say this in code"],
  [
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    "give the reason after the directive",
  ],
  [
    "// This follows an accepted decision.\nexport const a = 1;",
    "cite the decision by its id or ruling date",
  ],
  [
    "// Platform: Avoid collisions when the parser normalizes text.\nexport const a = 1;",
    "name the platform or tool the fact belongs to",
  ],
] as const;
