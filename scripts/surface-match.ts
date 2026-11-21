export type PublicSurface = {
  readonly exports: readonly string[];
  readonly consumedExports: readonly string[];
  readonly importers: readonly string[];
};

export function matchesSurface(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}
