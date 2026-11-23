import { expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { kernelCachePath, readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  bareRemote,
  holds,
  kernelCacheEnv,
} from "../../support/kernel-cache-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  invokeTemplateUpgradeMain,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();
const { repository: kernelName, commit: pinnedCommit } = readKernelPin(ROOT);

test(
  "upgrade plan with neither KERNEL_REPOSITORY nor a sibling repository fills the kernel cache, and a second run plans from the cache with the remote gone",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "cache-app",
    );
    const targetCommit = commitTemplateLintChange(templateClone);
    const remoteFolder = folder("upgrade-cache-remote-");
    const bare = bareRemote(remoteFolder);
    const env = kernelCacheEnv(bare, folder("upgrade-cache-home-"));
    const cache = kernelCachePath(env);
    expect(existsSync(join(dirname(templateClone), kernelName))).toBe(false);
    expect(existsSync(cache)).toBe(false);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const plan = () =>
      invokeTemplateUpgradeMain(
        stdout,
        stderr,
        ["plan", "--repository", repo, "--to", targetCommit, "--json"],
        { templateRoot: templateClone, env },
      );

    const first = await plan();
    expect([first.exitCode, first.stderr]).toEqual([0, ""]);
    expect(JSON.parse(first.stdout)).toMatchObject({ status: "planned" });
    expect(holds(cache, pinnedCommit)).toBe(true);

    renameSync(bare, join(remoteFolder, "gone.git"));
    const second = await plan();
    expect([second.exitCode, second.stderr]).toEqual([0, ""]);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: "planned" });
  },
  processWatchdog(6),
);
