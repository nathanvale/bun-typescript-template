import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDED_HITS_FILES } from "../../../src/recipe.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";
import {
  branchName,
  commitFallowGateChange,
  createRecordedHitsGrowthHelpers,
  expectGrowthRefusal,
  HEALTH_FILE,
  healthHitJson,
  healthJson,
  worktreePath,
} from "../../support/template-upgrade-recorded-hits-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();
const { applyJson } = createRecordedHitsGrowthHelpers(folder, captureStream);

const ADVISORY_TARGET_KEYS = [
  "src/cli.ts:hidden coupling",
  "src/commands.ts:high impact",
  "tests/cli.test.ts:untested risk",
  "src/a.ts:complexity",
  "src/b.ts:coupling",
  "src/c.ts:dead code",
];

test(
  "drops advisory target_keys additions in fallow-health-recorded-hits.json, keeps the file byte-identical to the base, and applies when bun run check passes without them",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "advisory-target-keys-app",
    );
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitFallowGateChange(templateClone);
    const branch = branchName(baseCommit, target);
    const advisoryHealth = healthJson({ target_keys: ADVISORY_TARGET_KEYS });
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-advisory-targets-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1 $2" = "run quality:fallow:record-hits" ]; then
cat <<'EOF' > ${HEALTH_FILE}
${advisoryHealth}EOF
fi
if [ "$1 $2" = "run check" ]; then
  if grep -q "hidden coupling" ${HEALTH_FILE}; then
    echo "advisory target_keys were not dropped before check" >&2
    exit 1
  fi
fi
exit 0
`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
    ]);
    const committed = Buffer.from(
      `${git(repo, "show", `${branch}:${HEALTH_FILE}`)}\n`,
    );
    expect(Buffer.compare(committed, baseBytes)).toBe(0);
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow and restores every recorded-hits file when recording adds a health finding that bun run check needs",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "needed-health-finding-app",
    );
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitFallowGateChange(templateClone);
    const worktree = worktreePath(repo, target);
    const neededHealth = healthHitJson("src/complex.ts");
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-needed-health-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1 $2" = "run quality:fallow:record-hits" ]; then
cat <<'EOF' > ${HEALTH_FILE}
${neededHealth}EOF
fi
exit 0
`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expectGrowthRefusal(
      run,
      repo,
      branchName(baseCommit, target),
      worktree,
      baseBytes,
      ["src/complex.ts\u0000calculate"],
      true,
    );
    for (const file of RECORDED_HITS_FILES) {
      expect(
        Buffer.compare(
          readFileSync(join(worktree, file)),
          readFileSync(join(repo, file)),
        ),
      ).toBe(0);
    }
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow and restores every recorded-hits file when recording mixes advisory target_keys with a health finding that bun run check needs",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "mixed-advisory-and-needed-app",
    );
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitFallowGateChange(templateClone);
    const worktree = worktreePath(repo, target);
    const mixedHealth = healthJson({
      finding_counts: { "src/complex.ts": { complexity_high: { count: 1 } } },
      identity_finding_counts: {
        "src/complex.ts\u0000calculate": { complexity_high: { count: 1 } },
      },
      target_keys: ADVISORY_TARGET_KEYS,
    });
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-mixed-health-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1 $2" = "run quality:fallow:record-hits" ]; then
cat <<'EOF' > ${HEALTH_FILE}
${mixedHealth}EOF
fi
exit 0
`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expectGrowthRefusal(
      run,
      repo,
      branchName(baseCommit, target),
      worktree,
      baseBytes,
      ["src/complex.ts\u0000calculate"],
      true,
    );
    for (const file of RECORDED_HITS_FILES) {
      expect(
        Buffer.compare(
          readFileSync(join(worktree, file)),
          readFileSync(join(repo, file)),
        ),
      ).toBe(0);
    }
  },
  processWatchdog(4),
);
