import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkStamp, stampRecordPath } from "../../../src/stamp-check.ts";
import { stampCheckerPath } from "../../../src/stamping.ts";
import { bootstrapWithKernel } from "../../../src/bootstrap.ts";
import { listFiles } from "../../support/bootstrap-cli-fixture.ts";
import {
  firstLayout,
  renamedLayout,
  sources,
} from "../../support/kernel-repository-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import {
  generatedJson,
  stampingFixture,
} from "../../support/stamping-fixture.ts";

const run = stampingFixture();

function stampedIn(destination: string, prefixes: readonly string[]) {
  return listFiles(destination).then((files) =>
    files.filter((file) =>
      prefixes.some((prefix) => file.startsWith(`${prefix}/`)),
    ),
  );
}

describe("Bootstrap stamping the kernel through the kernel row", () => {
  test("stamps the kernel and each selected add-on at the paths the kernel declaration gives", async () => {
    const { destination, request } = run({ addons: ["beta", "alpha"] });
    await bootstrapWithKernel(request);
    const { core, settings, extras } = firstLayout;
    expect(await stampedIn(destination, [core, settings, `${extras}`])).toEqual(
      [
        `${core}/deep/leaf.ts`,
        `${core}/index.ts`,
        `${core}/run.sh`,
        `${extras}/alpha/index.ts`,
        `${extras}/beta/index.ts`,
        `${settings}/kernel-declaration.json`,
        `${settings}/rules.mjs`,
      ],
    );
    expect(readFileSync(join(destination, `${core}/index.ts`), "utf8")).toBe(
      sources.index,
    );
    expect(statSync(join(destination, `${core}/run.sh`)).mode & 0o111).not.toBe(
      0,
    );
    expect(existsSync(join(destination, "notes.md"))).toBe(false);
    expect(checkStamp(destination)).toEqual({
      status: "intact",
      commit: request.kernel.commit,
      addons: ["alpha", "beta"],
      fileCount: 7,
    });
  });

  test("stamps no add-on that is not selected", async () => {
    const { destination, request } = run({ addons: ["beta"] });
    await bootstrapWithKernel(request);
    const { extras } = firstLayout;
    expect(await stampedIn(destination, [extras])).toEqual([
      `${extras}/beta/index.ts`,
    ]);
  });

  test("takes every kernel path from the kernel declaration, so a renamed layout stamps at its own paths", async () => {
    const { destination, request } = run({ layout: renamedLayout });
    await bootstrapWithKernel(request);
    const { core, settings, extras } = renamedLayout;
    expect(await stampedIn(destination, [core, settings, extras])).toEqual([
      `${settings}/kernel-declaration.json`,
      `${settings}/rules.mjs`,
      `${core}/deep/leaf.ts`,
      `${core}/index.ts`,
      `${core}/run.sh`,
    ]);
    expect(checkStamp(destination)).toMatchObject({ status: "intact" });
  });

  test("merges the selection's packages and dead-code entries into the generated repository's own settings", async () => {
    const { destination, request } = run({ addons: ["beta"] });
    await bootstrapWithKernel(request);
    const { core, extras } = firstLayout;
    expect(generatedJson(destination, "package.json")).toMatchObject({
      name: "demo-app",
      dependencies: { "left-pad": "1.3.0" },
    });
    const { entry } = generatedJson(destination, ".fallowrc.json") as {
      entry: string[];
    };
    expect(entry).toEqual([
      "tests/cli.test.ts",
      `${core}/index.ts`,
      `${extras}/beta/index.ts`,
    ]);
  });

  test("writes the stamp checker as the template's stamp check, byte for byte", async () => {
    const { destination, request } = run();
    await bootstrapWithKernel(request);
    expect(readFileSync(join(destination, stampCheckerPath))).toEqual(
      readFileSync(join(import.meta.dir, "../../../src/stamp-check.ts")),
    );
  });

  test("gives no file a later modification time than the stamp record", async () => {
    const { destination, request } = run({ addons: ["beta"] });
    await bootstrapWithKernel(request);
    const changed = (path: string) =>
      statSync(join(destination, path), { bigint: true }).mtimeNs;
    const record = changed(stampRecordPath);
    const later = (await listFiles(destination)).filter(
      (path) => path !== stampRecordPath && changed(path) > record,
    );
    expect(later).toEqual([]);
  });
});

describe("the generated repository's check command", () => {
  test("runs the stamp check as its first step, which passes on intact stamped source and fails on a one-byte edit", async () => {
    const { destination, request } = run();
    await bootstrapWithKernel(request);
    const { scripts } = generatedJson(destination, "package.json") as {
      scripts: Record<string, string>;
    };
    const [first] = (scripts.check ?? "").split("&&");
    expect(first?.trim()).toBe("bun run check:stamp");
    expect(scripts["check:stamp"]).toBe(`bun run ${stampCheckerPath}`);
    const stampCheck = () =>
      spawnBounded([process.execPath, "run", "check:stamp"], {
        cwd: destination,
        processGroup: true,
      });
    const intact = await stampCheck();
    expect({
      exit: intact.exit,
      verdict: JSON.parse(intact.stdout) as unknown,
    }).toEqual({
      exit: 0,
      verdict: {
        status: "intact",
        commit: request.kernel.commit,
        addons: [],
        fileCount: 5,
      },
    });
    const edited = `${firstLayout.core}/index.ts`;
    writeFileSync(join(destination, edited), `${sources.index} `);
    const broken = await stampCheck();
    expect({
      exit: broken.exit,
      verdict: JSON.parse(broken.stdout) as unknown,
    }).toEqual({
      exit: 1,
      verdict: {
        status: "broken",
        findings: [
          {
            kind: "modified",
            path: edited,
            detail: "its bytes are not the stamped ones.",
          },
        ],
      },
    });
  });
});
