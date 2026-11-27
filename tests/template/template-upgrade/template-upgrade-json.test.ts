import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { kernelPinFile, parseKernelPin } from "../../../src/kernel-pin.ts";
import { TEMPLATE_JSON_FILE } from "../../../src/recipe.ts";
import { withTemplateUpgradeTrees } from "../../../src/template-upgrade-bootstrap.ts";
import { TEMPLATE_UPGRADE_FLOOR } from "../../../src/template-upgrade-git.ts";
import {
  OLD_TEMPLATE_JSON_FILE,
  resolveTemplateUpgradeInputs,
} from "../../../src/template-upgrade-inputs.ts";
import { mergeTemplateUpgradeTrees } from "../../../src/template-upgrade-merge.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  initRepository,
} from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();
const DEFAULT_KERNEL_PIN = `github:nathanvale/agent-cli-kernel#${trialBase}`;

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a CliError refusal.");
}

async function captureAsyncCliError(
  run: () => Promise<unknown>,
): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected an async CliError refusal.");
}

function makeStampedRepository(
  files: Record<string, string>,
  packageName = "demo",
): string {
  const repository = folder("stamp-repo-");
  initRepository(repository);
  commitIn(repository, "initial", {
    ...files,
    "package.json": `${JSON.stringify({ name: packageName, dependencies: { "agent-cli-kernel": DEFAULT_KERNEL_PIN } }, null, 2)}\n`,
  });
  return repository;
}

test("reads .template.json when present and reads .cli-design-template.json when .template.json is absent", () => {
  const baseCommit = TEMPLATE_UPGRADE_FLOOR;
  const targetCommit = git(ROOT, "rev-parse", "HEAD");
  const stamp = `${JSON.stringify(
    {
      name: "stamped-app",
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    null,
    2,
  )}\n`;

  const currentRepo = makeStampedRepository(
    { [TEMPLATE_JSON_FILE]: stamp },
    "stamped-app",
  );
  expect(
    resolveTemplateUpgradeInputs({
      templateRoot: ROOT,
      repository: currentRepo,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  ).toMatchObject({
    baseCommit,
    targetCommit,
    repositoryName: "stamped-app",
    sourcePacket: "/abs/packet",
  });

  const oldStamp = `${JSON.stringify(
    {
      name: "stamped-app",
      specRevision: "4",
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
      entryPoint: "src/cli.ts",
      commandOwner: "src/commands.ts",
      registrationVersion: 1,
    },
    null,
    2,
  )}\n`;
  const oldRepo = makeStampedRepository(
    { [OLD_TEMPLATE_JSON_FILE]: oldStamp },
    "stamped-app",
  );
  expect(
    resolveTemplateUpgradeInputs({
      templateRoot: ROOT,
      repository: oldRepo,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  ).toMatchObject({
    baseCommit,
    targetCommit,
    repositoryName: "stamped-app",
    sourcePacket: "/abs/packet",
  });
});

test("refuses when both .template.json and .cli-design-template.json are committed at HEAD, naming which file to delete", () => {
  const stamp = `${JSON.stringify(
    {
      name: "demo",
      templateRevision: TEMPLATE_UPGRADE_FLOOR,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    null,
    2,
  )}\n`;
  const repository = makeStampedRepository({
    [TEMPLATE_JSON_FILE]: stamp,
    [OLD_TEMPLATE_JSON_FILE]: stamp,
  });

  const refusal = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot: ROOT,
      repository,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  );
  expect(refusal.code).toBe("stamp_duplicate");
  expect(refusal.message).toContain(TEMPLATE_JSON_FILE);
  expect(refusal.message).toContain(OLD_TEMPLATE_JSON_FILE);
  expect(refusal.repair).toContain(`delete ${OLD_TEMPLATE_JSON_FILE}`);
});

test("withTemplateUpgradeTrees refuses when regeneration writes both stamp files", async () => {
  const templateRoot = folder("stamp-template-");
  initRepository(templateRoot);
  const pinText = readFileSync(join(ROOT, kernelPinFile), "utf8");
  const pinnedCommit = parseKernelPin(pinText).commit;
  const duplicateStampBootstrap = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const dest = process.argv[process.argv.indexOf("--destination") + 1] ?? "";',
    "mkdirSync(dest, { recursive: true });",
    'const stamp = JSON.stringify({ templateRevision: "0".repeat(40), templateDirty: false, sourcePacket: "/abs/packet" });',
    'writeFileSync(join(dest, ".template.json"), stamp);',
    'writeFileSync(join(dest, ".cli-design-template.json"), stamp);',
  ].join("\n");
  const first = commitIn(templateRoot, "duplicate stamp base", {
    [kernelPinFile]: pinText,
    "src/bootstrap.ts": `${duplicateStampBootstrap}\n`,
  });
  const second = commitIn(templateRoot, "duplicate stamp target", {
    "README.md": "next\n",
  });
  const repository = makeStampedRepository({
    [TEMPLATE_JSON_FILE]: `${JSON.stringify({ name: "demo", templateRevision: first.sha, templateDirty: false, sourcePacket: "/abs/packet" }, null, 2)}\n`,
  });
  const repositoryHead = git(repository, "rev-parse", "HEAD");
  const refusal = await captureAsyncCliError(() =>
    withTemplateUpgradeTrees(
      {
        templateRoot,
        repository,
        repositoryHead,
        baseCommit: first.sha,
        targetCommit: second.sha,
        repositoryName: "demo",
        packageName: "demo",
        sourcePacket: "/abs/packet",
        repositoryPinnedCommit: pinnedCommit,
        templatePinnedCommit: pinnedCommit,
        checkLimitSeconds: 900,
      },
      { ...gitEnv, KERNEL_REPOSITORY: folder("stamp-kernel-") },
      () => Promise.resolve("unreachable"),
    ),
  );
  expect(refusal.code).toBe("regeneration_stamp_duplicate");
  expect(refusal.message).toContain(TEMPLATE_JSON_FILE);
  expect(refusal.message).toContain(OLD_TEMPLATE_JSON_FILE);
  expect(refusal.repair).toContain(TEMPLATE_JSON_FILE);
});

test("moves a repository's old .cli-design-template.json stamp to .template.json during tree merge", async () => {
  const renameOld = folder("stamp-rename-old-");
  const renameNew = folder("stamp-rename-new-");
  const renameOurs = folder("stamp-rename-ours-");
  write(renameOld, OLD_TEMPLATE_JSON_FILE, '{"templateRevision":"old"}\n');
  write(renameNew, TEMPLATE_JSON_FILE, '{"templateRevision":"new"}\n');
  write(
    renameOurs,
    OLD_TEMPLATE_JSON_FILE,
    '{"templateRevision":"hand-edited"}\n',
  );

  const renameRows = await mergeTemplateUpgradeTrees(
    renameOld,
    renameNew,
    renameOurs,
  );
  expect(renameRows).toEqual([
    {
      path: OLD_TEMPLATE_JSON_FILE,
      ownerLabel: "generated",
      outcome: "delete",
    },
    { path: TEMPLATE_JSON_FILE, ownerLabel: "generated", outcome: "take" },
  ]);
  expect(existsSync(join(renameOurs, OLD_TEMPLATE_JSON_FILE))).toBe(false);
  expect(readFileSync(join(renameOurs, TEMPLATE_JSON_FILE), "utf8")).toBe(
    '{"templateRevision":"new"}\n',
  );

  const residualOld = folder("stamp-residual-old-");
  const residualNew = folder("stamp-residual-new-");
  const residualOurs = folder("stamp-residual-ours-");
  write(residualOld, TEMPLATE_JSON_FILE, '{"templateRevision":"old"}\n');
  write(residualNew, TEMPLATE_JSON_FILE, '{"templateRevision":"new"}\n');
  write(residualOurs, OLD_TEMPLATE_JSON_FILE, '{"templateRevision":"old"}\n');

  const residualRows = await mergeTemplateUpgradeTrees(
    residualOld,
    residualNew,
    residualOurs,
  );
  expect(residualRows).toEqual([
    {
      path: OLD_TEMPLATE_JSON_FILE,
      ownerLabel: "generated",
      outcome: "delete",
    },
    { path: TEMPLATE_JSON_FILE, ownerLabel: "generated", outcome: "take" },
  ]);
  expect(existsSync(join(residualOurs, OLD_TEMPLATE_JSON_FILE))).toBe(false);
  expect(readFileSync(join(residualOurs, TEMPLATE_JSON_FILE), "utf8")).toBe(
    '{"templateRevision":"new"}\n',
  );
});

test(
  "template upgrade apply moves an existing repository from .cli-design-template.json with old fields to a trimmed .template.json",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const bootstrapPath = join(templateClone, "src/bootstrap.ts");
    const newBootstrapSource = readFileSync(bootstrapPath, "utf8");
    const oldBootstrapSource = newBootstrapSource
      .replace(
        "    sourcePacket: options.sourcePacket,\n  };",
        [
          '    specRevision: "4",',
          "    sourcePacket: options.sourcePacket,",
          '    entryPoint: "src/cli.ts",',
          '    commandOwner: "src/commands.ts",',
          "    registrationVersion: 1,",
          "  };",
        ].join("\n"),
      )
      .replace(
        "join(staging, TEMPLATE_JSON_FILE)",
        'join(staging, ".cli-design-template.json")',
      );
    expect(oldBootstrapSource).toContain('specRevision: "4"');
    expect(oldBootstrapSource).toContain(
      'join(staging, ".cli-design-template.json")',
    );
    writeFileSync(bootstrapPath, oldBootstrapSource);
    git(templateClone, "add", "--", "src/bootstrap.ts");
    git(templateClone, "commit", "--quiet", "-m", "old stamp name and fields");
    const oldStampCommit = git(templateClone, "rev-parse", "HEAD");

    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      oldStampCommit,
      "old-stamp-app",
    );
    expect(existsSync(join(repo, OLD_TEMPLATE_JSON_FILE))).toBe(true);
    expect(existsSync(join(repo, TEMPLATE_JSON_FILE))).toBe(false);
    const oldStamp = JSON.parse(
      readFileSync(join(repo, OLD_TEMPLATE_JSON_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(oldStamp).toSorted()).toEqual([
      "commandOwner",
      "entryPoint",
      "name",
      "registrationVersion",
      "sourcePacket",
      "specRevision",
      "templateDirty",
      "templateRevision",
    ]);

    writeFileSync(bootstrapPath, newBootstrapSource);
    git(templateClone, "add", "--", "src/bootstrap.ts");
    git(templateClone, "commit", "--quiet", "-m", "rename and trim stamp");
    const newStampCommit = git(templateClone, "rev-parse", "HEAD");
    const branch = `template-upgrade/${oldStampCommit.slice(0, 7)}-${newStampCommit.slice(0, 7)}`;

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, newStampCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);
    expect(applyRun.stderr).toBe("");
    const applied = JSON.parse(applyRun.stdout) as {
      status: string;
      branch: string;
      rows: { path: string; ownerLabel: string; outcome: string }[];
    };
    expect(applied.status).toBe("applied");
    expect(applied.branch).toBe(branch);
    const rowByPath = new Map(applied.rows.map((row) => [row.path, row]));
    expect(rowByPath.get(OLD_TEMPLATE_JSON_FILE)).toEqual({
      path: OLD_TEMPLATE_JSON_FILE,
      ownerLabel: "generated",
      outcome: "delete",
    });
    expect(rowByPath.get(TEMPLATE_JSON_FILE)).toEqual({
      path: TEMPLATE_JSON_FILE,
      ownerLabel: "generated",
      outcome: "take",
    });
    const branchFiles = git(repo, "ls-tree", "-r", "--name-only", branch).split(
      "\n",
    );
    expect(branchFiles).toContain(TEMPLATE_JSON_FILE);
    expect(branchFiles).not.toContain(OLD_TEMPLATE_JSON_FILE);
    const upgradedStamp = JSON.parse(
      gitOutput(repo, "show", `${branch}:${TEMPLATE_JSON_FILE}`),
    ) as Record<string, unknown>;
    expect(upgradedStamp).toEqual({
      name: "old-stamp-app",
      templateRevision: newStampCommit,
      templateDirty: false,
      sourcePacket: "/abs/packets/e2e-demo",
    });
  },
  processWatchdog(4),
);
