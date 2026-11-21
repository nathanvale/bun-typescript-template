import { expect, test } from "bun:test";
import { join } from "node:path";
import { runNamesCheck } from "../../../scripts/check-names.ts";
import { git } from "../../support/git-fixture.ts";
import { check, namesCheckFixture, put } from "./names-check-fixture.ts";

const { namesRepository } = namesCheckFixture();

const description = JSON.stringify({
  web: "https://github.com/nathanvale/bun-typescript-template",
  checkCommitsSince: "0".repeat(40),
  testAreas: [
    {
      name: "template",
      folder: "tests/template",
      holds: "folder",
      subfolders: true,
    },
    {
      name: "kernel",
      folder: "tests/kernel",
      holds: "files",
      subfolders: true,
    },
  ],
});

function describedRepository(): string {
  const root = namesRepository();
  put(root, "repository.json", description);
  return root;
}

function outsideRefusal(path: string): string {
  return `${path} is a test file outside the folders repository.json gives test files. Repair: move it into one of tests/template/<area>/, tests/kernel/, tests/kernel/<area>/, or add its folder to testAreas. Done when bun run check:names ${path} passes.\n`;
}

test.each(["tests/loose.test.ts", "tests/template/loose.test.ts"])(
  "in process: a test file at %s, outside every test area folder, is refused with the folders it may go in",
  async (path) => {
    expect(await check(describedRepository(), [path])).toEqual({
      stderr: outsideRefusal(path),
      code: 1,
    });
  },
);

test("in process: a test file in a test area folder, or straight in an area that holds files, passes", async () => {
  expect(
    await check(describedRepository(), [
      "tests/template/doctor/doctor.test.ts",
      "tests/template/doctor/deeper/doctor-cases.test.ts",
      "tests/kernel/state.test.ts",
      "tests/kernel/state/seam.test.ts",
      "tests/support/process.ts",
    ]),
  ).toEqual({ stderr: "", code: 0 });
});

test("in process: --tool-call refuses a Write that creates a test file outside every test area folder", async () => {
  const root = describedRepository();
  const call = {
    tool_name: "Write",
    tool_input: { file_path: join(root, "tests/loose.test.ts") },
  };
  expect(
    await check(root, ["--tool-call"], () =>
      Promise.resolve(JSON.stringify(call)),
    ),
  ).toEqual({ stderr: outsideRefusal("tests/loose.test.ts"), code: 1 });
});

test("in process: --staged refuses an added test file outside every test area folder", async () => {
  const root = describedRepository();
  put(root, "tests/template/loose.test.ts", "");
  git(root, "add", "--", "tests/template/loose.test.ts");
  expect(await check(root, ["--staged"])).toEqual({
    stderr: outsideRefusal("tests/template/loose.test.ts"),
    code: 1,
  });
});

test("in process: a repository with no repository.json leaves test file placement unjudged", async () => {
  expect(await check(namesRepository(), ["tests/loose.test.ts"])).toEqual({
    stderr: "",
    code: 0,
  });
});

test("every tracked test file under tests/ sits in a folder repository.json gives test files", async () => {
  const root = join(import.meta.dir, "../../..");
  const tracked = git(root, "ls-files", "-z", "--", "tests/")
    .split("\0")
    .filter((path) => path.endsWith(".test.ts"));
  expect(tracked.length).toBeGreaterThan(0);
  expect(
    await runNamesCheck(tracked, {
      root,
      cwd: root,
      stdin: () => Promise.resolve(""),
    }),
  ).toEqual({ stderr: "", code: 0 });
});
