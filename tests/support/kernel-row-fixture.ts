import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BootstrapResult,
  bootstrapWithKernel,
  type KernelBootstrap,
} from "../../src/bootstrap.ts";
import { KernelRefusal } from "../../src/kernel-reader.ts";
import { ownedFolders } from "./fixture-files.ts";
import { gitEnv } from "./git-fixture.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
  type Layout,
} from "./kernel-repository-fixture.ts";

export type KernelRowRun = {
  readonly destination: string;
  readonly parent: string;
  readonly request: KernelBootstrap;
};

// Interface: a small kernel repository in a test folder and a request that
// bootstraps a repository from it, through the kernel row, into a folder
// that does not exist yet.
export function kernelRowFixture() {
  const folder = ownedFolders();
  return (layout: Layout = firstLayout): KernelRowRun => {
    const kernel = folder("kernel-row-kernel-");
    const commit = kernelRepository(kernel, kernelEntries(layout));
    const parent = join(folder("kernel-row-out-"), "nested");
    const destination = join(parent, "demo-app");
    return {
      destination,
      parent,
      request: {
        destination,
        name: "demo-app",
        sourcePacket: "/abs/packets/demo",
        kernel: { repository: kernel, commit },
        declarationPath: declarationPathIn(layout),
        lockfile: "none",
      },
    };
  };
}

// Interface: Bootstrap through the kernel row in this process, with git
// isolated from the caller's configuration for the run, because Bootstrap
// reads the template's commit with git for Template provenance.
export async function bootstrapRow(
  request: KernelBootstrap,
): Promise<BootstrapResult> {
  const before = new Map(
    Object.keys(gitEnv).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, gitEnv);
  try {
    return await bootstrapWithKernel(request);
  } finally {
    for (const [name, value] of before)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
  }
}

export async function bootstrapRefusal(request: KernelBootstrap) {
  try {
    await bootstrapRow(request);
  } catch (error) {
    if (error instanceof KernelRefusal)
      return { code: error.code, message: error.message, repair: error.repair };
    throw error;
  }
  throw new Error("The bootstrap was not refused.");
}

// Interface: what a refused run left in the folder that would hold the
// generated repository, or "no folder" when it never made that folder.
export function leftBehind({
  parent,
}: KernelRowRun): readonly string[] | "no folder" {
  return existsSync(parent) ? readdirSync(parent) : "no folder";
}

export function generatedJson(destination: string, path: string) {
  const parsed: unknown = JSON.parse(
    readFileSync(join(destination, path), "utf8"),
  );
  return parsed;
}
