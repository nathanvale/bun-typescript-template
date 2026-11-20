import type { commonCauses } from "agent-cli-kernel";
import { command } from "agent-cli-kernel";

const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const succeeded = "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;

const status = command({
  identity: "__REPOSITORY_NAME__.status",
  route: ["status"],
  summary: "Report that this command-line tool runs.",
  input: noInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      {
        commandIdentity: "__REPOSITORY_NAME__.status",
        causeCode: succeeded,
      },
      {
        message: "The command-line tool runs.",
        data: { ready: true },
        effects: noEffects,
      },
    ),
});

export const commands = [status] as const;
