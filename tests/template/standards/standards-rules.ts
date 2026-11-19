import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import type { Citable } from "../../support/commit-links.ts";
import { git } from "../../support/git-fixture.ts";
import {
  citableOf,
  faultRecords,
  faultRecordsFile,
  headings,
  matching,
  readWithCodeBlanked,
  standards,
} from "./standards-documents.ts";

type Row = { rule: string; today: string; gates: string; guide: string };
type Gate = { kind: "script" | "lint" | "job" | "fault"; id: string };

function ruleTable(repository: string): {
  rows: Row[];
  gateNotes: string[];
  problems: string[];
} {
  const text = readWithCodeBlanked(join(repository, standards));
  const section = (name: string) =>
    text.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
  const lines = section("Rule table")
    .split("\n")
    .filter((line) => line.startsWith("|"));
  const cells = (line: string) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  const header = cells(lines[0] ?? "|");
  const column = (name: string) => header.indexOf(name);
  const missing = ["Rule", "Today", "Gates", "Guide"].filter(
    (name) => column(name) === -1,
  );
  const problems = missing.map(
    (name) =>
      `${standards}: the rule table has no ${name} column. Repair: restore it, since the standards test and the repo-gardener skill read it.`,
  );
  const rows = lines.slice(2).map((line) => {
    const row = cells(line);
    const cell = (name: string) => row[column(name)] ?? "";
    return {
      rule: cell("Rule"),
      today: cell("Today"),
      gates: cell("Gates"),
      guide: cell("Guide"),
    };
  });
  const gateNotes = headings(`## Gate notes\n${section("Gate notes")}`)
    .filter(({ level }) => level === 3)
    .map(({ slug }) => slug);
  if (rows.length === 0)
    problems.push(
      `${standards}: the rule table has no rows. Repair: restore its rows under the ## Rule table heading.`,
    );
  return { rows, gateNotes, problems };
}

function gatesOf(row: Row): Gate[] {
  return [...row.gates.matchAll(/\b(script|lint|job|fault) `([^`]+)`/g)].map(
    ([, kind, id]) => ({ kind: kind as Gate["kind"], id: id ?? "" }),
  );
}

const levels = new Map([
  [
    "Partial",
    {
      gated: true,
      repair:
        "is Partial but names no gate. Repair: name each gate in the Gates cell as script, lint, job or fault with its id, or mark the row Review only.",
    },
  ],
  [
    "Review only",
    {
      gated: false,
      repair:
        "is Review only but names a gate. Repair: mark it Partial, or set its Gates cell to None.",
    },
  ],
]);

function levelProblem(row: Row): string | undefined {
  const level = levels.get(row.today);
  if (level === undefined)
    return `has Today "${row.today}". Repair: use Review only or Partial.`;
  return gatesOf(row).length > 0 === level.gated ? undefined : level.repair;
}

function section(text: string, slug: string): string {
  const all = headings(text);
  const start = all.findIndex((heading) => heading.slug === slug);
  const heading = all[start];
  if (heading === undefined) return "";
  const end = all
    .slice(start + 1)
    .find(({ level }) => level <= heading.level)?.index;
  return text.slice(heading.index, end);
}

function witnessesIn(
  text: string,
  slug: string | undefined,
  { pages, isThread }: Citable,
): string[] {
  const targets = new Map(
    [...text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)/gm)].map(
      ([, label = "", target = ""]) => [label, target],
    ),
  );
  const part = slug === undefined ? text : section(text, slug);
  return [...part.matchAll(/\[([^\]]+)\](?![[(:])/g)].flatMap(
    ([, label = ""]) => {
      const target = targets.get(label) ?? "";
      const page = pages.find((each) => target.startsWith(each));

      if (page !== undefined) return [`commit ${target.slice(page.length)}`];

      return isThread(target) ? [target] : [];
    },
  );
}

function rowWitnesses(
  repository: string,
  row: Row,
  notes: string[],
  citable: Citable,
) {
  const guides = [
    ...row.guide.matchAll(/\]\(([^)#]*)(?:#([^)]+))?\)/g),
  ].flatMap(([, path = "", anchor]) => {
    const file = join(repository, path === "" ? standards : path);
    return existsSync(file) && statSync(file).isFile()
      ? witnessesIn(readWithCodeBlanked(file), anchor, citable)
      : [];
  });
  const text = readWithCodeBlanked(join(repository, standards));
  return new Set([
    ...guides,
    ...notes.flatMap((anchor) => witnessesIn(text, anchor, citable)),
  ]);
}

export function rowProblems(repository: string): string[] {
  const { rows, gateNotes, problems } = ruleTable(repository);
  const citable = citableOf(repository);
  for (const row of rows) {
    const where = `${standards}: row "${row.rule}"`;
    const hasGuide = /\]\([^)]+\)/.test(row.guide);
    const notes = [...row.gates.matchAll(/\]\(#([^)]+)\)/g)].map(
      ([, anchor]) => anchor ?? "",
    );
    if (!hasGuide && !notes.some((anchor) => gateNotes.includes(anchor)))
      problems.push(
        `${where} has no guide and no gate note. Repair: link its guide in the Guide cell, or link a heading under ## Gate notes from its Gates cell.`,
      );
    const witnesses = rowWitnesses(repository, row, notes, citable).size;
    if (witnesses < 2)
      problems.push(
        `${where} needs two distinct witnesses in its guide or gate note, and has ${witnesses}. Repair: cite a second commit or review thread, or move the lesson back to docs/standards/single-witness.md.`,
      );
    const level = levelProblem(row);
    if (level !== undefined) problems.push(`${where} ${level}`);
  }
  return problems;
}

async function lintIds(repository: string): Promise<Set<string>> {
  const eslint = new ESLint({
    cwd: repository,
    overrideConfigFile: join(repository, "eslint.config.mjs"),
  });
  const paths = git(
    repository,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ).split("\n");
  const configs = (await Promise.all(
    paths.map((path) => eslint.calculateConfigForFile(path)),
  )) as ({ rules?: Record<string, unknown> } | undefined)[];
  const on = (setting: unknown) => {
    const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
    return severity !== 0 && severity !== "off";
  };
  return new Set(
    configs.flatMap((config) =>
      Object.entries(config?.rules ?? {})
        .filter(([, setting]) => on(setting))
        .map(([id]) => id),
    ),
  );
}

function runsOnPullRequest(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return (
    typeof on === "object" && on !== null && Object.hasOwn(on, "pull_request")
  );
}

async function jobIds(repository: string): Promise<Set<string>> {
  const files = await matching(repository, [".github/workflows/*.{yml,yaml}"]);
  const jobs = await Promise.all(
    files.map(async (file) => {
      const document = Bun.YAML.parse(
        await Bun.file(join(repository, file)).text(),
      ) as { on?: unknown; jobs?: Record<string, unknown> } | null;
      return runsOnPullRequest(document?.on)
        ? Object.keys(document?.jobs ?? {})
        : [];
    }),
  );
  return new Set(jobs.flat());
}

export async function gateProblems(repository: string): Promise<string[]> {
  const { scripts = {} } = (await Bun.file(
    join(repository, "package.json"),
  ).json()) as { scripts?: Record<string, string> };
  const known = {
    script: {
      ids: new Set(Object.keys(scripts)),
      owner: "package.json does not define as a script",
    },
    lint: {
      ids: await lintIds(repository),
      owner:
        "no config in eslint.config.mjs turns on for a file in the repository",
    },
    job: {
      ids: await jobIds(repository),
      owner:
        "no workflow in .github/workflows/ that runs on pull_request defines as a job",
    },
    fault: {
      ids: new Set(faultRecords(repository).map(({ id }) => id)),
      owner: `no record in ${faultRecordsFile} has as its id`,
    },
  };
  return ruleTable(repository).rows.flatMap((row) =>
    gatesOf(row)
      .filter(({ kind, id }) => !known[kind].ids.has(id))
      .map(
        ({ kind, id }) =>
          `${standards}: row "${row.rule}" names ${kind} \`${id}\`, which ${known[kind].owner}. Repair: restore the gate, or correct the row's Gates cell and mark it Review only if no gate remains.`,
      ),
  );
}
