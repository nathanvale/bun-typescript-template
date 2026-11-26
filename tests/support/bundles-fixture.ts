import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { parsePackage, ROOT } from "./bootstrap-cli-fixture.ts";
import { write } from "./fixture-files.ts";
import { gitOutput } from "./git-fixture.ts";
import { siblingKernel } from "./kernel-sibling.ts";
import { spawnBounded } from "./process.ts";

export const pinnedCommit = readKernelPin(ROOT).commit;
export const bundleOutput = "tools/greeting/dist/cli.mjs";
export const bundleEntry = "tools/greeting/src/main.ts";

const shippedScripts = new Map(
  Object.entries(
    parsePackage(
      readFileSync(
        join(ROOT, "generated-repository/settings/package.json"),
        "utf8",
      ),
    ).scripts,
  ),
);
const shippedLock = readFileSync(
  join(ROOT, "generated-repository/bun.lock"),
  "utf8",
);
const kernelFiles = ["package.json", "kernel/src/shared/xdg-base.ts"];

const fixtureFolder = join(ROOT, "tests/fixtures/bundle");
export const fixtureKernelCommit = "7a3c430369a7adf3c91b28fe9bcde3aad342298e";
export const fixtureBundle = readFileSync(join(fixtureFolder, "bundle.txt"));
const fixtureSources = {
  [bundleEntry]: readFileSync(join(fixtureFolder, "entry.ts.txt"), "utf8"),
  "tools/greeting/src/greeting.ts": readFileSync(
    join(fixtureFolder, "module.ts.txt"),
    "utf8",
  ),
};

function kernelSpec(commit: string): string {
  return `github:nathanvale/agent-cli-kernel#${commit}`;
}

export function lockResolving(commit: string): string {
  const short = commit.slice(0, 7);
  return `${JSON.stringify(
    {
      lockfileVersion: 1,
      workspaces: {
        "": {
          name: "bundles-fixture",
          dependencies: { "agent-cli-kernel": kernelSpec(commit) },
        },
      },
      packages: {
        "agent-cli-kernel": [
          `agent-cli-kernel@github:nathanvale/agent-cli-kernel#${short}`,
          {},
          `nathanvale-agent-cli-kernel-${short}`,
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export type BundleRepository = {
  readonly bundles?: Readonly<Record<string, string>>;
  readonly kernelAt?: string;
  readonly pins?: string;
  readonly lock?: string;
};

export function bundleRepository(
  root: string,
  options: BundleRepository = {},
): string {
  const kernelAt = options.kernelAt ?? pinnedCommit;
  const scripts = Object.fromEntries(
    ["build:bundles", "check:bundles", "regenerate"].map((name) => [
      name,
      shippedScripts.get(name) ?? `echo no ${name} script is shipped`,
    ]),
  );
  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "bundles-fixture",
        private: true,
        type: "module",
        scripts,
        dependencies: {
          "agent-cli-kernel": kernelSpec(options.pins ?? kernelAt),
        },
        ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
      },
      null,
      2,
    )}\n`,
  );
  write(root, "bun.lock", options.lock ?? shippedLock);
  write(
    root,
    "scripts/build-bundles.ts",
    readFileSync(
      join(ROOT, "generated-repository/scripts/build-bundles.ts"),
      "utf8",
    ),
  );
  for (const path of kernelFiles)
    write(
      root,
      `node_modules/agent-cli-kernel/${path}`,
      gitOutput(siblingKernel(), "show", `${kernelAt}:${path}`),
    );
  for (const [path, text] of Object.entries(fixtureSources))
    write(root, path, text);
  return root;
}

export function runScript(
  root: string,
  script: "build:bundles" | "check:bundles" | "regenerate",
) {
  return spawnBounded([process.execPath, "run", "--silent", script], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    processGroup: true,
  });
}
