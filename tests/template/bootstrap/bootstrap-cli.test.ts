import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedPin, readKernelPin } from "../../../src/kernel-pin.ts";
import {
  ROOT,
  bootstrapCliFixture,
  invoke,
  listFiles,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

const SOURCE_PACKET_DATA_MESSAGE =
  "HTTP(S) source packet URLs must not contain username, password, or query data";
const SOURCE_PACKET_DATA_REPAIR =
  "remove username, password, or query data, or use an absolute local packet path";

async function expectRejectedSourcePacket(
  root: string,
  name: string,
  packet: string,
  redactedParts: readonly string[],
): Promise<void> {
  const destination = join(root, name);
  const result = await invoke(
    "--destination",
    destination,
    "--source-packet",
    packet,
    "--json",
  );

  expect(result.exitCode).toBe(2);
  for (const value of [packet, ...redactedParts]) {
    expect(result.stdout).not.toContain(value);
    expect(result.stderr).not.toContain(value);
  }
  expect(JSON.parse(result.stderr)).toMatchObject({
    error: {
      code: "invalid_source_packet",
      message: SOURCE_PACKET_DATA_MESSAGE,
      repair: SOURCE_PACKET_DATA_REPAIR,
      retrySafe: true,
    },
    status: "refused",
  });
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(join(destination, "README.md"))).toBe(false);
}

describe("public bootstrap CLI", () => {
  test(
    "shows useful help with no arguments, naming one usage and no retired option",
    async () => {
      const result = await invoke();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "bun run bootstrap --destination PATH --source-packet PATH_OR_URL [--name NAME] [--json]",
      );
      for (const retired of [
        "--profile",
        "--starter",
        "--monorepo",
        "--kernel",
      ])
        expect(result.stdout).not.toContain(retired);
    },
    processWatchdog(1),
  );

  test(
    "generates a repository whose package.json names the kernel at the template's Pin, and reports it without a profile, starter or variant",
    async () => {
      const destination = join(temporaryRoot(), "pinned-example");
      const packet = "https://example.test/vault/projects/pinned-example/";
      const result = await invoke(
        "--destination",
        destination,
        "--source-packet",
        packet,
        "--json",
      );

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const reported = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(reported).toSorted()).toEqual([
        "destination",
        "generatedFiles",
        "runId",
        "schemaVersion",
        "sourcePacket",
        "status",
      ]);
      expect(reported).toMatchObject({
        destination,
        sourcePacket: packet,
        status: "created",
      });
      const pin = readKernelPin(ROOT);
      const { dependencies } = JSON.parse(
        await readFile(join(destination, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(dependencies).toEqual({
        "agent-cli-kernel": generatedPin(pin, pin.commit),
      });
    },
    processWatchdog(1),
  );

  test(
    "rejects username-only source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "username",
        "https://demo@example.test/vault/projects/example/",
        ["demo"],
      );
    },
    processWatchdog(1),
  );

  test(
    "rejects password-only source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "password",
        "https://:secret@example.test/",
        ["secret"],
      );
    },
    processWatchdog(1),
  );

  test(
    "rejects query source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "query",
        "https://example.test/vault/projects/example/?access=example-only",
        ["access=example-only"],
      );
    },
    processWatchdog(1),
  );

  test(
    "refuses a non-empty destination without changing its bytes",
    async () => {
      const root = temporaryRoot();
      const destination = join(root, "owned");
      const sentinel = join(destination, "keep.txt");
      await mkdir(destination);
      await writeFile(sentinel, "keep these bytes\n");
      const before = createHash("sha256")
        .update(await readFile(sentinel))
        .digest("hex");
      const result = await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/vault/projects/owned/",
        "--json",
      );
      const after = createHash("sha256")
        .update(await readFile(sentinel))
        .digest("hex");

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "refused",
        error: { code: "destination_not_empty", retrySafe: true },
      });
      expect(after).toBe(before);
      expect(await listFiles(destination)).toEqual(["keep.txt"]);
    },
    processWatchdog(1),
  );
});
