import { expect, test } from "bun:test";
import { antiSlopGate as gate } from "../../support/lint-gate-cases.ts";
import { messages } from "../../support/template-lint.ts";

const filePath = "src/doctor.ts";

const gateRules = new Set<string | null>([
  null,
  ...gate.map(({ ruleId }) => ruleId),
]);

async function gateHits(code: string) {
  return (await messages(filePath, code))
    .filter(({ ruleId }) => gateRules.has(ruleId))
    .map(({ ruleId }) => ruleId);
}

const verdicts = new Map<string, { refused: unknown[]; admitted: unknown[] }>();
for (const { ruleId, refused, admitted } of gate)
  verdicts.set(ruleId, {
    refused: await gateHits(refused),
    admitted: await gateHits(admitted),
  });

for (const { ruleId } of gate) {
  test(`${ruleId} refuses its violation`, () => {
    expect(verdicts.get(ruleId)?.refused).toEqual([ruleId]);
  });

  test(`${ruleId} admits its clean form`, () => {
    expect(verdicts.get(ruleId)?.admitted).toEqual([]);
  });
}
