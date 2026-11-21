import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesSurface, type PublicSurface } from "./surface-match.ts";
import { stagedTexts } from "./staged-texts.ts";
import { stagedText } from "./glossary.ts";
import {
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
} from "./glossary.ts";

export const publicSurfaceFile =
  "tests/template/names-check/public-surface.json";

export function readPublicSurface(text: string): PublicSurface {
  const value: unknown = JSON.parse(text);
  const fields = new Map(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
  function patterns(key: string): string[] {
    const list: unknown = fields.get(key);
    if (
      !Array.isArray(list) ||
      !list.every(
        (item: unknown) => typeof item === "string" && item.trim() !== "",
      )
    )
      throw new Error(
        `${publicSurfaceFile} needs a "${key}" array of non-empty glob patterns. Repair: list the public surface's files.`,
      );
    return list as string[];
  }
  return {
    exports: patterns("exports"),
    consumedExports: patterns("consumedExports"),
    importers: patterns("importers"),
  };
}

export function surfaceTexts(root: string, staged: boolean) {
  const textOf = (path: string) =>
    staged ? stagedText(root, path) : readFileSync(join(root, path), "utf8");
  const surface = readPublicSurface(textOf(publicSurfaceFile));
  const patterns = [
    ...surface.exports,
    ...surface.consumedExports,
    ...surface.importers,
  ];
  const indexed = new Set<string>();
  const texts = staged
    ? stagedTexts(root, (path) => {
        indexed.add(path);
        return matchesSurface(path, patterns);
      })
    : new Map<string, string>();
  if (!staged) {
    for (const pattern of patterns) {
      const paths = [
        ...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }),
      ];
      for (const path of paths) texts.set(path, textOf(path));
    }
  }
  for (const pattern of patterns)
    if (![...texts.keys()].some((path) => matchesSurface(path, [pattern])))
      throw new Error(
        `${publicSurfaceFile}: "${pattern}" matches no file. Repair: restore its source files or update the public surface.`,
      );
  const exists = staged
    ? (path: string) => indexed.has(path)
    : (path: string) =>
        existsSync(join(root, path)) && statSync(join(root, path)).isFile();
  return { surface, texts, exists, textOf };
}

export async function publicNameProblems(
  root: string,
  staged: boolean,
  paths?: readonly string[],
  stale: boolean = false,
): Promise<string[]> {
  if (
    paths !== undefined &&
    !paths.some((path) => /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path))
  )
    return [];
  const {
    surface,
    texts,
    exists,
    textOf: surfaceText,
  } = surfaceTexts(root, staged);
  if (texts.size === 0 && !stale) return [];
  const { publicDeclarations, declarationProblems, followReexports } =
    await import("./public-declarations.ts");
  followReexports(root, texts, surface, exists, surfaceText);
  const declarations = publicDeclarations(root, texts, surface).filter(
    (declaration) => paths === undefined || paths.includes(declaration.path),
  );
  const textOf = (path: string) =>
    staged ? stagedText(root, path) : readFileSync(join(root, path), "utf8");
  return declarationProblems(
    declarations,
    readGlossary(textOf("GLOSSARY.md")),
    readRecordedHits(textOf(recordedHitsFile)),
    stale,
  );
}
