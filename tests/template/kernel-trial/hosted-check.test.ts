import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitEnv, inherited } from "../../support/git-fixture.ts";
import {
  commitOn,
  kernelClone,
  moveBranch,
  trialBase,
} from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();
const sibling = "./.github/actions/kernel-sibling";

type Step = { readonly uses?: string; readonly run?: string };
type Job = {
  readonly env?: Record<string, string>;
  readonly steps: readonly Step[];
};

type Workflow = {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
};

const workflows = join(ROOT, ".github/workflows");

function workflowOf(workflow: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(join(workflows, workflow), "utf8"),
  ) as Workflow;
}

function jobOf(workflow: string, job: string): Job {
  const found = workflowOf(workflow).jobs[job];
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
    ["pin-verification.yml", "pin-verification", "bun run pin-verification"],
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

  test("the pin verification workflow runs on every pull request, on every push to main, by hand, and once a week", () => {
    const { on } = workflowOf("pin-verification.yml");
    const [cron = ""] = (
      on.schedule as readonly { readonly cron: string }[]
    ).map(({ cron }) => cron);
    const [, , dayOfMonth, month, dayOfWeek] = cron.split(" ");
    const weekly = [dayOfMonth, month, /^[0-6]$/.test(dayOfWeek ?? "")];
    expect({ ...on, schedule: weekly } as unknown).toEqual({
      pull_request: null,
      push: { branches: ["main"] },
      schedule: ["*", "*", true],
      workflow_dispatch: null,
    });
  });

  test("no workflow filters its pull requests or pushes by path, because a required check that a path filter skips never reports and blocks merging", () => {
    const filtered = readdirSync(workflows).flatMap((workflow) =>
      ["pull_request", "push"].flatMap((event) => {
        const trigger = Object(workflowOf(workflow).on[event]) as object;
        return ["paths", "paths-ignore"]
          .filter((filter) => Object.hasOwn(trigger, filter))
          .map((filter) => `${workflow} ${event} ${filter}`);
      }),
    );
    expect(filtered).toEqual([]);
  });

  test(
    "its step fails, and so does its job, when the kernel pin names a commit the remote does not hold",
    async () => {
      const work = folder("hosted-check-");
      const remote = kernelClone(join(work, "remote"), trialBase);
      const template = join(work, "runner/template");
      mkdirSync(template, { recursive: true });
      const absent = "0123456789abcdef0123456789abcdef01234567";
      writeFileSync(
        join(template, kernelPinFile),
        JSON.stringify({ ...readKernelPin(ROOT), remote, commit: absent }),
      );
      const run = await spawnBounded(["bash", "-e", "-c", actionScript()], {
        cwd: template,
        env: { ...inherited(), ...gitEnv },
        processGroup: true,
      });
      expect(run.exit).not.toBe(0);
      expect(run.stderr).toContain(absent);
    },
    processWatchdog(1),
  );

  test(
    "its step clones the remote the kernel pin names, with its history, into the folder beside the template, at the pinned commit",
    async () => {
      const work = folder("hosted-check-");
      const remote = kernelClone(join(work, "remote"), trialBase);
      moveBranch(
        remote,
        "main",
        commitOn(remote, [trialBase], "a commit after the pinned one"),
      );
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
