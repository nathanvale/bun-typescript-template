import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";

export type PlainFileEntry = Stats | "absent" | { readonly refused: string };

function lstatIfPresent(fullPath: string): Stats | undefined {
  try {
    return lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

// Platform: a write follows a symbolic link at the path or at a folder above it, and a hard link shares its bytes with another path.
export function plainFileEntry(root: string, path: string): PlainFileEntry {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (lstatIfPresent(join(root, ancestor))?.isSymbolicLink()) {
      return { refused: `${path} is below symbolic link ${ancestor}` };
    }
  }
  const stats = lstatIfPresent(join(root, path));
  if (stats === undefined) return "absent";
  if (stats.isSymbolicLink()) return { refused: `${path} is a symbolic link` };
  if (!stats.isFile()) return { refused: `${path} is not a regular file` };
  if (stats.nlink !== 1) return { refused: `${path} is a hard link` };
  return stats;
}

export function plainFileIdentityChange(
  root: string,
  written: ReadonlyMap<string, Stats>,
): string | undefined {
  for (const [path, before] of written) {
    const after = lstatIfPresent(join(root, path));
    if (
      after === undefined ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      return path;
    }
  }
  return undefined;
}
