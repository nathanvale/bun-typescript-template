import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { gitResult } from "../../support/git-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { processWatchdog } from "../../support/process.ts";

const pin = readKernelPin(ROOT);
const skills = join(ROOT, "generated-repository/skills");
const installed = `node_modules/${pin.repository}/`;

function line(text: string, label: string): string | undefined {
  return new RegExp(`^${label}: (.*)$`, "m").exec(text)?.[1];
}

function fullSkillAtPin(name: string) {
  const pointer = readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const named = /^Full skill: `([^`\n]+)`$/m.exec(pointer)?.[1] ?? "";
  const path = named.startsWith(installed) ? named.slice(installed.length) : "";
  const shown = gitResult(siblingKernel(), "show", `${pin.commit}:${path}`);
  return {
    pointer,
    named,
    path,
    held: shown.exitCode === 0,
    full: shown.stdout.toString(),
  };
}

test(
  "the template holds one pointer skill for each skill the kernel holds at the template's Pin",
  () => {
    const listed = gitResult(
      siblingKernel(),
      "ls-tree",
      "--name-only",
      `${pin.commit}:skills`,
    );
    expect({
      exitCode: listed.exitCode,
      pointers: readdirSync(skills).sort(),
    }).toEqual({
      exitCode: 0,
      pointers: listed.stdout.toString().trim().split("\n").sort(),
    });
  },
  processWatchdog(1),
);

test(
  "each pointer skill names a full skill in the installed kernel that the kernel holds at the template's Pin",
  () => {
    const names = readdirSync(skills).sort();
    expect(names).not.toEqual([]);
    expect(
      names.map((name) => {
        const { named, path, held } = fullSkillAtPin(name);
        return { name, named, inInstalledKernel: path !== "", held };
      }),
    ).toEqual(
      names.map((name) => ({
        name,
        named: `${installed}skills/${name}/SKILL.md`,
        inInstalledKernel: true,
        held: true,
      })),
    );
  },
  processWatchdog(1),
);

test(
  "each pointer skill carries the name and description of the full skill at the template's Pin, so it triggers as the full skill does",
  () => {
    for (const name of readdirSync(skills).sort()) {
      const { pointer, full } = fullSkillAtPin(name);
      expect({
        name: line(pointer, "name"),
        description: line(pointer, "description"),
      }).toEqual({
        name: line(full, "name"),
        description: line(full, "description"),
      });
    }
  },
  processWatchdog(1),
);
