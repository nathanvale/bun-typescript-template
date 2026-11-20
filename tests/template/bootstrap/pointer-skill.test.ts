import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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
const onlyOneFailed = "\n 3 pass\n 1 fail\n";
const fullSkill =
  "node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md";

async function generated() {
  const { destination, request } = run();
  await bootstrapRow(request);
  return { destination, commit: request.kernel.commit };
}

function installFullSkill(destination: string): void {
  mkdirSync(join(destination, fullSkill, ".."), { recursive: true });
  writeFileSync(join(destination, fullSkill), "# The full skill\n");
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
  test(
    "passes when the pointer names the pinned commit and the installed kernel holds the full skill",
    async () => {
      const { destination } = await generated();
      installFullSkill(destination);
      expect(await pointerCheck(destination)).toMatchObject({ exit: 0 });
    },
    processWatchdog(1),
  );

  test(
    "fails when the pointer names a commit package.json does not pin",
    async () => {
      const { destination, commit } = await generated();
      installFullSkill(destination);
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
      const { destination } = await generated();
      installFullSkill(destination);
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
    "fails when no skill names a full skill, so it never checks nothing",
    async () => {
      const { destination } = await generated();
      installFullSkill(destination);
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
