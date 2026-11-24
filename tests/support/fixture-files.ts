import { afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { testFolder } from "./test-folder.ts";

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function writeExecutable(
  root: string,
  name: string,
  body: string,
): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export function ownedFolders(): (prefix: string) => string {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
  });
  return (prefix) => {
    const path = testFolder(prefix);
    folders.push(path);
    return path;
  };
}

const templateRoot = join(import.meta.dir, "../..");

export function testRunFiles(): Record<string, string> {
  return Object.fromEntries(
    [
      "bunfig.toml",
      "scripts/test-run.ts",
      "tests/support/test-run-folder.ts",
    ].map((path) => [path, readFileSync(join(templateRoot, path), "utf8")]),
  );
}
