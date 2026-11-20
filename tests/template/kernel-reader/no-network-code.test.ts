import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dir, "../../..");

const networkCode =
  /\b(?:fetch|sendBeacon)\s*\(|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|\bBun\s*\.\s*(?:serve|connect|listen|udpSocket|dns)\b|\b(?:https?|ftp|ssh|wss?):\/\//;

function sourceOf(path: string): string {
  return readFileSync(join(repository, path), "utf8");
}

function importsOf(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g),
  ].map(([, from, dynamic]) => from ?? dynamic ?? "");
}

describe("the template's kernel modules hold no network code", () => {
  test("the control: the pattern finds a fetch call, a socket and a web address", () => {
    for (const code of [
      'await fetch("x")',
      "new WebSocket(address)",
      "Bun.connect({ hostname })",
      'const web = "https://example.invalid";',
    ])
      expect([code, networkCode.test(code)]).toEqual([code, true]);
  });

  test("the git identities module imports only Node's hashing module, and uses no Bun interface", () => {
    const source = sourceOf("src/git-identities.ts");
    expect(importsOf(source).sort()).toEqual(["node:crypto"]);
    expect(source).not.toMatch(/\bBun\b/);
    expect(source).not.toMatch(networkCode);
  });

  test("the kernel reader imports only Node's file and path modules and the git identities module, and starts git for three commands that read objects", () => {
    const source = sourceOf("src/kernel-reader.ts");
    expect(importsOf(source).sort()).toEqual([
      "./git-identities.ts",
      "node:fs",
      "node:path",
    ]);
    expect(source).not.toMatch(networkCode);
    expect(source.match(/\bBun\s*\.\s*\w+/g)).toEqual(["Bun.spawnSync"]);
    expect(source).toContain('command: "rev-parse" | "ls-tree" | "cat-file",');
    expect(source).toContain('Bun.spawnSync(["git", command, ...args], {');
  });
});
