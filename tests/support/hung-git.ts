import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

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

export function whileGitHangs<T>(
  bin: string,
  run: () => T | Promise<T>,
): Promise<T> {
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 15\n", {
    mode: 0o755,
  });
  return withToolsFirst(bin, run);
}

export function whileTemplateGitHangs<T>(
  bin: string,
  run: () => T | Promise<T>,
): Promise<T> {
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = "-C" ]; then exec sleep 15; fi\nexec ${JSON.stringify(Bun.which("git"))} "$@"\n`,
    { mode: 0o755 },
  );
  return withToolsFirst(bin, run);
}

export async function timed<T>(
  run: () => T | Promise<T>,
): Promise<{ value: T; milliseconds: number }> {
  const started = performance.now();
  const value = await run();
  return { value, milliseconds: performance.now() - started };
}

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

export function gitTracingTo(bin: string, trace: string): void {
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nGIT_TRACE2_EVENT=${JSON.stringify(trace)} exec ${JSON.stringify(Bun.which("git"))} "$@"\n`,
    { mode: 0o755 },
  );
}
