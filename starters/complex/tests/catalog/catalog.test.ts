import { expect, test } from "bun:test";
import { stationsFor } from "../../src/branch-station-catalog.ts";

test("every example.set station has a distinct routed tuple", () => {
  const stations = stationsFor("example.set");
  expect(stations).toHaveLength(4);
  const allStations = [
    ...stationsFor("example.set"),
    ...stationsFor("example.recover"),
  ];
  const identities = allStations.map((station) =>
    [station.commandIdentity, station.outcome, station.causeCode].join("|"),
  );
  expect(new Set(identities).size).toBe(allStations.length);
  expect(stations.map((station) => station.transactionState).sort()).toEqual([
    "completed",
    "unchanged",
    "unchanged",
    "unchanged",
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
