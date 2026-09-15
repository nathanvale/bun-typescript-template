import { expect, test } from "bun:test";
import { STATIONS, stationsFor } from "../../src/branch-station-catalog.ts";

test("every example.set station has a distinct routed tuple", () => {
  const stations = stationsFor("example.set");
  expect(stations).toHaveLength(3);
  const identities = stations.map((station) =>
    [station.commandIdentity, station.outcome, station.causeCode].join("|"),
  );
  expect(new Set(identities).size).toBe(STATIONS.length);
  expect(stations.map((station) => station.transactionState).sort()).toEqual([
    "completed",
    "unchanged",
    "unchanged",
  ]);
});
