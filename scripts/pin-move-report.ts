import { parseGitTreeEntries } from "../src/git-identities.ts";
import { git } from "../src/kernel-reader.ts";
import {
  formatChangesetLines,
  readRepositoryChangesets,
  type TemplateChangesetEntry,
} from "../src/template-upgrade-changesets.ts";

export type PinMoveReport = {
  readonly from: string;
  readonly to: string;
  readonly changesets?: readonly TemplateChangesetEntry[];
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly log: readonly string[];
};

function read(
  repository: string,
  command: "ls-tree" | "log",
  args: readonly string[],
): Buffer {
  const run = git(repository, command, args);
  if (!run.ok)
    throw new Error(
      `git ${command} ${args.join(" ")} failed in ${repository}: ${run.said} Repair: give a kernel repository that holds both commits.`,
    );
  return run.stdout;
}

function filesAt(repository: string, commit: string): Map<string, string> {
  return parseGitTreeEntries(
    read(repository, "ls-tree", ["-r", "-z", "--full-tree", commit]),
  );
}

function shown(path: string): string {
  return Buffer.from(path, "latin1").toString("utf8");
}

export function pinMoveReport(
  repository: string,
  from: string,
  to: string,
): PinMoveReport {
  const before = filesAt(repository, from);
  const after = filesAt(repository, to);
  const changesets = readRepositoryChangesets(repository, from, to);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return {
    from,
    to,
    ...(changesets === undefined ? {} : { changesets }),
    added: paths.filter((path) => !before.has(path)).map(shown),
    changed: paths
      .filter(
        (path) =>
          before.has(path) &&
          after.has(path) &&
          before.get(path) !== after.get(path),
      )
      .map(shown),
    removed: paths.filter((path) => !after.has(path)).map(shown),
    log: read(repository, "log", [
      "--no-show-signature",
      "--format=%h %s",
      `${from}..${to}`,
    ])
      .toString()
      .split("\n")
      .filter((line) => line !== ""),
  };
}

function section(title: string, lines: readonly string[]): string {
  return `${title} (${lines.length}):\n${lines.map((line) => `  ${line}\n`).join("")}`;
}

function changesetsSection(
  entries: readonly TemplateChangesetEntry[] | undefined,
): string {
  if (entries === undefined) return "";
  const lines = formatChangesetLines(entries);
  return `Kernel changesets (${entries.length}):\n${lines.map((line) => `  ${line}\n`).join("")}`;
}

export function pinMoveReportText(
  report: PinMoveReport,
  written?: readonly string[],
): string {
  return [
    `Pin move report: ${report.from} to ${report.to}\n`,
    changesetsSection(report.changesets),
    written === undefined
      ? ""
      : section(
          "Written in the template, kernel lockfile first and pin last",
          written,
        ),
    section("Kernel files added", report.added),
    section("Kernel files changed", report.changed),
    section("Kernel files removed", report.removed),
    section("Kernel log", report.log),
  ].join("");
}
