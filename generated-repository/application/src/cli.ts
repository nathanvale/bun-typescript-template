import { commands } from "./commands.ts";
import { contractFor, runProcess } from "agent-cli-kernel";

const contract = contractFor({
  cli: "__REPOSITORY_NAME__",
  commands,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
