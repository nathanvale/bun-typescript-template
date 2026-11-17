import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repository = new URL("../../", import.meta.url).pathname;

export async function writeToolchain(
  root: string,
  include: readonly string[],
): Promise<void> {
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      include,
    }),
  );
  await writeFile(
    join(root, "eslint.config.mjs"),
    [
      `import contract3 from ${JSON.stringify(join(repository, "config/contract3-eslint.mjs"))};`,
      "export default [",
      "  ...contract3,",
      `  { ignores: ["tests/support/**"] },`,
      `  { files: ["**/*.ts"], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: ${JSON.stringify(root)} } } },`,
      "];",
      "",
    ].join("\n"),
  );
}
