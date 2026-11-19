import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";

export const root = resolve(import.meta.dir, "../..");
export const templateSourceFile = "src/toolchain-resolution.ts";
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: resolve(root, "eslint.config.mjs"),
});

export async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map(({ ruleId, line, message }) => ({
    ruleId,
    line,
    message,
  }));
}

export const kernelPath = /^(kernel|tests\/kernel)\//;

export async function ruleOn(rule: string, filePath: string): Promise<boolean> {
  const config = (await eslint.calculateConfigForFile(filePath)) as
    | { rules?: Record<string, unknown> }
    | undefined;
  const setting = config?.rules?.[rule];
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return severity !== undefined && severity !== 0 && severity !== "off";
}

export async function ruleHits(ruleId: string, filePath: string, code: string) {
  if (!existsSync(resolve(root, filePath)))
    throw new Error(`${filePath} is not a tracked file.`);
  if (!(await ruleOn(ruleId, filePath)))
    throw new Error(`${ruleId} is off for ${filePath}.`);
  return (await messages(filePath, code))
    .filter((message) => message.ruleId === ruleId)
    .map(({ line, message }) => ({ line, message }));
}

export async function hits(rule: string, filePath: string, code: string) {
  if (kernelPath.test(filePath) || !existsSync(resolve(root, filePath)))
    throw new Error(`${filePath} is not a template file.`);
  return ruleHits(`repository/${rule}`, filePath, code);
}
