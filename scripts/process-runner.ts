import { basename, delimiter, dirname } from "node:path";

export const repositoryLocation: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

export function withoutRepositoryLocation(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !repositoryLocation.includes(name)),
  );
}

// Platform: `bun run` prepends the caller's node_modules/.bin folders to PATH,
// and a git hook exports the caller's repository location. Drop both so a
// child process sees only what its own tree installs, and finds its
// repository from its own folder. It reads the environment when a child
// starts, so a caller that isolates git first passes that on.
function ownTools(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...withoutRepositoryLocation(env),
    PATH: (env.PATH ?? "")
      .split(delimiter)
      .filter(
        (entry) =>
          basename(entry) !== ".bin" ||
          basename(dirname(entry)) !== "node_modules",
      )
      .join(delimiter),
  };
}

const defaultGraceMilliseconds = 2_000;
// Platform: The child's group has no live process to signal. ESRCH: every member is
// reaped. EPERM: macOS answers it when every member left is a zombie.
const groupGone = new Set<unknown>(["ESRCH", "EPERM"]);

export type Finished = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly timedOut: boolean;
};

export type Child = {
  readonly pid: number;
  readonly signal: (signal: "SIGTERM" | "SIGINT" | "SIGHUP") => void;
  readonly stop: () => void;
  readonly finished: Promise<Finished>;
};

// Interface: the template's one process runner, for its scripts and the tests
// that judge them. It imports only Node, so a test can copy it byte for byte
// into a fixture repository. `stop` sends SIGTERM, then SIGKILL once the grace
// runs out; a grace of zero sends SIGKILL at once. With `ownGroup` (the
// default) every signal from `stop` reaches every process the child started;
// `signal` reaches the child alone. After a stop, `finished` waits for the
// child, not its pipes, and holds the output that arrived before it died.
export function startChild(
  argv: readonly string[],
  {
    cwd,
    env = ownTools(process.env),
    ownGroup = true,
    limitMilliseconds,
    graceMilliseconds = defaultGraceMilliseconds,
  }: {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly ownGroup?: boolean;
    readonly limitMilliseconds?: number | undefined;
    readonly graceMilliseconds?: number;
  } = {},
): Child {
  const streams = {
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
    detached: ownGroup,
  } as const;
  const child = Bun.spawn(
    [...argv],
    cwd === undefined ? streams : { ...streams, cwd },
  );
  const send = (signal: "SIGTERM" | "SIGKILL") => {
    if (!ownGroup) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!groupGone.has(Reflect.get(Object(error), "code"))) throw error;
    }
  };
  let stopped = false;
  let markStopped = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    markStopped();
    if (graceMilliseconds <= 0) send("SIGKILL");
    else {
      send("SIGTERM");
      escalation = setTimeout(() => send("SIGKILL"), graceMilliseconds);
    }
  };
  let timedOut = false;
  const limit =
    limitMilliseconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stop();
        }, limitMilliseconds);
  const collect = (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    const closed = (async () => {
      for await (const chunk of stream) chunks.push(chunk);
    })();
    return {
      closed,
      text: () => new TextDecoder().decode(Buffer.concat(chunks)),
    };
  };
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  const finished = (async (): Promise<Finished> => {
    try {
      await Promise.race([
        Promise.all([out.closed, err.closed, child.exited]),
        stopRequested.then(() => child.exited),
      ]);
      if (stopped && ownGroup) send("SIGKILL");
      return {
        stdout: out.text(),
        stderr: err.text(),
        exitCode: await child.exited,
        signalCode: child.signalCode,
        timedOut,
      };
    } finally {
      clearTimeout(limit);
      clearTimeout(escalation);
    }
  })();
  return {
    pid: child.pid,
    signal: (signal) => child.kill(signal),
    stop,
    finished,
  };
}

export async function runWithOwnTools(
  argv: readonly string[],
  cwd: string,
  tracker: { stop?: () => void },
  {
    limitMilliseconds,
  }: { readonly limitMilliseconds?: number | undefined } = {},
) {
  const child = startChild(argv, { cwd, limitMilliseconds });
  tracker.stop = child.stop;
  try {
    const { stdout, stderr, exitCode, signalCode, timedOut } =
      await child.finished;
    return { exitCode, signalCode, timedOut, output: stdout + stderr };
  } finally {
    delete tracker.stop;
  }
}
