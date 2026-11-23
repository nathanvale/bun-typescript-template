import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kernelCachePath, readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import {
  bareRemote,
  holds,
  kernelCacheEnv,
} from "../../support/kernel-cache-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { cloneTemplateAtHead } from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const { repository: kernelName, commit: pinnedCommit } = readKernelPin(ROOT);

test(
  "two Bootstraps at once with neither KERNEL_REPOSITORY nor a sibling repository both read the kernel through one kernel cache, cloned once into place",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const env = kernelCacheEnv(
      bareRemote(folder("bootstrap-cache-remote-")),
      folder("bootstrap-cache-home-"),
    );
    const cache = kernelCachePath(env);
    expect(existsSync(join(dirname(templateClone), kernelName))).toBe(false);
    expect(existsSync(cache)).toBe(false);
    const destinations = ["first", "second"].map((name) =>
      join(folder(`bootstrap-cache-${name}-`), name),
    );
    const runs = await Promise.all(
      destinations.map((destination) =>
        spawnBounded(
          [
            process.execPath,
            "run",
            join(templateClone, "src/bootstrap.ts"),
            "--destination",
            destination,
            "--source-packet",
            "/abs/packets/cache-demo",
            "--json",
          ],
          { cwd: templateClone, env, processGroup: true },
        ),
      ),
    );
    expect(runs.map(({ exit, stderr }) => [exit, stderr])).toEqual([
      [0, ""],
      [0, ""],
    ]);
    for (const destination of destinations)
      expect(readFileSync(join(destination, "package.json"), "utf8")).toContain(
        `"agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${pinnedCommit}"`,
      );
    expect(readdirSync(dirname(cache))).toEqual(["agent-cli-kernel.git"]);
    expect(git(cache, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(holds(cache, pinnedCommit)).toBe(true);
  },
  processWatchdog(2),
);
