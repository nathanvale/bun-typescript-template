import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateDocument } from "./command-contract.ts";

export async function inspectState(path: string): Promise<string | null> {
  try {
    const parsed = StateDocument.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (!parsed.success) {
      return null;
    }
    return parsed.data.value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function setState(path: string, value: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ value })}\n`, { flag: "wx" });
  await rename(temporary, path);
  return `state-file:${path}`;
}
