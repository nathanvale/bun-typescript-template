import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();
const repository = join(import.meta.dir, "../../..");
const compilerMilliseconds = 60_000;

async function typeCheck(change: (kernelReader: string) => string) {
  const project = folder("repair-lines-");
  const kernelReader = readFileSync(
    join(repository, "src/kernel-reader.ts"),
    "utf8",
  );
  write(project, "src/kernel-reader.ts", change(kernelReader));
  write(
    project,
    "src/stamp-check.ts",
    readFileSync(join(repository, "src/stamp-check.ts"), "utf8"),
  );
  write(
    project,
    "tsconfig.json",
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      compilerOptions: {
        typeRoots: [join(repository, "node_modules/@types")],
      },
      include: ["src/*.ts"],
    }),
  );
  const run = await spawnBounded(
    [join(repository, "node_modules/.bin/tsc"), "--noEmit", "-p", project],
    { cwd: project, boundMilliseconds: compilerMilliseconds },
  );
  return { exit: run.exit, output: run.stdout + run.stderr };
}

test(
  "a kernel reader refusal code without a repair line fails the type check, naming the code",
  async () => {
    const whole = await typeCheck((kernelReader) => kernelReader);
    expect(whole).toEqual({ exit: 0, output: "" });

    const withoutOne = await typeCheck((kernelReader) => {
      const cut = kernelReader.replace(
        /^ {2}kernel_commit_missing:\n.*\n/m,
        "",
      );
      expect(cut).not.toBe(kernelReader);
      expect(cut).toContain('| "kernel_commit_missing"');
      return cut;
    });
    expect(withoutOne.exit).not.toBe(0);
    expect(withoutOne.output).toContain("error TS2741");
    expect(withoutOne.output).toContain(
      "Property 'kernel_commit_missing' is missing in type",
    );
  },
  2 * compilerMilliseconds + 10_000,
);
