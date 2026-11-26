import { commonCauses } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

const doctorCauses = {
  DOMAIN_DOCTOR_CHECK_FAILED: {
    outcome: "refused",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "next",
    carriesData: true,
  },
} as const satisfies CauseTable;

export const cliCauses = {
  ...commonCauses,
  ...doctorCauses,
} as const satisfies CauseTable;
