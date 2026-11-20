import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { kernelClone, trialBase } from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();
const sibling = "./.github/actions/kernel-sibling";

type Step = { readonly uses?: string; readonly run?: string };
type Job = {
  readonly env?: Record<string, string>;
  readonly steps: readonly Step[];
};

function jobOf(workflow: string, job: string): Job {
  const parsed = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows", workflow), "utf8"),
  ) as { jobs: Record<string, Job> };
  const found = parsed.jobs[job];
  if (found === undefined) throw new Error(`${workflow} has no job ${job}.`);
  return found;
}

function order(steps: readonly Step[], runs: string) {
  return {
    checkout: steps.findIndex(({ uses }) =>
      uses?.startsWith("actions/checkout"),
    ),
    sibling: steps.findIndex(({ uses }) => uses === sibling),
    tests: steps.findIndex(({ run }) => run?.includes(runs)),
  };
}

function actionScript(): string {
  const action = Bun.YAML.parse(
    readFileSync(
      join(ROOT, ".github/actions/kernel-sibling/action.yml"),
      "utf8",
    ),
  ) as { runs: { steps: readonly Step[] } };
  const [step] = action.runs.steps;
  if (step?.run === undefined) throw new Error("The action runs no script.");
  return step.run;
}

describe("the hosted check", () => {
  test.each([
    ["ci.yml", "test", "bun run test"],
    ["ci.yml", "fault-replay", "bun run fault-replay"],
    ["macos-nightly.yml", "check", "bun run check"],
  ])(
    "%s job %s places the kernel repository beside the template after its checkout and before its tests",
    (workflow, job, runs) => {
      const {
        checkout,
        sibling: placed,
        tests,
      } = order(jobOf(workflow, job).steps, runs);
      expect([checkout >= 0, checkout < placed, placed < tests]).toEqual([
        true,
        true,
        true,
      ]);
    },
  );

  test("the fault replay job names the kernel repository in KERNEL_REPOSITORY, because it runs each test in a temporary worktree that has no sibling", () => {
    expect(jobOf("ci.yml", "fault-replay").env).toEqual({
      KERNEL_REPOSITORY: "${{ github.workspace }}/../agent-cli-kernel",
    });
  });

  test(
    "its step clones the remote the kernel pin names, with its history, into the folder beside the template, at the pinned commit",
    async () => {
      const work = folder("hosted-check-");
      const remote = kernelClone(join(work, "remote"), trialBase);
      const template = join(work, "runner/template");
      mkdirSync(template, { recursive: true });
      writeFileSync(
        join(template, kernelPinFile),
        JSON.stringify({ ...readKernelPin(ROOT), remote, commit: trialBase }),
      );
      const run = await spawnBounded(["bash", "-e", "-c", actionScript()], {
        cwd: template,
        env: { ...inherited(), ...gitEnv },
        processGroup: true,
      });
      expect(run).toMatchObject({ exit: 0, stderr: "" });
      const placed = join(work, "runner", readKernelPin(ROOT).repository);
      expect([
        git(placed, "rev-parse", "HEAD"),
        git(placed, "rev-list", "--count", "HEAD") === "1",
      ]).toEqual([trialBase, false]);
    },
    processWatchdog(1),
  );
});
