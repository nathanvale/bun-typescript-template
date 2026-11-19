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
