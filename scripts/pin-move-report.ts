import { git } from "../src/kernel-reader.ts";

// Interface: what a reviewer of a pin move reads: every file of the kernel
// repository added, changed or removed between the old and new pinned
// commits, and the kernel's log lines between them, newest first.
export type PinMoveReport = {
  readonly from: string;
  readonly to: string;
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

// Platform: git prints each path as the bytes it stores, which need not be
// UTF-8 text, so paths are compared as latin1 text, one character per byte,
// and decoded as UTF-8 only to be shown.
function filesAt(repository: string, commit: string): Map<string, string> {
  const listing = read(repository, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    commit,
  ]);
  const files = new Map<string, string>();
  for (let start = 0; start < listing.length; ) {
    const end = listing.indexOf(0, start);
    const record = listing.subarray(start, end < 0 ? listing.length : end);
    const tab = record.indexOf(9);
    files.set(
      record.subarray(tab + 1).toString("latin1"),
      record.subarray(0, tab).toString("latin1"),
    );
    start = end < 0 ? listing.length : end + 1;
  }
  return files;
}

function shown(path: string): string {
  return Buffer.from(path, "latin1").toString("utf8");
}

// Interface: reads both commits from the git objects of the kernel
// repository at `repository`, a real path the kernel reader has opened.
export function pinMoveReport(
  repository: string,
  from: string,
  to: string,
): PinMoveReport {
  const before = filesAt(repository, from);
  const after = filesAt(repository, to);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return {
    from,
    to,
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

export function pinMoveReportText(
  report: PinMoveReport,
  written: readonly string[],
): string {
  return [
    `Pin move report: ${report.from} to ${report.to}\n`,
    section(
      "Written in the template, kernel lockfile first and pin last",
      written,
    ),
    section("Kernel files added", report.added),
    section("Kernel files changed", report.changed),
    section("Kernel files removed", report.removed),
    section("Kernel log", report.log),
  ].join("");
}
