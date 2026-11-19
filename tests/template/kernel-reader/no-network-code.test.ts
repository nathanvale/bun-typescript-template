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

  test("the stamp check imports only Node's hashing, file and path modules, and uses no Bun interface, so it runs wherever a generated repository does", () => {
    const source = sourceOf("src/stamp-check.ts");
    expect(importsOf(source).sort()).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
    ]);
    expect(source).not.toMatch(/\bBun\b/);
    expect(source).not.toMatch(networkCode);
  });

  test("the kernel reader imports only Node's file and path modules and the stamp check, and starts git for three commands that read objects", () => {
    const source = sourceOf("src/kernel-reader.ts");
    expect(importsOf(source).sort()).toEqual([
      "./stamp-check.ts",
      "node:fs",
      "node:path",
    ]);
    expect(source).not.toMatch(networkCode);
    expect(source.match(/\bBun\s*\.\s*\w+/g)).toEqual(["Bun.spawnSync"]);
    expect(source).toContain('command: "rev-parse" | "ls-tree" | "cat-file",');
    expect(source).toContain('Bun.spawnSync(["git", command, ...args], {');
  });
});
