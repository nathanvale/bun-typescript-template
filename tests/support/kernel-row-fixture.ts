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

function withIsolatedGit<Result>(work: () => Promise<Result>): Promise<Result> {
  return withEnvironment(gitEnv, work);
}

export async function withEnvironment<Result>(
  variables: Readonly<Record<string, string>>,
  work: () => Promise<Result>,
): Promise<Result> {
  const before = new Map(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, variables);
  try {
    return await work();
  } finally {
    for (const [name, value] of before)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
  }
}

export function bootstrapRow(
  request: KernelBootstrap,
): Promise<BootstrapResult> {
  return withIsolatedGit(() => bootstrapWithKernel(request));
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
