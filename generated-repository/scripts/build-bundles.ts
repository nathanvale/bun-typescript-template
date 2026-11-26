import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Bundle = { readonly output: string; readonly entry: string };

const KERNEL = "agent-cli-kernel";
const USAGE = "Usage: bun scripts/build-bundles.ts [--check]\n";
const REBUILD =
  "run bun install --frozen-lockfile, then bun run build:bundles.";

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repair: string,
  ) {
    super(message);
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return new Map(Object.entries(value)).get(key);
}

function readJson(root: string, file: string): unknown {
  try {
    return Bun.JSONC.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    throw new Error(
      `${file} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}. Repair: restore ${file}, then run this script again.`,
      { cause: error },
    );
  }
}

function plainPath(path: string, extension: string): boolean {
  return (
    path.endsWith(extension) &&
    !path.startsWith("/") &&
    !/[\\\0]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function readBundles(manifest: unknown): Bundle[] {
  const listed = field(manifest, "bundles");
  if (listed === undefined) return [];
  const shape = `package.json "bundles" is not an object from output .mjs paths to entry .ts paths, each relative to the repository root. Repair: write it as { "<folder>/dist/<name>.mjs": "<folder>/src/<name>.ts" }, then run this script again.`;
  if (typeof listed !== "object" || listed === null || Array.isArray(listed))
    throw new Error(shape);
  return Object.entries(listed)
    .map(([output, entry]: [string, unknown]) => {
      if (
        typeof entry !== "string" ||
        !plainPath(output, ".mjs") ||
        !plainPath(entry, ".ts")
      )
        throw new Error(shape);
      return { output, entry };
    })
    .toSorted((a, b) => (a.output < b.output ? -1 : 1));
}

function kernelCommit(root: string, manifest: unknown): string {
  const spec = field(field(manifest, "dependencies"), KERNEL);
  const pinned =
    typeof spec === "string" ? /#([0-9a-f]{40})$/.exec(spec)?.[1] : undefined;
  if (pinned === undefined)
    throw new Refusal(
      "bundle_kernel_mismatch",
      `package.json does not pin dependencies["${KERNEL}"] to a full 40-character commit, so no bundle can be stamped.`,
      `pin ${KERNEL} to a full commit, then ${REBUILD}`,
    );
  const lock =
    lstatSync(join(root, "bun.lock"), { throwIfNoEntry: false })?.isFile() ===
    true
      ? readJson(root, "bun.lock")
      : undefined;
  const resolution = field(field(lock, "packages"), KERNEL);
  const resolved: unknown = Array.isArray(resolution) ? resolution[0] : "";
  const commit =
    typeof resolved === "string"
      ? /#([0-9a-f]{7,40})$/.exec(resolved)?.[1]
      : undefined;
  if (commit === undefined || !pinned.startsWith(commit))
    throw new Refusal(
      "bundle_kernel_mismatch",
      `package.json pins ${KERNEL} at ${pinned}, and bun.lock resolves ${commit ?? `no ${KERNEL} commit`}.`,
      `run bun install so bun.lock resolves the pinned commit, then ${REBUILD}`,
    );
  return pinned;
}

function requireEntries(root: string, bundles: readonly Bundle[]): void {
  const missing = bundles
    .map(({ entry }) => entry)
    .filter(
      (entry) =>
        lstatSync(join(root, entry), { throwIfNoEntry: false })?.isFile() !==
        true,
    );
  if (missing.length > 0)
    throw new Refusal(
      "bundle_entry_missing",
      `No entry file at ${missing.join(", ")}.`,
      `create each entry, or remove its bundle from package.json "bundles", then run bun run build:bundles.`,
    );
}

async function render(
  root: string,
  { entry }: Bundle,
  banner: string,
): Promise<Buffer> {
  const built = await Bun.build({
    entrypoints: [join(root, entry)],
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "none",
    banner,
    throw: false,
  });
  const [output] = built.outputs;
  if (!built.success || built.outputs.length !== 1 || output === undefined)
    throw new Error(
      `Bun.build cannot bundle ${entry} into one file: ${built.logs.map((log) => log.message).join("; ") || `${built.outputs.length} outputs`}. Repair: fix ${entry}, then run bun run build:bundles.`,
    );
  return Buffer.from(await output.arrayBuffer());
}

function readOutput(root: string, output: string): Buffer | undefined {
  const path = join(root, output);
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (found === undefined) return undefined;
  if (!found.isFile())
    throw new Error(
      `${output} is not a regular file. Repair: remove it, then run bun run build:bundles.`,
    );
  return readFileSync(path);
}

async function buildBundles(root: string, check: boolean): Promise<string> {
  const manifest = readJson(root, "package.json");
  const bundles = readBundles(manifest);
  if (bundles.length === 0) return "No bundles are listed in package.json.";
  const banner = `// bundle: ${KERNEL}@${kernelCommit(root, manifest)} bun@${Bun.version}`;
  requireEntries(root, bundles);
  const changed: string[] = [];
  for (const bundle of bundles) {
    const rendered = await render(root, bundle, banner);
    const current = readOutput(root, bundle.output);
    if (current?.equals(rendered) === true) continue;
    changed.push(
      current === undefined ? `${bundle.output} (missing)` : bundle.output,
    );
    if (check) continue;
    mkdirSync(dirname(join(root, bundle.output)), { recursive: true });
    writeFileSync(join(root, bundle.output), rendered);
  }
  if (check && changed.length > 0)
    throw new Refusal(
      "bundle_stale",
      `Stale bundles: ${changed.join(", ")}.`,
      REBUILD,
    );
  const count = `${bundles.length} bundle${bundles.length === 1 ? "" : "s"}`;
  if (check) return `Verified ${count} up to date.`;
  return `Built ${count}; rewrote ${changed.length === 0 ? "none" : changed.join(", ")}.`;
}

async function main(args: readonly string[], root: string): Promise<number> {
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !check) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    process.stdout.write(`${await buildBundles(root, check)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(
        `${error.code}: ${error.message}\nRepair: ${error.repair}\n`,
      );
      return 1;
    }
    process.stderr.write(
      `build-bundles: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (import.meta.main)
  process.exitCode = await main(process.argv.slice(2), process.cwd());
