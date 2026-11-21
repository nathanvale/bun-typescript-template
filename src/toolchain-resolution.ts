import { createRequire } from "node:module";
import { join } from "node:path";

function packageDocument(value: unknown): object {
  if (value === null || typeof value !== "object")
    throw new Error("The installed package has no identity document.");
  return value;
}

function version(value: unknown): string {
  const document = packageDocument(value);
  const identity: unknown = Object.hasOwn(document, "version")
    ? Reflect.get(document, "version")
    : undefined;
  if (typeof identity !== "string")
    throw new Error("The installed package has no version identity.");
  return identity;
}

const accepted = {
  lint: "6.0.2",
  compiler: "7.1.0-beta",
  semantic: "7.0.2",
} as const;

function acceptedBackends(
  lint: string,
  lintPackage: string,
  compiler: string,
  semantic: string,
): void {
  if (
    lint !== accepted.lint ||
    lintPackage !== accepted.lint ||
    compiler !== accepted.compiler ||
    semantic !== accepted.semantic
  )
    throw new Error(
      "The installed lint, compiler and semantic backends do not match the accepted toolchain.",
    );
}

export function resolveToolchain(repositoryRoot: string) {
  const local = createRequire(join(repositoryRoot, "package.json"));
  const eslint = createRequire(local.resolve("typescript-eslint"));
  const companion = createRequire(
    local.resolve("fallow-type-aware/package.json"),
  );
  const lint: unknown = eslint("typescript");
  const lintPackage: unknown = eslint("typescript/package.json");
  const native: unknown = local("@typescript/native/package.json");
  const semantic: unknown = companion("typescript/package.json");
  const compiler = Bun.spawnSync(
    [join(repositoryRoot, "node_modules/.bin/tsc"), "--version"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (
    compiler.exitCode !== 0 ||
    compiler.stdout.toString().trim() !== `Version ${accepted.compiler}`
  )
    throw new Error(
      `The compiler is not native TypeScript ${accepted.compiler}.`,
    );
  const receipt = {
    lint: version(lint),
    lintPackage: version(lintPackage),
    compiler: version(native),
    semantic: version(semantic),
    compilerExecutable: compiler.stdout.toString().trim(),
  };
  acceptedBackends(
    receipt.lint,
    receipt.lintPackage,
    receipt.compiler,
    receipt.semantic,
  );
  return receipt;
}
