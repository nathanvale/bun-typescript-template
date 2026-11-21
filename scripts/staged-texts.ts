export function stagedTexts(
  root: string,
  include: (path: string) => boolean,
): Map<string, string> {
  function git(args: readonly string[], stdin?: Uint8Array): Buffer {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: process.env,
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.exitedDueToTimeout || result.exitCode !== 0)
      throw new Error(
        `names check: git ${args.join(" ")} could not read the staged public surface. Repair: resolve git's failure and run the check again. ${result.stderr.toString().trim()}`,
      );
    return result.stdout;
  }
  const entries = git(["ls-files", "--stage", "-z"])
    .toString()
    .split("\0")
    .filter(
      (entry) => entry !== "" && include(entry.slice(entry.indexOf("\t") + 1)),
    )
    .map((entry) => {
      const match = /^(100644|100755) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(entry);
      if (match === null)
        throw new Error(
          "names check: the staged public surface has a non-file or unresolved index entry. Repair: resolve the index and stage regular source files.",
        );
      return { object: match[2] ?? "", path: match[3] ?? "" };
    });
  const texts = new Map<string, string>();
  if (entries.length === 0) return texts;
  const output = git(
    ["cat-file", "--batch"],
    new TextEncoder().encode(
      `${entries.map(({ object }) => object).join("\n")}\n`,
    ),
  );
  let offset = 0;
  for (const { object, path } of entries) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString();
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    const size = Number(match?.[2]);
    if (
      match?.[1] !== object ||
      !Number.isSafeInteger(size) ||
      end < offset ||
      end + size + 1 >= output.length
    )
      throw new Error(
        "names check: git returned an incomplete staged blob. Repair: restore the git objects and run the check again.",
      );
    offset = end + 1;
    texts.set(path, output.subarray(offset, offset + size).toString());
    offset += size + 1;
  }
  return texts;
}
