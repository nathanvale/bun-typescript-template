import { expect, test } from "bun:test";
import { stationsFor } from "../../src/branch-station-catalog.ts";

test("the catalogue declares the exact routed tuple vocabulary", () => {
  const allStations = [
    ...stationsFor("example.status"),
    ...stationsFor("example.set"),
    ...stationsFor("example.recover"),
  ];
  const identities = allStations.map((station) =>
    [station.commandIdentity, station.outcome, station.causeCode].join("|"),
  );
  const expectedIdentities = [
    "example.recover|failed|INTERNAL_RESULT_UNKNOWN",
    "example.recover|success|SUCCESS_COMPLETED",
    "example.recover|success|SUCCESS_UNCHANGED",
    "example.set|failed|DOMAIN_PRIOR_RUN_PENDING",
    "example.set|refused|SCHEMA_INVALID_INPUT",
    "example.set|success|SUCCESS_COMPLETED",
    "example.set|success|SUCCESS_UNCHANGED",
    "example.status|failed|INTERNAL_RESULT_UNCHANGED",
    "example.status|success|SUCCESS_UNCHANGED",
  ]; // Independent literal oracle for the sealed routed tuple vocabulary.

  expect(identities.sort()).toEqual(expectedIdentities);
  expect(new Set(identities).size).toBe(allStations.length);
  expect(stationsFor("example.status")).toHaveLength(2);
  expect(stationsFor("example.set")).toHaveLength(4);
  expect(stationsFor("example.recover")).toHaveLength(3);
});

test("status declares its successful unchanged inspection station", () => {
  expect(
    stationsFor("example.status").find(
      (station) => station.outcome === "success",
    ),
  ).toEqual({
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.status",
    effectClass: "inspect",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction: "No follow-up is required." },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "The current state is inspected.",
    unreachableRationale: null,
  }); // Independent literal oracle for the status station contract.
});

test("status declares invalid persisted state as failed and unchanged", () => {
  expect(
    stationsFor("example.status").find(
      (station) => station.causeCode === "INTERNAL_RESULT_UNCHANGED",
    ),
  ).toEqual({
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    commandIdentity: "example.status",
    effectClass: "inspect",
    exitCode: 1,
    failureClass: "internal",
    guidance: {
      handoff: {
        owner: "operator",
        summary:
          "Inspect or repair the persisted state before another status run.",
      },
    },
    outcome: "failed",
    reachability: "required",
    repairAction: "Inspect or repair the persisted state schema.",
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "The persisted state does not match its schema.",
    unreachableRationale: null,
  }); // Independent literal oracle for the invalid-state station contract.
});

test("set declares completed, unchanged, schema, and unknown states", () => {
  const stations = stationsFor("example.set");
  expect(stations.map((station) => station.transactionState).sort()).toEqual([
    "completed",
    "unchanged",
    "unchanged",
    "unknown",
  ]);
});

test("recovery declares no-pending, confirmed-completed, and unknown outcomes", () => {
  const stations = stationsFor("example.recover");
  expect(stations).toHaveLength(3);
  expect(stations.map((station) => station.transactionState).sort()).toEqual([
    "completed",
    "unchanged",
    "unknown",
  ]);
  expect(
    stations.find((station) => station.transactionState === "unknown"),
  ).toMatchObject({ exitCode: 1, retryable: false });
});
