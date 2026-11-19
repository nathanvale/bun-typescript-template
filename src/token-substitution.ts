import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CliError } from "./cli-error.ts";

const NAME_TOKEN = "__REPOSITORY_NAME__";
const PACKET_TOKEN = "__SOURCE_PACKET__";
const rendered: unique symbol = Symbol("rendered staging");

export type Tokens = {
  readonly name: string;
  readonly sourcePacket: string;
};

// Interface: a staging folder whose every file has been through token
// substitution. Only `substituteTokens` makes one, because the key that
// marks it is not exported. A step that takes one therefore runs after
// token substitution, and token substitution never reads what that step
// writes.
export type RenderedStaging = {
  readonly path: string;
  readonly [rendered]: true;
};

async function substituteIn(root: string, tokens: Tokens): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await substituteIn(path, tokens);
      continue;
    }
    if (!entry.isFile()) {
      throw new CliError(
        "unsupported_template_entry",
        `template entry is not a regular file: ${relative(root, path)}`,
        "replace the entry with a regular file",
        1,
        false,
      );
    }
    const current = await readFile(path, "utf8");
    const substituted = current
      .replaceAll(NAME_TOKEN, tokens.name)
      .replaceAll(PACKET_TOKEN, tokens.sourcePacket);
    await writeFile(path, substituted, "utf8");
    count += 1;
  }
  return count;
}

// Interface: replaces the two tokens in every file under `root`, reading and
// rewriting each as UTF-8 text. It rewrites a file that holds a token and
// damages a file that is not UTF-8 text, so nothing that must keep its bytes
// may be in `root` when it runs.
export async function substituteTokens(
  root: string,
  tokens: Tokens,
): Promise<{ readonly staging: RenderedStaging; readonly fileCount: number }> {
  const fileCount = await substituteIn(root, tokens);
  return { staging: { path: root, [rendered]: true }, fileCount };
}
