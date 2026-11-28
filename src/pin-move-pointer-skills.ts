import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./kernel-reader.ts";
import { SKILL_FOLDER } from "./recipe.ts";

export type PinMoveFile = { readonly path: string; readonly text: string };

function frontmatterLine(text: string, label: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) return undefined;
  return new RegExp(`^${label}: (.*)$`, "m").exec(block)?.[1];
}

function replaceFrontmatterLine(
  text: string,
  label: string,
  value: string,
): string {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/, (block) =>
    block.replace(
      new RegExp(`^${label}: .*$`, "m"),
      () => `${label}: ${value}`,
    ),
  );
}

function syncPointerSkill(
  text: string,
  kernelRepository: string,
  kernelCommit: string,
  skillRelPath: string,
): string {
  let next = text.replace(
    /^Pinned commit: `[^`\n]*`$/m,
    () => `Pinned commit: \`${kernelCommit}\``,
  );
  const full = git(kernelRepository, "cat-file", [
    "-p",
    `${kernelCommit}:${skillRelPath}`,
  ]);
  if (!full.ok) return next;
  const fullText = full.stdout.toString("utf8");
  for (const label of ["name", "description"] as const) {
    const expected = frontmatterLine(fullText, label);
    if (expected !== undefined)
      next = replaceFrontmatterLine(next, label, expected);
  }
  return next;
}

export function pointerSkillFiles(
  repository: string,
  kernelRepository: string,
  kernelCommit: string,
  packageName: string,
  requirePlainEntry: (
    repository: string,
    relativePath: string,
    kind: "file" | "directory",
  ) => string,
): PinMoveFile[] {
  const folder = join(repository, SKILL_FOLDER);
  if (!existsSync(folder)) return [];
  requirePlainEntry(repository, SKILL_FOLDER, "directory");
  const installedPrefix = `node_modules/${packageName}/`;
  const planned: PinMoveFile[] = [];
  for (const name of readdirSync(folder).sort()) {
    const relativeSkill = `${SKILL_FOLDER}/${name}/SKILL.md`;
    const skillDir = join(folder, name);
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    const file = requirePlainEntry(repository, relativeSkill, "file");
    const text = readFileSync(file, "utf8");
    const fullSkill = /^Full skill: `([^`\n]+)`$/m.exec(text)?.[1];
    if (fullSkill === undefined || !fullSkill.startsWith(installedPrefix))
      continue;
    const next = syncPointerSkill(
      text,
      kernelRepository,
      kernelCommit,
      fullSkill.slice(installedPrefix.length),
    );
    if (next !== text) planned.push({ path: relativeSkill, text: next });
  }
  return planned;
}
