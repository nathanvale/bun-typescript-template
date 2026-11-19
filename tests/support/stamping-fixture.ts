import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KernelRefusal } from "../../src/kernel-reader.ts";
import {
  bootstrapWithKernel,
  type KernelBootstrap,
} from "../../src/bootstrap.ts";
import { StampRefusal } from "../../src/stamping.ts";
import { ownedFolders } from "./fixture-files.ts";
import type { ObjectEntry } from "./git-object-fixture.ts";
import {
  declarationFor,
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
  type Layout,
} from "./kernel-repository-fixture.ts";

export type Refused = {
  readonly code: string;
  readonly message: string;
  readonly repair: string;
};

export type StampingRun = {
  readonly destination: string;
  readonly parent: string;
  readonly request: KernelBootstrap;
};

export const tokenText = "__REPOSITORY_NAME__ and __SOURCE_PACKET__\n";
export const notUtf8 = new Uint8Array([0xc3, 0x28, 0xff, 0x00, 0x80, 0x0a]);

export function declarationWith(
  layout: Layout,
  addons: Readonly<Record<string, readonly string[]>>,
) {
  const declaration = declarationFor(layout);
  const rows = Object.values(declaration.addons);
  return {
    ...declaration,
    addons: Object.fromEntries(
      Object.entries(addons).map(([name, requires], index) => [
        name,
        { ...rows[index], requires },
      ]),
    ),
  };
}

// Interface: a small kernel repository in a test folder and a request that
// bootstraps a repository from it into a folder that does not exist yet.
export function stampingFixture() {
  const folder = ownedFolders();
  return (
    options: {
      readonly layout?: Layout;
      readonly entries?: readonly ObjectEntry[];
      readonly addons?: readonly string[];
      readonly lockfile?: KernelBootstrap["lockfile"];
    } = {},
  ): StampingRun => {
    const layout = options.layout ?? firstLayout;
    const kernel = folder("stamping-kernel-");
    const commit = kernelRepository(
      kernel,
      options.entries ?? kernelEntries(layout),
    );
    const parent = join(folder("stamping-out-"), "nested");
    const destination = join(parent, "demo-app");
    return {
      destination,
      parent,
      request: {
        destination,
        name: "demo-app",
        sourcePacket: "/abs/packets/demo",
        kernel: { repository: kernel, commit },
        kernelRepository: "small-kernel",
        declarationPath: declarationPathIn(layout),
        addons: options.addons ?? [],
        lockfile: options.lockfile ?? { source: "none" },
      },
    };
  };
}

export async function refusalOf(request: KernelBootstrap): Promise<Refused> {
  try {
    await bootstrapWithKernel(request);
  } catch (error) {
    if (error instanceof StampRefusal || error instanceof KernelRefusal)
      return { code: error.code, message: error.message, repair: error.repair };
    throw error;
  }
  throw new Error("The bootstrap was not refused.");
}

// Interface: what a refused run left in the folder that would hold the
// generated repository, or "no folder" when it never made that folder.
export function leftBehind({
  parent,
}: StampingRun): readonly string[] | "no folder" {
  return existsSync(parent) ? readdirSync(parent) : "no folder";
}

export function generatedJson(destination: string, path: string) {
  const parsed: unknown = JSON.parse(
    readFileSync(join(destination, path), "utf8"),
  );
  return parsed;
}
