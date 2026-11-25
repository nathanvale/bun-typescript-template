import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { doctor } from "./doctor.ts";
import { readRepository, type TestArea } from "./repository.ts";

function isTest(name: string): boolean {
  return name.endsWith(".test.ts");
}

function holdsTests(directory: string): boolean {
  return (
    existsSync(directory) &&
    readdirSync(directory, { recursive: true, encoding: "utf8" }).some(isTest)
  );
}

function entries(directory: string): Dirent[] {
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
    : [];
}

// Platform: bun test reads a path without a ./ prefix as a substring filter, so
// "tests/area" would also run tests/area-seam.test.ts.
function testFiles(root: string, directory: string): string[] {
  return entries(join(root, directory))
    .filter((entry) => entry.isFile() && isTest(entry.name))
    .map((entry) => `./${directory}/${entry.name}`);
}

function pathsOf(root: string, { holds, folder }: TestArea): string[] {
  if (holds === "files") return testFiles(root, folder);
  return holdsTests(join(root, folder)) ? [`./${folder}`] : [];
}

type Candidate = {
  readonly name: string;
  readonly folder: string;
  readonly paths: string[];
};

function subfolderAreas(root: string, { folder }: TestArea): Candidate[] {
  return entries(join(root, folder))
    .filter(
      (entry) =>
        entry.isDirectory() && holdsTests(join(root, folder, entry.name)),
    )
    .map((entry) => {
      const subfolder = `${folder}/${entry.name}`;

      return { name: entry.name, folder: subfolder, paths: [`./${subfolder}`] };
    });
}

function runnable(root: string, area: TestArea): Candidate[] {
  const own = {
    name: area.name,
    folder: area.folder,
    paths: pathsOf(root, area),
  };
  return [own, ...(area.subfolders ? subfolderAreas(root, area) : [])].filter(
    (candidate) => candidate.paths.length > 0,
  );
}

function areas(root: string): {
  known: Map<string, string[]>;
  empty: string[];
  shared: string[];
} {
  const declared = readRepository(root).testAreas.map((area) => ({
    area,
    entries: runnable(root, area),
  }));
  const candidates = declared.flatMap(({ entries }) => entries);
  const folders = Map.groupBy(candidates, (candidate) => candidate.name);

  return {
    known: new Map(
      candidates.map((candidate) => [candidate.name, candidate.paths]),
    ),
    empty: declared
      .filter(({ entries }) => entries.length === 0)
      .map(({ area }) => `${area.name} (${area.folder})`),
    shared: [...folders].flatMap(([name, named]) =>
      named.length > 1
        ? [`${name} (${named.map((candidate) => candidate.folder).join(", ")})`]
        : [],
    ),
  };
}

export async function testArea(
  root: string,
  args: readonly string[],
): Promise<number> {
  const { known, empty, shared } = areas(root);
  const [area, ...options] = args;
  const paths = area === undefined ? undefined : known.get(area);

  if (empty.length > 0) {
    process.stderr.write(
      `repository.json has test areas with no test file: ${empty.join(", ")}. Repair: restore their tests, or remove them from testAreas.\n`,
    );
    return 1;
  }
  if (shared.length > 0) {
    process.stderr.write(
      `repository.json gives one test area name to several folders: ${shared.join("; ")}. Repair: rename an area in testAreas, or a subfolder.\n`,
    );
    return 1;
  }
  if (paths === undefined) {
    const valid = [...known.keys()].sort().join(", ");
    process.stderr.write(
      `Usage: bun run test:area <area> [bun test options]. ${area === undefined ? "No area given" : `Unknown area "${area}"`}. Valid areas: ${valid}.\n`,
    );
    return 2;
  }
  if (!(await doctor(root))) return 1;
  const run = Bun.spawn(
    [process.execPath, "scripts/test-run.ts", ...paths, ...options],
    {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  return await run.exited;
}

if (import.meta.main)
  process.exitCode = await testArea(
    join(import.meta.dir, ".."),
    process.argv.slice(2),
  );
