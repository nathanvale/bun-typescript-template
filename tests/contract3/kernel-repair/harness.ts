import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeToolchain } from "../../support/materialised-tree.ts";
import { familyCases } from "./cases.ts";
import { spawnBounded } from "./swarm-process.ts";

export function runFamily(
  family: string,
  implementations: Readonly<Record<string, () => unknown>>,
  timeout = 30000,
): void {
  const frozen = familyCases(family).map((item) => item.id);
  test(`${family}: implemented identities equal the frozen active set`, () => {
    expect(frozen.length).toBeGreaterThan(0);
    expect(Object.keys(implementations).sort()).toEqual([...frozen].sort());
  });
  for (const item of familyCases(family)) {
    const run = implementations[item.id];
    test(
      `${item.id}: ${item.expected}`,
      async () => {
        if (!run) throw new Error(`Missing implementation for ${item.id}.`);
        await run();
      },
      timeout,
    );
  }
}

const repository = new URL("../../../", import.meta.url).pathname;
const stateModules = [
  "repair-shared",
  "state-repair",
  "admission-changing",
  "context-changing",
  "r18-changing",
  "swarm-state",
] as const;
export const materialisedFixtures: readonly string[] = [
  ...stateModules.map(
    (name) => `starters/contract3/src/addons/state/${name}.ts`,
  ),
  "tests/contract3/kernel-repair/driver.ts",
  "tests/contract3/kernel-repair/swarm-state-cli.ts",
  "tests/contract3/kernel-repair/r18-spec.ts",
  "tests/contract3/kernel-repair/shapes.ts",
  "tests/contract3/kernel-repair/swarm-approval.ts",
];

export async function materialise(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contract3-repair-"),
  );
  const source = join(root, "starters/contract3/src");
  const tests = join(root, "tests/contract3/kernel-repair");
  await mkdir(join(source, "addons/state"), { recursive: true });
  await mkdir(tests, { recursive: true });
  await cp(
    join(repository, "starters/contract3/src/kernel"),
    join(source, "kernel"),
    {
      recursive: true,
    },
  );
  await cp(
    join(repository, "starters/contract3/src/addons/approval"),
    join(source, "addons/approval"),
    { recursive: true },
  );
  for (const name of stateModules)
    await writeFile(
      join(source, `addons/state/${name}.ts`),
      await readFile(new URL(`fixtures/${name}.ts.txt`, import.meta.url)),
    );
  for (const name of ["driver", "swarm-state-cli"])
    await writeFile(
      join(tests, `${name}.ts`),
      await readFile(new URL(`fixtures/${name}.ts.txt`, import.meta.url)),
    );
  for (const name of ["r18-spec.ts", "shapes.ts", "swarm-approval.ts"])
    await cp(new URL(name, import.meta.url), join(tests, name));
  await writeToolchain(root, [
    "starters/contract3/src/**/*.ts",
    "tests/**/*.ts",
  ]);
  return root;
}

const treeBound = 110_000;
function spawnText(argv: readonly string[], cwd: string) {
  return spawnBounded(argv, { cwd, boundMilliseconds: treeBound });
}

export async function stateFixture(name: string): Promise<unknown> {
  const root = await materialise();
  try {
    const run = await spawnBounded(
      [process.execPath, "tests/contract3/kernel-repair/driver.ts", name],
      { cwd: root },
    );
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const parsed: unknown = JSON.parse(run.stdout);
    return parsed;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function lintTree(root: string) {
  const run = await spawnText(
    [
      join(root, "node_modules/.bin/eslint"),
      "--max-warnings",
      "0",
      "--format",
      "json",
      ".",
    ],
    root,
  );
  const report: unknown = JSON.parse(run.stdout);
  const files = Array.isArray(report)
    ? report.flatMap((entry: unknown) => {
        const path: unknown =
          typeof entry === "object" && entry !== null
            ? Reflect.get(entry, "filePath")
            : undefined;
        const messages: unknown =
          typeof entry === "object" && entry !== null
            ? Reflect.get(entry, "messages")
            : undefined;
        return typeof path === "string" && Array.isArray(messages)
          ? [
              {
                file: path.slice(root.length + 1),
                messages: messages.length,
                rules: messages.map((message: unknown) =>
                  String(
                    typeof message === "object" && message !== null
                      ? Reflect.get(message, "ruleId")
                      : "",
                  ),
                ),
              },
            ]
          : [];
      })
    : [];
  return { exit: run.exit, stderr: run.stderr, files };
}

export function typecheckTree(root: string) {
  return spawnText(
    [
      process.execPath,
      join(repository, "node_modules/@typescript/native/bin/tsc"),
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(root, "tsconfig.json"),
    ],
    root,
  );
}

export async function buildUnchecked(
  contract: unknown,
  selected: unknown,
  facts: unknown,
): Promise<unknown> {
  const build: unknown =
    typeof contract === "object" && contract !== null
      ? Reflect.get(contract, "build")
      : undefined;
  if (typeof build !== "function") throw new Error("Contract has no build.");
  const result: unknown = await Reflect.apply(build, contract, [
    selected,
    facts,
  ]);
  return result;
}

export function contractUnchecked(
  contractFor: unknown,
  spec: unknown,
): unknown {
  if (typeof contractFor !== "function") throw new Error("No contractFor.");
  const contract: unknown = Reflect.apply(contractFor, undefined, [spec]);
  return contract;
}
