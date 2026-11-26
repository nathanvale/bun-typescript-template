import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliCauses } from "../../../src/causes.ts";
import { jsonOutput } from "../../../src/cli.ts";
import {
  doctor,
  fallowCheck,
  fallowReadiness,
  fallowReport,
  formatDoctorReport,
} from "../../../src/doctor.ts";
import { testFolder } from "../../support/test-folder.ts";

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

const install = "bun install --frozen-lockfile";

function stub(body: string, exitCode = 0): string {
  return `#!/bin/sh\ncat <<'REPORT'\n${body}\nREPORT\nexit ${exitCode}\n`;
}

function root(fallow: string | null): string {
  const folder = testFolder("doctor-fallow-");
  folders.push(folder);
  mkdirSync(join(folder, "node_modules/.bin"), { recursive: true });
  if (fallow !== null) {
    const binary = join(folder, "node_modules/.bin/fallow");
    writeFileSync(binary, fallow);
    chmodSync(binary, 0o755);
  }
  return folder;
}

function reported(report: object, exitCode = 0): string {
  return root(stub(JSON.stringify(report), exitCode));
}

describe("fallowCheck", () => {
  const complete = { id: "cache", status: "warn", message: "Cache is cold." };

  test.each([
    ["null", null],
    ["a string", "cache"],
    ["a number", 7],
    ["undefined", undefined],
  ])("%s is not a check", (_kind, value) => {
    expect(fallowCheck(value)).toBeUndefined();
  });

  test.each(["id", "status", "message"])(
    "a check with no %s is refused",
    (field) => {
      expect(fallowCheck({ ...complete, [field]: undefined })).toBeUndefined();
    },
  );

  test.each(["id", "status", "message"])(
    "a check whose %s is not text is refused",
    (field) => {
      expect(fallowCheck({ ...complete, [field]: 3 })).toBeUndefined();
    },
  );

  test("a check with no remediation keeps its three fields and has no repair", () => {
    expect(fallowCheck({ ...complete, ignored: true })).toStrictEqual({
      ...complete,
      repair: undefined,
    });
  });

  test("a remediation command becomes the repair", () => {
    expect(
      fallowCheck({
        ...complete,
        remediation: { command: "fallow dead-code --quiet", cwd: "." },
      }),
    ).toStrictEqual({ ...complete, repair: "fallow dead-code --quiet" });
  });

  test.each([
    ["null", null],
    ["a string", "fallow dead-code"],
    ["an object with no command", { cwd: "." }],
    ["an object whose command is not text", { command: 4 }],
  ])("a remediation that is %s gives no repair", (_kind, remediation) => {
    expect(fallowCheck({ ...complete, remediation })?.repair).toBeUndefined();
  });
});

describe("fallowReport", () => {
  const warned = {
    id: "cache",
    status: "warn",
    message: "Cache is cold.",
    remediation: { command: "fallow dead-code --quiet" },
  };

  test.each([
    ["malformed JSON", "{status:"],
    ["empty output", ""],
    ["a JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"pass"'],
    ["a JSON array", '[{"status":"pass","checks":[]}]'],
    ["no status", '{"checks":[]}'],
    ["a status that is not text", '{"status":1,"checks":[]}'],
    ["no checks", '{"status":"pass"}'],
    ["checks that are not a list", '{"status":"pass","checks":{}}'],
    ["checks that are null", '{"status":"pass","checks":null}'],
  ])("%s is not a readiness report", (_kind, output) => {
    expect(fallowReport(output)).toBeUndefined();
  });

  test("one malformed check makes the whole report unreadable", () => {
    const output = JSON.stringify({
      status: "warn",
      checks: [warned, { id: "config", status: "fail" }],
    });

    expect(fallowReport(output)).toBeUndefined();
  });

  test("a report with no checks is read with an empty list", () => {
    expect(fallowReport('{"status":"pass","checks":[]}')).toStrictEqual({
      status: "pass",
      checks: [],
    });
  });

  test("each check is read in order with its repair, and other fields are dropped", () => {
    const passed = { id: "root", status: "pass", message: "Root is readable." };
    const output = JSON.stringify({
      status: "warn",
      version: "3.43.2",
      checks: [passed, warned],
    });

    expect(fallowReport(output)).toStrictEqual({
      status: "warn",
      checks: [
        { ...passed, repair: undefined },
        {
          id: "cache",
          status: "warn",
          message: "Cache is cold.",
          repair: "fallow dead-code --quiet",
        },
      ],
    });
  });
});

describe("fallowReadiness", () => {
  test("a missing fallow binary fails with the install repair", () => {
    expect(fallowReadiness(root(null))).toStrictEqual({
      status: "FAIL",
      check: "fallow",
      detail: `node_modules/.bin/fallow is missing. Repair: ${install}.`,
    });
  });

  test("a passing report is ok whatever its checks say", () => {
    const folder = reported({
      status: "pass",
      checks: [{ id: "cache", status: "fail", message: "Ignored." }],
    });

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "ok",
      check: "fallow",
      detail: "fallow doctor passes.",
    });
  });

  test("fallow runs doctor in the root with JSON output and no chatter, and stderr is ignored", () => {
    const folder = root(
      '#!/bin/sh\necho "noise" >&2\necho "{\\"status\\":\\"warn\\",\\"checks\\":[{\\"id\\":\\"run\\",\\"status\\":\\"warn\\",\\"message\\":\\"$* in $(pwd)\\"}]}"\n',
    );

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "WARN",
      check: "fallow",
      detail: `run: doctor --format json --quiet in ${folder}. Repair: run node_modules/.bin/fallow doctor for the details.`,
    });
  });

  test("a warning with a remediation is a WARN naming that command", () => {
    const folder = reported({
      status: "warn",
      checks: [
        { id: "root", status: "pass", message: "Root is readable." },
        {
          id: "cache",
          status: "warn",
          message: "Cache is cold",
          remediation: { command: "fallow dead-code --quiet" },
        },
      ],
    });

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "WARN",
      check: "fallow",
      detail:
        "cache: Cache is cold. Repair: run fallow dead-code --quiet from the repository root.",
    });
  });

  test("a message that already ends in a full stop gains no second one", () => {
    const folder = reported({
      status: "warn",
      checks: [{ id: "cache", status: "warn", message: "Cache is cold." }],
    });

    expect(fallowReadiness(folder).detail).toBe(
      "cache: Cache is cold. Repair: run node_modules/.bin/fallow doctor for the details.",
    );
  });

  test("a failing check is a FAIL and wins over an earlier warning", () => {
    const folder = reported(
      {
        status: "fail",
        checks: [
          { id: "cache", status: "warn", message: "Cache is cold." },
          {
            id: "config",
            status: "fail",
            message: "The config could not be parsed",
            remediation: { command: "fallow init" },
          },
        ],
      },
      2,
    );

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "FAIL",
      check: "fallow",
      detail:
        "config: The config could not be parsed. Repair: run fallow init from the repository root.",
    });
  });

  test("a failing check without a remediation points at fallow doctor", () => {
    const folder = reported(
      {
        status: "fail",
        checks: [{ id: "config", status: "fail", message: "Bad config." }],
      },
      2,
    );

    expect(fallowReadiness(folder).detail).toBe(
      "config: Bad config. Repair: run node_modules/.bin/fallow doctor for the details.",
    );
  });

  test("a warn report whose checks hold no failure or warning names the status", () => {
    const folder = reported({
      status: "warn",
      checks: [{ id: "root", status: "pass", message: "Root is readable." }],
    });

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "WARN",
      check: "fallow",
      detail:
        "fallow doctor reported warn. Repair: run node_modules/.bin/fallow doctor for the details.",
    });
  });

  test("a fail report with no checks is a FAIL naming the status", () => {
    const folder = reported({ status: "fail", checks: [] }, 2);

    expect(fallowReadiness(folder)).toStrictEqual({
      status: "FAIL",
      check: "fallow",
      detail:
        "fallow doctor reported fail. Repair: run node_modules/.bin/fallow doctor for the details.",
    });
  });

  test("a status other than pass or fail is only a WARN", () => {
    const folder = reported({ status: "skipped", checks: [] });

    expect(fallowReadiness(folder).status).toBe("WARN");
  });

  test.each([
    ["error text", "error: unknown command", 2],
    ["empty output", "", 1],
    ["a report with a malformed check", '{"status":"pass","checks":[{}]}', 0],
  ])(
    "%s is not a readiness report and names the exit code",
    (_kind, body, exitCode) => {
      expect(fallowReadiness(root(stub(body, exitCode)))).toStrictEqual({
        status: "FAIL",
        check: "fallow",
        detail: `fallow doctor exited ${exitCode} without a readiness report. Repair: ${install}, then run node_modules/.bin/fallow doctor to read its error.`,
      });
    },
  );
});

describe("doctor report and causes", () => {
  test("doctor returns results without writing to stdout and formatDoctorReport renders each line", async () => {
    const folder = testFolder("doctor-missing-modules-");
    folders.push(folder);
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ packageManager: `bun@${Bun.version}` }),
    );
    const report = await doctor(folder);
    expect(report.ready).toBe(false);
    expect(report.results).toContainEqual({
      status: "FAIL",
      check: "toolchain",
      detail: `node_modules is missing. Repair: ${install}.`,
    });
    const text = formatDoctorReport(report);
    expect(text).toContain(
      `FAIL toolchain: node_modules is missing. Repair: ${install}.\n`,
    );
    expect(text).toEndWith("Done when bun run doctor passes.\n");
  });

  test("cliCauses declares DOMAIN_DOCTOR_CHECK_FAILED as a data-carrying domain refusal", () => {
    expect(cliCauses.DOMAIN_DOCTOR_CHECK_FAILED).toEqual({
      outcome: "refused",
      transactionState: "unchanged",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      guidance: "next",
      carriesData: true,
    });
  });

  test("jsonOutput recognises --json before -- only", () => {
    expect(jsonOutput(["doctor"])).toBe(false);
    expect(jsonOutput(["doctor", "--json"])).toBe(true);
    expect(jsonOutput(["doctor", "--", "--json"])).toBe(false);
  });
});
