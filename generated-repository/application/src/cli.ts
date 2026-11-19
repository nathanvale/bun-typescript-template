import { commands } from "./commands.ts";
import { contractFor, runProcess } from "./kernel/index.ts";

const contract = contractFor({
  cli: "__REPOSITORY_NAME__",
  commands,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
