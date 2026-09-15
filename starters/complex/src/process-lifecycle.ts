interface ProcessLifecycleDependencies {
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
  exit(code: number): void;
  finishDiagnostics(): Promise<void>;
  setExitCode(code: number): void;
  setTimer(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  unrefTimer(handle: ReturnType<typeof setTimeout>): void;
  writeStderr(text: string): void;
  writeStdout(text: string, callback: (error?: Error | null) => void): void;
}

export interface ProcessLifecycle {
  complete(code: number): Promise<void>;
  stderr(text: string): void;
  stdout(text: string): void;
  terminate(code: 130 | 143): void;
}

const FLUSH_DEADLINE_MS = 500;
const EXIT_WATCHDOG_MS = 150;

function createProcessLifecycle(
  dependencies: ProcessLifecycleDependencies,
): ProcessLifecycle {
  let stopping = false;
  let terminal = false;
  let outputFailed = false;
  let outputFinished = Promise.resolve();

  function exitOnce(code: number): void {
    if (terminal) return;
    terminal = true;
    dependencies.exit(code);
  }

  return {
    async complete(code) {
      await outputFinished;
      if (stopping) return;
      const finalCode = outputFailed ? 1 : code;
      dependencies.setExitCode(finalCode);
      const watchdog = dependencies.setTimer(
        () => exitOnce(finalCode),
        EXIT_WATCHDOG_MS,
      );
      dependencies.unrefTimer(watchdog);
    },
    stderr(text) {
      if (!stopping && !terminal) dependencies.writeStderr(text);
    },
    stdout(text) {
      if (stopping || terminal) return;
      outputFinished = outputFinished.then(
        () =>
          new Promise<void>((resolve) => {
            try {
              dependencies.writeStdout(text, (error) => {
                if (error != null) outputFailed = true;
                resolve();
              });
            } catch {
              outputFailed = true;
              resolve();
            }
          }),
      );
    },
    terminate(code) {
      if (stopping) {
        exitOnce(code);
        return;
      }
      stopping = true;
      const deadline = dependencies.setTimer(
        () => exitOnce(code),
        FLUSH_DEADLINE_MS,
      );
      void dependencies.finishDiagnostics().finally(() => {
        dependencies.clearTimer(deadline);
        exitOnce(code);
      });
    },
  };
}

export function systemProcessLifecycle(): ProcessLifecycle {
  return createProcessLifecycle({
    clearTimer: clearTimeout,
    exit: (code) => process.exit(code),
    finishDiagnostics: async () => undefined,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    unrefTimer: (handle) => handle.unref(),
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text, callback) => process.stdout.write(text, callback),
  });
}
