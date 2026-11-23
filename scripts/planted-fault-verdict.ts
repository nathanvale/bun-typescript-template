import { existsSync, readFileSync } from "node:fs";

export type Verdict =
  | { kind: "KILLED"; failing: readonly string[] }
  | { kind: "SURVIVED" }
  | { kind: "STALE"; output: string }
  | { kind: "BROKEN"; cause: string; output: string }
  | { kind: "TIMEOUT"; step: string };

export const timeoutErrorName = "TimeoutError";

const assertionErrorName = "AssertionError";

export type TestResult = {
  name: string;
  skipped: boolean;
  failure: string | undefined;
};

export type TestRun = {
  readonly passed: boolean;
  readonly output: string;
  readonly results: readonly TestResult[] | undefined;
};

const entities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decoded(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([\da-fA-F]+)|(\w+));/g,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hex !== undefined)
        return String.fromCodePoint(Number.parseInt(hex, 16));
      return entities.get(name ?? "") ?? whole;
    },
  );
}

function attribute(attributes: string, name: string): string {
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes);
  return decoded(found?.[1] ?? "");
}

function testResults(junit: string): TestResult[] {
  const suites: string[] = [];
  const results: TestResult[] = [];
  const opened = (attributes: string) =>
    results.push({
      name: [...suites.slice(1), attribute(attributes, "name")].join(" > "),
      skipped: false,
      failure: undefined,
    });
  const skipped = () => Object.assign(results.at(-1) ?? {}, { skipped: true });
  const failed = (attributes: string) =>
    Object.assign(results.at(-1) ?? {}, {
      failure: attribute(attributes, "type"),
    });
  const read = new Map<string, (attributes: string) => unknown>([
    ["testsuite", (attributes) => suites.push(attribute(attributes, "name"))],
    ["/testsuite", () => suites.pop()],
    ["testcase", opened],
    ["testcase/", opened],
    ["skipped", skipped],
    ["skipped/", skipped],
    ["failure", failed],
    ["failure/", failed],
  ]);
  const tags = /<(\/?)(testsuite|testcase|skipped|failure)\b([^>]*?)(\/?)>/g;
  for (const [, close, tag, attributes = "", empty] of junit.matchAll(tags))
    read.get(`${close}${tag}${empty}`)?.(attributes);
  return results;
}

export function testRun(
  run: { readonly passed: boolean; readonly output: string },
  report: string,
): TestRun {
  return {
    ...run,
    results: existsSync(report)
      ? testResults(readFileSync(report, "utf8"))
      : undefined,
  };
}

export async function judged(
  clean: TestRun,
  faulted: () => Promise<TestRun>,
  removesBound = false,
): Promise<Verdict> {
  const broken = (cause: string, { output }: TestRun): Verdict => ({
    kind: "BROKEN",
    cause: `${cause}, so the planted fault shows nothing.`,
    output,
  });
  if (!clean.passed) return broken("fails without the patch", clean);
  const selected = new Set(
    (clean.results ?? [])
      .filter(({ skipped, failure }) => !skipped && failure === undefined)
      .map(({ name }) => name),
  );
  if (selected.size === 0)
    return broken("passes without the patch but runs no test", clean);
  const twice = (results: readonly TestResult[]) =>
    [...selected]
      .filter((name) => results.filter((r) => r.name === name).length > 1)
      .join(" | ");
  const cleanTwice = twice(clean.results ?? []);
  if (cleanTwice !== "")
    return broken(
      `passes without the patch but has more than one test named ${cleanTwice}`,
      clean,
    );
  const patched = await faulted();
  if (patched.passed) return { kind: "SURVIVED" };
  const withPatch = (cause: string) =>
    broken(`fails with the patch applied, ${cause}`, patched);
  if (patched.results === undefined)
    return withPatch("but its test file did not load");
  const patchedTwice = twice(patched.results);
  if (patchedTwice !== "")
    return withPatch(`but has more than one test named ${patchedTwice}`);
  const failed = patched.results.filter(
    ({ name, failure }) => failure !== undefined && selected.has(name),
  );
  const kills = (failure: string | undefined) =>
    failure === assertionErrorName ||
    (removesBound && failure === timeoutErrorName);
  const failing = failed
    .filter(({ failure }) => kills(failure))
    .map(({ name }) => name);
  if (failing.length > 0) return { kind: "KILLED", failing };
  if (failed.some(({ failure }) => failure !== timeoutErrorName))
    return withPatch(
      `but by no failed assertion (${failed.map(({ name, failure }) => `${name}: ${failure}`).join(" | ")})`,
    );
  if (failed.length > 0)
    return withPatch(
      `but only by timing out (${failed.map(({ name }) => name).join(" | ")})`,
    );
  return withPatch("but no test that passed without it failed");
}
