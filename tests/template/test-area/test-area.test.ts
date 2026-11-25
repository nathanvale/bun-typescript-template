import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { testArea } from "../../../scripts/test-area.ts";
import { testRunFiles } from "../../support/fixture-files.ts";
import { testFolder } from "../../support/test-folder.ts";

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

const ledgerName = "ran.log";

function probe(name: string, body = ""): string {
  return probeCases([name], body);
}

function probeCases(names: string[], body = ""): string {
  const cases = names
    .map(
      (name) => `test("${name} case", () => {
  appendFileSync(join(process.cwd(), "${ledgerName}"), "${name}\\n");
${body}});
`,
    )
    .join("");
  return `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
${cases}`;
}

const toolchain: Record<string, string> = {
  "node_modules/typescript-eslint/package.json":
    '{"name":"typescript-eslint","main":"index.js"}',
  "node_modules/typescript-eslint/index.js": "module.exports = {};",
  "node_modules/typescript/package.json":
    '{"name":"typescript","version":"6.0.2","main":"index.js"}',
  "node_modules/typescript/index.js": 'module.exports = { version: "6.0.2" };',
  "node_modules/@typescript/native/package.json": '{"version":"7.1.0-beta"}',
  "node_modules/fallow-type-aware/package.json":
    '{"name":"fallow-type-aware","version":"3.43.2"}',
  "node_modules/fallow-type-aware/node_modules/typescript/package.json":
    '{"version":"7.0.2"}',
  "node_modules/.bin/tsc": "#!/bin/sh\necho 'Version 7.1.0-beta'\n",
  "node_modules/.bin/fallow":
    '#!/bin/sh\necho \'{"status":"pass","checks":[]}\'\n',
};

function description(testAreas: object[]): string {
  return JSON.stringify({
    web: "https://github.com/owner/fixture",
    checkCommitsSince: "0123456789abcdef0123456789abcdef01234567",
    testAreas,
  });
}

const declared = [
  { name: "template", folder: "tests", holds: "files" },
  {
    name: "kernel",
    folder: "tests/kernel",
    holds: "files",
    subfolders: true,
  },
];

const files: Record<string, string> = {
  "repository.json": description(declared),
  "tests/kernel/probe/probe.test.ts": probeCases([
    "probe-chosen",
    "probe-other",
  ]),
  "tests/kernel/probe-seam.test.ts": probe("seam"),
  "tests/first.test.ts": probe("first"),
  "tests/second.test.ts": probe("second"),
  "tests/helper.ts": probe("helper"),
  "tests/notatest.ts": probe("notatest"),
};

function rootWith(
  extra: Record<string, string> = {},
  pin: string | null = Bun.version,
): string {
  const root = testFolder("test-area-");
  folders.push(root);
  const written = {
    ...toolchain,
    ...testRunFiles(),
    ...(pin === null ? {} : { "package.json": packageManifest(pin) }),
    ...files,
    ...extra,
  };
  for (const [path, content] of Object.entries(written)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const binary of ["tsc", "fallow"])
    chmodSync(join(root, "node_modules/.bin", binary), 0o755);
  return root;
}

function packageManifest(pin: string): string {
  return JSON.stringify({ packageManager: `bun@${pin}` });
}

function ran(root: string): string[] {
  const ledger = join(root, ledgerName);
  return existsSync(ledger)
    ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).sort()
    : [];
}

async function captured(run: () => Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const exitCode = await run();
    return { exitCode, stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("testArea", () => {
  test("an unknown area returns 2 and lists the areas found on disk, sorted", async () => {
    const root = rootWith();
    const result = await captured(() => testArea(root, ["nope"]));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      'Usage: bun run test:area <area> [bun test options]. Unknown area "nope". Valid areas: kernel, probe, template.\n',
    );
    expect(result.stdout).toBe("");
    expect(ran(root)).toEqual([]);
  });

  test("no area given returns 2 and says so", async () => {
    const root = rootWith();
    const result = await captured(() => testArea(root, []));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      "Usage: bun run test:area <area> [bun test options]. No area given. Valid areas: kernel, probe, template.\n",
    );
  });

  test("an area runs only its own folder, from the root, and passes options to bun test", async () => {
    const root = rootWith();
    const result = await captured(() =>
      testArea(root, ["probe", "-t", "probe-chosen"]),
    );

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["probe-chosen"]);
    expect(result.stdout).toContain(`ok bun: Bun ${Bun.version} matches`);
    expect(result.stdout).toContain("ok toolchain: ");
    expect(result.stdout).toContain("ok fallow: fallow doctor passes.");
  });

  test("the template area runs only the test files directly under its folder", async () => {
    const root = rootWith();
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["first", "second"]);
  });

  test("a folder area never runs a sibling file whose name starts with its own", async () => {
    const root = rootWith();
    const result = await captured(() => testArea(root, ["probe"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["probe-chosen", "probe-other"]);
  });

  test("the kernel area runs its own files and not its subfolders", async () => {
    const root = rootWith();
    const result = await captured(() => testArea(root, ["kernel"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["seam"]);
  });

  test("a directory named like a test file is not run as one", async () => {
    const root = rootWith({
      "tests/folder.test.ts/inside.test.ts": probe("inside"),
    });
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["first", "second"]);
  });

  test("a folder area runs every test file under it, at any depth", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "deep", folder: "tests/deep", holds: "folder" },
      ]),
      "tests/deep/a/b/c.test.ts": probe("c"),
      "tests/deep/top.test.ts": probe("top"),
      "tests/deep/a/skip.ts": probe("skip"),
    });
    const result = await captured(() => testArea(root, ["deep"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["c", "top"]);
  });

  test("a declared area whose folder is missing fails, naming it, and runs nothing", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "lost", folder: "tests/lost", holds: "folder" },
      ]),
    });
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json has test areas with no test file: lost (tests/lost). Repair: restore their tests, or remove them from testAreas.\n",
    );
    expect(result.stdout).toBe("");
    expect(ran(root)).toEqual([]);
  });

  test("a files area whose folder is missing fails, naming it", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "gone", folder: "tests/gone", holds: "files" },
      ]),
    });
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "lost".replace("lost", "gone (tests/gone)"),
    );
  });

  test("a declared area whose folder holds no test file fails, naming every such area", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "bare", folder: "tests/bare", holds: "folder" },
        { name: "plain", folder: "tests/plain", holds: "files" },
      ]),
      "tests/bare/readme.txt": "no tests here\n",
      "tests/plain/notes.ts": "export {};\n",
    });
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json has test areas with no test file: bare (tests/bare), plain (tests/plain). Repair: restore their tests, or remove them from testAreas.\n",
    );
  });

  test("two declared areas with one name fail, naming both folders, and run nothing", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "template", folder: "tests/more", holds: "folder" },
      ]),
      "tests/more/more.test.ts": probe("more"),
    });
    const result = await captured(() => testArea(root, ["kernel"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json gives one test area name to several folders: template (tests, tests/more). Repair: rename an area in testAreas, or a subfolder.\n",
    );
    expect(result.stdout).toBe("");
    expect(ran(root)).toEqual([]);
  });

  test("a folder area whose only test file is buried deep is not empty", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "buried", folder: "tests/buried", holds: "folder" },
      ]),
      "tests/buried/a/b/only.test.ts": probe("only"),
    });
    const result = await captured(() => testArea(root, ["buried"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["only"]);
  });

  test("several shared names are listed together, separated by a semicolon", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        { name: "template", folder: "tests/more", holds: "folder" },
        { name: "kernel", folder: "tests/other", holds: "folder" },
      ]),
      "tests/more/more.test.ts": probe("more"),
      "tests/other/other.test.ts": probe("other"),
    });
    const result = await captured(() => testArea(root, ["kernel"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json gives one test area name to several folders: template (tests, tests/more); kernel (tests/kernel, tests/other). Repair: rename an area in testAreas, or a subfolder.\n",
    );
  });

  test("a subfolder named like a declared area fails, naming both folders", async () => {
    const root = rootWith({
      "tests/kernel/template/template.test.ts": probe("subfolder"),
    });
    const result = await captured(() => testArea(root, ["kernel"]));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json gives one test area name to several folders: template (tests, tests/kernel/template). Repair: rename an area in testAreas, or a subfolder.\n",
    );
  });

  test("an area whose test files sit only in its subfolders is not empty, and each subfolder runs", async () => {
    const root = rootWith({
      "repository.json": description([
        ...declared,
        {
          name: "nested",
          folder: "tests/nested",
          holds: "files",
          subfolders: true,
        },
      ]),
      "tests/nested/deep/deep.test.ts": probe("deep"),
    });
    const result = await captured(() => testArea(root, ["deep"]));

    expect(result.exitCode).toBe(0);
    expect(ran(root)).toEqual(["deep"]);
  });

  test("a failing doctor returns 1, prints its findings, and runs no tests", async () => {
    const root = rootWith({}, null);
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "FAIL bun: package.json has no toolchain pin.",
    );
    expect(result.stdout).toContain("Done when bun run doctor passes.");
    expect(ran(root)).toEqual([]);
  });

  test("the exit code of the bun test run is the exit code returned", async () => {
    const root = rootWith({
      "tests/exit.test.ts": probe("exit", "  process.exit(3);\n"),
    });
    const result = await captured(() => testArea(root, ["template"]));

    expect(result.exitCode).toBe(3);
  });
});
