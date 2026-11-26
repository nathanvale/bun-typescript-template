import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generatedPin,
  kernelPinFile,
  readKernelPin,
} from "../../../src/kernel-pin.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { commitObjects } from "../../support/git-object-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import {
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
  templateCommitHoldingS5,
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  pinnedTemplate,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();

type PinEnvelope = {
  readonly message: string;
  readonly result: {
    readonly commandIdentity: string;
    readonly causeCode: string;
    readonly outcome: string;
    readonly effectClass: string;
    readonly exitCode: number;
    readonly repairAction: string | null;
    readonly data: unknown;
  };
  readonly diagnostics?: {
    readonly status: string;
    readonly file: string | null;
  };
};

async function runPinCli(
  root: string,
  args: readonly string[],
  stateHome: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly boundMilliseconds?: number;
  } = {},
) {
  const result = await spawnBounded(
    [process.execPath, join(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      env: {
        ...inherited(),
        ...gitEnv,
        ...options.env,
        XDG_STATE_HOME: stateHome,
      },
      ...(options.boundMilliseconds === undefined
        ? {}
        : { boundMilliseconds: options.boundMilliseconds }),
    },
  );
  return {
    exitCode: result.exit,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function diagnosticsRecords(stateHome: string): unknown[] {
  const dir = join(
    stateHome,
    "my-agent-dojo",
    "bun-typescript-template",
    "diagnostics",
  );
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  return files.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown),
  );
}

function copyTemplateWithModules(
  commit: string,
  omit: readonly string[] = [],
): string {
  const copy = templateCopy(folder("pin-cli-copy-"), omit);
  pinnedTemplate(copy, commit, pin.carryOutIdentity);
  if (!existsSync(join(copy, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
  }
  return copy;
}

function remotePathEnv(remoteRepository: string): {
  readonly PATH: string;
} {
  const remoteBin = folder("pin-cli-remote-bin-");
  mkdirSync(remoteBin, { recursive: true });
  gitReadingRemoteAs(remoteBin, pin.remote, remoteRepository);
  return { PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}` };
}

describe("cli front door pin routes", () => {
  test(
    "--discover-all lists pin verify, pin plan, and pin move with their identities and effect classes, and each answers --help",
    async () => {
      const stateHome = folder("pin-cli-state-");
      const discover = await runPinCli(
        ROOT,
        ["--discover-all", "--json"],
        stateHome,
      );
      expect(discover.exitCode).toBe(0);
      expect(discover.stderr).toBe("");
      const envelope = JSON.parse(discover.stdout) as {
        readonly result: {
          readonly data: {
            readonly commands: readonly {
              readonly command: {
                readonly commandIdentity: string;
                readonly effectClass: string;
                readonly route: readonly string[];
              };
            }[];
          };
        };
      };
      const expected = [
        {
          commandIdentity: "bun-typescript-template.pin.verify",
          effectClass: "inspect",
          route: ["pin", "verify"],
        },
        {
          commandIdentity: "bun-typescript-template.pin.plan",
          effectClass: "inspect",
          route: ["pin", "plan"],
        },
        {
          commandIdentity: "bun-typescript-template.pin.move",
          effectClass: "repository-local",
          route: ["pin", "move"],
        },
      ] as const;

      for (const spec of expected) {
        const listed = envelope.result.data.commands.find(
          (entry) => entry.command.commandIdentity === spec.commandIdentity,
        );
        expect(listed?.command).toMatchObject(spec);

        const help = await runPinCli(
          ROOT,
          [...spec.route, "--help"],
          stateHome,
        );
        expect(help.exitCode).toBe(0);
        expect(help.stderr).toBe("");
        expect(help.stdout).toContain(spec.commandIdentity);
      }
    },
    processWatchdog(2),
  );

  test(
    "pin verify passes on this checkout with the kernel beside it and emits a diagnostics event",
    async () => {
      const stateHome = folder("pin-cli-state-");
      const kernel = siblingKernel();
      const run = await runPinCli(
        ROOT,
        ["pin", "verify", "--kernel", kernel, "--json"],
        stateHome,
        { env: remotePathEnv(kernel) },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.commandIdentity).toBe(
        "bun-typescript-template.pin.verify",
      );
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.result.outcome).toBe("success");
      expect(envelope.result.effectClass).toBe("inspect");
      expect(envelope.message).toContain(`Pin verified: ${pin.commit}`);
      expect(envelope.diagnostics?.status).toBe("available");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "pin verify refuses DOMAIN_PIN_PLACES_DISAGREE in an envelope when package.json disagrees with kernel-pin.json",
    async () => {
      const copy = copyTemplateWithModules(pin.commit);
      const otherCommit = "1111111111111111111111111111111111111111";
      writeFileSync(
        join(copy, "package.json"),
        `${JSON.stringify(
          {
            dependencies: {
              "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${otherCommit}`,
            },
          },
          null,
          2,
        )}\n`,
      );
      const stateHome = folder("pin-cli-state-");
      const run = await runPinCli(
        copy,
        ["pin", "verify", "--kernel", siblingKernel(), "--json"],
        stateHome,
      );
      expect(run.exitCode).toBe(3);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.commandIdentity).toBe(
        "bun-typescript-template.pin.verify",
      );
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_PLACES_DISAGREE");
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.message).toContain(pin.commit);
      expect(envelope.message).toContain(otherCommit);
      expect(envelope.result.repairAction).toContain("bun run pin:move");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "pin verify refuses DOMAIN_PIN_PLACES_DISAGREE when bun.lock disagrees with kernel-pin.json",
    async () => {
      const copy = copyTemplateWithModules(pin.commit);
      const otherCommit = "2222222222222222222222222222222222222222";
      writeFileSync(
        join(copy, "bun.lock"),
        `{\n  "workspaces": { "": { "dependencies": { "agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${pin.commit}" } } },\n  "packages": { "agent-cli-kernel": ["agent-cli-kernel@github:nathanvale/agent-cli-kernel#${otherCommit.slice(0, 7)}", {}, "nathanvale-agent-cli-kernel-${otherCommit.slice(0, 7)}", "sha512-x"] }\n}\n`,
      );
      const stateHome = folder("pin-cli-state-");
      const run = await runPinCli(
        copy,
        ["pin", "verify", "--kernel", siblingKernel(), "--json"],
        stateHome,
      );
      expect(run.exitCode).toBe(3);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_PLACES_DISAGREE");
      expect(envelope.message).toContain("bun.lock");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "pin plan previews a repository pin move as inspect and writes nothing",
    async () => {
      const kernelRepo = kernelClone(folder("pin-cli-plan-kernel-"), trialBase);
      const nextCommit = commitOn(kernelRepo, [trialBase], "plan test commit");
      moveBranch(kernelRepo, "main", nextCommit);
      const remoteBin = folder("pin-cli-plan-bin-");
      mkdirSync(remoteBin, { recursive: true });
      gitReadingRemoteAs(remoteBin, pin.remote, kernelRepo);

      const generatedRepo = folder("pin-cli-plan-repo-");
      initRepository(generatedRepo);
      const pinSpecifier = `git+${pathToFileURL(realpathSync(kernelRepo)).href}#${trialBase}`;
      commitIn(generatedRepo, "initial pin", {
        "package.json": `${JSON.stringify(
          {
            name: "plan-fixture",
            dependencies: { "agent-cli-kernel": pinSpecifier },
          },
          null,
          2,
        )}\n`,
      });
      const beforeHead = git(generatedRepo, "rev-parse", "HEAD");
      const stateHome = folder("pin-cli-state-");

      const run = await runPinCli(
        ROOT,
        [
          "pin",
          "plan",
          nextCommit,
          "--kernel",
          kernelRepo,
          "--repository",
          generatedRepo,
          "--json",
        ],
        stateHome,
        { env: { PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}` } },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.commandIdentity).toBe(
        "bun-typescript-template.pin.plan",
      );
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.result.effectClass).toBe("inspect");
      expect(envelope.message).toContain("Plan only");
      expect(git(generatedRepo, "rev-parse", "HEAD")).toBe(beforeHead);
      expect(
        git(generatedRepo, "status", "--porcelain", "--untracked-files=all"),
      ).toBe("");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "pin move in template mode refuses unreachable and before-carry-out commits with DOMAIN_PIN_* causes and repairs",
    async () => {
      const copy = copyTemplateWithModules(trialBase);
      const repository = kernelClone(
        folder("pin-cli-refuse-kernel-"),
        trialBase,
      );
      const unpushed = commitOn(repository, [trialBase], "not pushed");
      moveBranch(repository, "main", unpushed);
      const stateHome = folder("pin-cli-state-");

      const unreachable = await runPinCli(
        copy,
        ["pin", "move", unpushed, "--kernel", repository, "--json"],
        stateHome,
        { env: remotePathEnv(siblingKernel()) },
      );
      expect(unreachable.exitCode).toBe(3);
      expect(unreachable.stderr).toBe("");
      const unreachableEnv = JSON.parse(unreachable.stdout) as PinEnvelope;
      expect(unreachableEnv.result.causeCode).toBe(
        "DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE",
      );
      expect(unreachableEnv.result.repairAction).toContain(
        "Push the commit there first if it is only local.",
      );

      const beforeCarryOut = await runPinCli(
        copy,
        [
          "pin",
          "move",
          templateCommitHoldingS5,
          "--kernel",
          siblingKernel(),
          "--json",
        ],
        stateHome,
        { env: remotePathEnv(siblingKernel()) },
      );
      expect(beforeCarryOut.exitCode).toBe(3);
      expect(beforeCarryOut.stderr).toBe("");
      const beforeEnv = JSON.parse(beforeCarryOut.stdout) as PinEnvelope;
      expect(beforeEnv.result.causeCode).toBe(
        "DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT",
      );
      expect(beforeEnv.result.repairAction).toContain(
        "A pin never names a commit from before the carry-out.",
      );
    },
    processWatchdog(2),
  );

  test(
    "pin plan refuses a malformed kernel changeset with DOMAIN_PIN_CHANGESET_INVALID",
    async () => {
      const kernelRepo = kernelClone(
        folder("pin-cli-bad-changeset-kernel-"),
        trialBase,
      );
      git(kernelRepo, "read-tree", trialBase);
      const badCommit = commitObjects(kernelRepo, "add malformed changeset", [
        {
          path: ".changeset/2026-11-24-broken.md",
          bytes: "missing frontmatter\n",
        },
      ]);
      moveBranch(kernelRepo, "main", badCommit);
      const remoteBin = folder("pin-cli-bad-changeset-bin-");
      mkdirSync(remoteBin, { recursive: true });
      gitReadingRemoteAs(remoteBin, pin.remote, kernelRepo);

      const generatedRepo = folder("pin-cli-bad-changeset-repo-");
      initRepository(generatedRepo);
      const pinSpecifier = `git+${pathToFileURL(realpathSync(kernelRepo)).href}#${trialBase}`;
      commitIn(generatedRepo, "initial pin", {
        "package.json": `${JSON.stringify(
          {
            name: "bad-changeset-fixture",
            dependencies: { "agent-cli-kernel": pinSpecifier },
          },
          null,
          2,
        )}\n`,
      });
      const stateHome = folder("pin-cli-state-");

      const run = await runPinCli(
        ROOT,
        [
          "pin",
          "plan",
          badCommit,
          "--kernel",
          kernelRepo,
          "--repository",
          generatedRepo,
          "--json",
        ],
        stateHome,
        { env: { PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}` } },
      );
      expect(run.exitCode).toBe(3);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_CHANGESET_INVALID");
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.result.repairAction).not.toBeNull();
    },
    processWatchdog(1),
  );

  test(
    "pin move in template mode writes kernel-pin.json, generated lockfile, package.json, and bun.lock at the new commit, and pin verify then passes",
    async () => {
      const copy = copyTemplateWithModules(trialBase, [KERNEL_LOCKFILE]);
      const stateHome = folder("pin-cli-move-state-");
      const kernel = siblingKernel();
      const env = remotePathEnv(kernel);
      const move = await runPinCli(
        copy,
        ["pin", "move", pin.commit, "--kernel", kernel, "--json"],
        stateHome,
        { env, boundMilliseconds: trialTimeout(1) - 10_000 },
      );
      expect(move.exitCode).toBe(0);
      expect(move.stderr).toBe("");
      const moveEnv = JSON.parse(move.stdout) as PinEnvelope;
      expect(moveEnv.result.commandIdentity).toBe(
        "bun-typescript-template.pin.move",
      );
      expect(moveEnv.result.causeCode).toBe("SUCCESS_COMPLETED");
      expect(moveEnv.result.effectClass).toBe("repository-local");

      expect(readKernelPin(copy).commit).toBe(pin.commit);
      expect(readFileSync(join(copy, KERNEL_LOCKFILE), "utf8")).toContain(
        generatedPin(pin, pin.commit),
      );
      const manifest = JSON.parse(
        readFileSync(join(copy, "package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      expect(manifest.dependencies["agent-cli-kernel"]).toBe(
        generatedPin(pin, pin.commit),
      );
      const lock = readFileSync(join(copy, "bun.lock"), "utf8");
      expect(lock).toContain(generatedPin(pin, pin.commit));
      expect(lock).toContain(
        `"agent-cli-kernel@github:nathanvale/agent-cli-kernel#${pin.commit.slice(0, 7)}"`,
      );
      expect(readFileSync(join(copy, kernelPinFile), "utf8")).toContain(
        pin.commit,
      );

      const verify = await runPinCli(
        copy,
        ["pin", "verify", "--kernel", kernel, "--json"],
        stateHome,
        { env },
      );
      expect(verify.exitCode).toBe(0);
      expect(verify.stderr).toBe("");
      const verifyEnv = JSON.parse(verify.stdout) as PinEnvelope;
      expect(verifyEnv.result.causeCode).toBe("SUCCESS_UNCHANGED");
    },
    trialTimeout(1),
  );
});
