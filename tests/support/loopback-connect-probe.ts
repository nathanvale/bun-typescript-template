export function shouldSkipLoopback(
  options: {
    readonly probe?: () => Promise<boolean>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly report?: (line: string) => void;
  } = {},
): Promise<boolean> {
  return Promise.resolve(options.probe === null);
}
