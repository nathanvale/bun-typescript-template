import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// Interface: runs `run` with `bin` first on PATH, then restores PATH. A tool
// stub the caller wrote into `bin` then stands in for the tool of that name.
export async function withToolsFirst<T>(
  bin: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const chosen = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${chosen ?? ""}`;
  try {
    return await run();
  } finally {
    if (chosen === undefined) delete process.env.PATH;
    else process.env.PATH = chosen;
  }
}

// Interface: runs `run` while the first git on PATH is a stub in `bin` that
// never answers, then restores PATH. `bin` is a folder the caller owns.
export function whileGitHangs<T>(
  bin: string,
  run: () => T | Promise<T>,
): Promise<T> {
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 15\n", {
    mode: 0o755,
  });
  return withToolsFirst(bin, run);
}

export async function timed<T>(
  run: () => T | Promise<T>,
): Promise<{ value: T; milliseconds: number }> {
  const started = performance.now();
  const value = await run();
  return { value, milliseconds: performance.now() - started };
}

// Interface: writes into `bin` a git stub that reads the remote `named` as
// `instead`, then runs the real git, so a test can move a branch the code
// reads from a remote it names without a push.
export function gitReadingRemoteAs(
  bin: string,
  named: string,
  instead: string,
): void {
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nfor argument; do\n  shift\n  if [ "$argument" = ${JSON.stringify(named)} ]; then argument=${JSON.stringify(instead)}; fi\n  set -- "$@" "$argument"\ndone\nexec ${JSON.stringify(Bun.which("git"))} "$@"\n`,
    { mode: 0o755 },
  );
}

// Interface: writes into `bin` a git stub that records, in git's trace2
// event format at `trace`, each git command it runs, children included.
export function gitTracingTo(bin: string, trace: string): void {
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nGIT_TRACE2_EVENT=${JSON.stringify(trace)} exec ${JSON.stringify(Bun.which("git"))} "$@"\n`,
    { mode: 0o755 },
  );
}
