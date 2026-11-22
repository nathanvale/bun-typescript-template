import { KernelRefusal } from "./kernel-reader.ts";

const SCHEMA_VERSION = 1;

export const RUNTIME_FAILURE_REPAIR =
  "correct what the message names, then rerun the same command";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repair: string,
    readonly exitCode: number,
    readonly retrySafe: boolean,
  ) {
    super(message);
  }
}

function failureOf(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof KernelRefusal)
    return new CliError(error.code, error.reason, error.repair, 1, false);
  return new CliError(
    "runtime_failure",
    error instanceof Error ? error.message : "unexpected runtime failure",
    RUNTIME_FAILURE_REPAIR,
    1,
    false,
  );
}

export function writeCliError(error: unknown, json: boolean): number {
  const failure = failureOf(error);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    status: "refused",
    error: {
      code: failure.code,
      message: failure.message,
      repair: failure.repair,
      retrySafe: failure.retrySafe,
    },
  };
  process.stderr.write(
    json
      ? `${JSON.stringify(envelope)}\n`
      : `${failure.message}\nRepair: ${failure.repair}\n`,
  );
  return failure.exitCode;
}
