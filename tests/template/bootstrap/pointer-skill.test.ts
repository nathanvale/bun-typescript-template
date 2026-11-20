import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import {
  bootstrapRow,
  kernelRowFixture,
} from "../../support/kernel-row-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const run = kernelRowFixture();
const pointer = ".agents/skills/agent-cli-kernel/SKILL.md";
const onlyOneFailed = "\n 4 pass\n 1 fail\n";
const installedKernel = "node_modules/agent-cli-kernel";
const fullSkill =
  "node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md";

async function generated() {
  const { destination, request } = run();
  await bootstrapRow(request);
  return { destination, commit: request.kernel.commit };
}

function installKernel(
  destination: string,
  commit: string,
  { withFullSkill = true }: { readonly withFullSkill?: boolean } = {},
): void {
  writeFileSync(
    join(destination, "bun.lock"),
    `{\n  "workspaces": {\n    "": {\n      "dependencies": {\n        "agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${commit}",\n      },\n    },\n  },\n  "packages": {\n    "agent-cli-kernel": ["agent-cli-kernel@github:nathanvale/agent-cli-kernel#${commit.slice(0, 7)}", {}, "nathanvale-agent-cli-kernel-${commit.slice(0, 7)}", "sha512-AA=="],\n  },\n}\n`,
  );
  mkdirSync(join(destination, installedKernel), { recursive: true });
  writeFileSync(
    join(destination, installedKernel, ".bun-tag"),
    `nathanvale-agent-cli-kernel-${commit.slice(0, 7)}`,
  );
  if (!withFullSkill) return;
  mkdirSync(join(destination, fullSkill, ".."), { recursive: true });
  writeFileSync(join(destination, fullSkill), "# The full skill\n");
}

function moveText(path: string, from: string, to: string): void {
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}

function editPointer(
  destination: string,
  edit: (text: string) => string,
): void {
  const path = join(destination, pointer);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
}

async function pointerCheck(destination: string) {
  const { exit, stderr } = await spawnBounded(
    [process.execPath, "test", "tests/pointer-skills.test.ts"],
    { cwd: destination, processGroup: true },
  );
  return { exit, stderr };
}

describe("the kernel row's pointer skills", () => {
  test("give one pointer skill for each skill the template holds, each naming the commit asked for in full, and link each from .claude/skills", async () => {
    const { destination, commit } = await generated();
    const held = readdirSync(join(ROOT, "generated-repository/skills")).sort();
    expect(readdirSync(join(destination, ".agents/skills")).sort()).toEqual(
      held,
    );
    expect(readdirSync(join(destination, ".claude/skills")).sort()).toEqual(
      held,
    );
    for (const name of held) {
      const link = join(destination, ".claude/skills", name);
      expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
      expect(realpathSync(link)).toBe(
        realpathSync(join(destination, ".agents/skills", name)),
      );
      expect(
        readFileSync(join(link, "SKILL.md"), "utf8").match(
          /^Pinned commit: .*$/gm,
        ),
      ).toEqual([`Pinned commit: \`${commit}\``]);
    }
  });
});

describe("the generated repository's pointer skill check", () => {
  test.each([
    ["a github: install, which names the commit's first 7 characters", false],
    ["a git+file: install, which names the full commit", true],
  ])(
    "passes when the pointer, bun.lock and the installed kernel name the pinned commit, after %s",
    async (_case, fullTag) => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      if (fullTag)
        writeFileSync(join(destination, installedKernel, ".bun-tag"), commit);
      expect(await pointerCheck(destination)).toMatchObject({ exit: 0 });
    },
    processWatchdog(1),
  );

  test(
    "fails when bun.lock pins another commit than package.json, as after a pin move with no install",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const other = "b".repeat(40);
      moveText(join(destination, "bun.lock"), commit, other);
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `bun.lock pins ${other}, and package.json pins ${commit}. Repair: run bun install after the pin changes in package.json, commit bun.lock with it, then run bun install --frozen-lockfile.`,
      );
      expect(stderr).not.toContain('+   "the installed kernel is');
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when bun.lock resolves the kernel to another commit than package.json pins, which a frozen install would install",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const other = "315862fa13c81de3ff7fd19a4be341182b57f778";
      moveText(
        join(destination, "bun.lock"),
        `agent-cli-kernel#${commit.slice(0, 7)}"`,
        `agent-cli-kernel#${other.slice(0, 7)}"`,
      );
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `bun.lock resolves the kernel to ${other.slice(0, 7)}, and package.json pins ${commit}. Repair: run bun update agent-cli-kernel, commit bun.lock, then run bun install --frozen-lockfile.`,
      );
      expect(stderr).not.toContain('+   "bun.lock pins');
      expect(stderr).not.toContain('+   "the installed kernel is');
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when the installed kernel is another commit than package.json and bun.lock pin, as after a pull with no install",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const other = "c".repeat(40);
      for (const path of ["package.json", "bun.lock", pointer])
        moveText(join(destination, path), commit, other);
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `the installed kernel is nathanvale-agent-cli-kernel-${commit.slice(0, 7)}, and package.json pins ${other}. Repair: run bun install --frozen-lockfile.`,
      );
      expect(stderr).not.toContain('+   "bun.lock pins');
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when no kernel is installed, naming the frozen install",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      rmSync(join(destination, installedKernel, ".bun-tag"));
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `the installed kernel is not there, and package.json pins ${commit}. Repair: run bun install --frozen-lockfile.`,
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when the pointer names a commit package.json does not pin",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const other = "a".repeat(40);
      editPointer(destination, (text) => text.replace(commit, other));
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `${pointer} names ${other}, and package.json pins ${commit}. Repair: write ${commit} on its Pinned commit line, then read the full skill at that commit for any change.`,
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when the installed kernel does not hold the full skill the pointer names",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit, { withFullSkill: false });
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `${pointer} names ${fullSkill}, which the installed kernel at ${commit} does not hold. Repair: run bun install --frozen-lockfile; if it is still missing, find where the kernel at ${commit} keeps the skill and write that path on its Full skill line.`,
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test.each([
    [
      "a path that exists outside it",
      ".agents/skills/agent-cli-kernel/SKILL.md",
    ],
    [
      "a path that climbs out of it",
      "node_modules/agent-cli-kernel/../../.agents/skills/agent-cli-kernel/SKILL.md",
    ],
  ])(
    "fails when the pointer names a full skill outside the installed kernel: %s",
    async (_case, outside) => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      editPointer(destination, (text) =>
        text.replace(/^Full skill: .*$/m, `Full skill: \`${outside}\``),
      );
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `${pointer} names ${outside}, which is not inside the installed kernel, node_modules/agent-cli-kernel/. Repair: write the path of the skill the installed kernel ships, as node_modules/agent-cli-kernel/skills/<name>/SKILL.md, on its Full skill line.`,
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails when the full skill the pointer names is a folder in the installed kernel, not a file",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const folderPath =
        "node_modules/agent-cli-kernel/skills/agent-cli-kernel";
      editPointer(destination, (text) =>
        text.replace(/^Full skill: .*$/m, `Full skill: \`${folderPath}\``),
      );
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        `${pointer} names ${folderPath}, which the installed kernel at ${commit} does not hold.`,
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );

  test(
    "fails naming package.json when its kernel dependency pins no full commit",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      const manifest = join(destination, "package.json");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8").replace(`#${commit}`, "#main"),
      );
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        'package.json pins no full kernel commit: its agent-cli-kernel dependency is "github:nathanvale/agent-cli-kernel#main". Repair: write the dependency as github:nathanvale/agent-cli-kernel#<full 40-character commit>.',
      );
      expect(stderr).toContain("\n 2 pass\n 3 fail\n");
    },
    processWatchdog(1),
  );

  test(
    "fails when no skill names a full skill, so it never checks nothing",
    async () => {
      const { destination, commit } = await generated();
      installKernel(destination, commit);
      editPointer(destination, (text) =>
        text.replace(/^Full skill: .*\n/m, ""),
      );
      const { exit, stderr } = await pointerCheck(destination);
      expect({ exit, stderr }).toMatchObject({ exit: 1 });
      expect(stderr).toContain(
        "No skill in .agents/skills names a Full skill. Repair: restore the pointer skills Bootstrap wrote, each with its Full skill and Pinned commit lines.",
      );
      expect(stderr).toContain(onlyOneFailed);
    },
    processWatchdog(1),
  );
});
