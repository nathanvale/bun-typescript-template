import { resolve, join, dirname } from "node:path";
import { afterEach } from "bun:test";
import {
  copyFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { testFolder } from "./test-folder.ts";
import {
  type Document as Fields,
  type Environment,
  type Profile,
  type Options,
  parseOptions,
} from "../../src/static-admission.ts";

export type Tree = Record<string, string>;

export const repository = resolve(import.meta.dir, "../..");

export const packet = join(repository, "profiles/static-admission");

export const policyFiles = [
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "biome.json",
  ".fallowrc.json",
  ".gitignore",
  "bunfig.toml",
  "eslint.config.mjs",
  "eslint-rules.mjs",
  "bun.lock",
];

export const ruleFiles = [
  "config/anti-slop-bindings.mjs",
  "config/anti-slop-rules.mjs",
  "config/anti-slop-type-rules.mjs",
  "config/payload-rules.mjs",
  "config/platform-rules.mjs",
  "config/template-rules.mjs",
];

export function copyRuleFiles(root: string): void {
  mkdirSync(join(root, "config"));
  for (const file of ruleFiles)
    copyFileSync(join(repository, file), join(root, file));
}

export function fields(value: unknown): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("The test expected a document.");
  return Object.fromEntries(Object.entries(value));
}

export function grow(root: string, tree: Tree): void {
  for (const [name, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

export function environment(): Environment {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("FALLOW_") && name !== "MARKER",
    ),
  );
}

export function optionsFor(
  project: string,
  profile: Profile = "simple",
): Options {
  return parseOptions(
    [project, profile, join(project, "evidence")],
    environment(),
  );
}

export const stubChildMilliseconds = 2_000;

export function evidenceOptions(
  project: string,
  childMilliseconds = stubChildMilliseconds,
): Options {
  const options = { ...optionsFor(project), childMilliseconds };
  mkdirSync(options.evidence, { recursive: true });
  return options;
}

export async function causeOf(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error && "causeCode" in error
      ? error.causeCode
      : error;
  }
  return "accepted";
}

export function editJson(
  root: string,
  file: string,
  change: (doc: Fields) => void,
) {
  const doc = fields(Bun.JSONC.parse(readFileSync(join(root, file), "utf8")));
  change(doc);
  writeFileSync(join(root, file), JSON.stringify(doc));
}

export function stubTool(project: string, name: string, body: string): void {
  const path = join(project, "node_modules/.bin", name);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

export function createAdmissionFolder(): () => string {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });

  function folder(): string {
    const root = testFolder("static-admission-process-");
    folders.push(root);
    return root;
  }

  return folder;
}
