import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CliError } from "./cli-error.ts";

const NAME_TOKEN = "__REPOSITORY_NAME__";
const PACKET_TOKEN = "__SOURCE_PACKET__";
const PIN_TOKEN = "__KERNEL_PIN__";
const COMMIT_TOKEN = "__KERNEL_COMMIT__";

// Interface: what replaces each token. `kernelPin` is the Pin a generated
// repository holds, and `kernelCommit` its pinned commit, which each pointer
// skill names; a row whose files hold neither token gives neither.
export type Tokens = {
  readonly name: string;
  readonly sourcePacket: string;
  readonly kernelPin?: string;
  readonly kernelCommit?: string;
};

// Interface: replaces each token in every file under `root`, reading and
// rewriting each as UTF-8 text, and returns how many files it rewrote. It
// damages a file that is not UTF-8 text, so nothing that must keep its bytes
// may be in `root` when it runs.
export async function substituteTokens(
  root: string,
  tokens: Tokens,
): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await substituteTokens(path, tokens);
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
      .replaceAll(PACKET_TOKEN, tokens.sourcePacket)
      .replaceAll(PIN_TOKEN, tokens.kernelPin ?? PIN_TOKEN)
      .replaceAll(COMMIT_TOKEN, tokens.kernelCommit ?? COMMIT_TOKEN);
    await writeFile(path, substituted, "utf8");
    count += 1;
  }
  return count;
}
