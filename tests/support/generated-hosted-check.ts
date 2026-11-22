import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_CHECK_FOLDER, KERNEL_RECIPE } from "../../src/recipe.ts";

const WORKFLOW_FILE = `${HOSTED_CHECK_FOLDER}/ci.yml`;
const WORKFLOW_PATTERN = `${HOSTED_CHECK_FOLDER}/*.{yml,yaml}`;
const CHECKOUT_ACTION = "actions/checkout";
const SETUP_BUN_ACTION = "oven-sh/setup-bun";
const REQUIRED_ACTIONS = [CHECKOUT_ACTION, SETUP_BUN_ACTION] as const;

type PlainObject = Record<string, unknown>;

type TemplatePins = {
  readonly bunVersion: string | undefined;
  readonly actions: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
};

function asRecord(value: unknown): PlainObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function own(record: PlainObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

function parseActionPin(
  uses: string,
): [action: string, ref: string] | undefined {
  const match = /^([^@/\s]+\/[^@\s]+)@([^\s]+)$/.exec(uses);
  const action = match?.[1];
  const ref = match?.[2];
  return action !== undefined && ref !== undefined ? [action, ref] : undefined;
}

function parseYamlFile(
  path: string,
  label: string,
): {
  readonly document?: PlainObject;
  readonly raw?: string;
  readonly error?: string;
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      error: `${label} cannot be read: ${error instanceof Error ? error.message : String(error)}. Repair: restore ${label} as a readable UTF-8 YAML file.`,
    };
  }
  try {
    const parsed = asRecord(Bun.YAML.parse(raw));
    if (parsed === undefined)
      return {
        error: `${label} is not a YAML mapping. Repair: write a valid GitHub Actions workflow mapping in ${label}.`,
      };
    return { document: parsed, raw };
  } catch (error) {
    return {
      error: `${label} is not valid YAML: ${error instanceof Error ? error.message : String(error)}. Repair: fix the YAML syntax in ${label}.`,
    };
  }
}

function workflowSteps(document: PlainObject): PlainObject[] {
  const jobs = asRecord(own(document, "jobs"));
  if (jobs === undefined) return [];
  const steps: PlainObject[] = [];
  for (const job of Object.values(jobs)) {
    const body = asRecord(job);
    const list = body === undefined ? undefined : own(body, "steps");
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = asRecord(item);
      if (record !== undefined) steps.push(record);
    }
  }
  return steps;
}

function readPackageManagerBunPin(root: string): string | undefined {
  const path = join(root, "package.json");
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
  const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
  const manager =
    parsed === undefined ? undefined : scalar(own(parsed, "packageManager"));
  return manager === undefined ? undefined : /^bun@([^+]+)/.exec(manager)?.[1];
}

async function readTemplatePins(template: string): Promise<TemplatePins> {
  const problems: string[] = [];
  const bunVersion = readPackageManagerBunPin(template);
  if (bunVersion === undefined)
    problems.push(
      'template package.json has no toolchain pin. Repair: add "packageManager": "bun@<version>" to package.json.',
    );
  const files = (
    await Array.fromAsync(
      new Bun.Glob(WORKFLOW_PATTERN).scan({ cwd: template, dot: true }),
    )
  ).toSorted();
  if (files.length === 0)
    return {
      bunVersion,
      actions: new Map(),
      problems: [
        ...problems,
        `template has no workflow under ${HOSTED_CHECK_FOLDER}/. Repair: add the template's hosted check workflow before comparing generated pins.`,
      ],
    };
  const refsByAction = new Map<string, Set<string>>();
  const bunVersions = new Set<string>();
  for (const file of files) {
    const loaded = parseYamlFile(join(template, file), `template ${file}`);
    if (loaded.error !== undefined || loaded.document === undefined) {
      problems.push(loaded.error ?? `template ${file} could not be parsed.`);
      continue;
    }
    for (const step of workflowSteps(loaded.document)) {
      const uses = scalar(own(step, "uses"));
      if (uses === undefined || uses.startsWith("./")) continue;
      const parsed = parseActionPin(uses);
      if (parsed === undefined) {
        problems.push(
          `template ${file} uses ${uses} without an action pin. Repair: pin it as owner/repo@ref.`,
        );
        continue;
      }
      const [action, ref] = parsed;
      const seen = refsByAction.get(action) ?? new Set<string>();
      seen.add(ref);
      refsByAction.set(action, seen);
      if (action === SETUP_BUN_ACTION) {
        const inputs = asRecord(own(step, "with"));
        const version =
          inputs === undefined ? undefined : scalar(own(inputs, "bun-version"));
        if (version !== undefined) bunVersions.add(version);
      }
    }
  }
  const actions = new Map<string, string>();
  for (const [action, refs] of refsByAction) {
    const sorted = [...refs].toSorted();
    if (sorted.length === 1 && sorted[0] !== undefined)
      actions.set(action, `${action}@${sorted[0]}`);
    else
      problems.push(
        `template workflows pin ${action} to multiple refs (${sorted.join(", ")}). Repair: use one pin for ${action} across ${HOSTED_CHECK_FOLDER}/.`,
      );
  }
  for (const required of REQUIRED_ACTIONS)
    if (!actions.has(required) && !refsByAction.has(required))
      problems.push(
        `template workflows do not pin ${required}. Repair: pin ${required} in ${HOSTED_CHECK_FOLDER}/.`,
      );
  if (
    bunVersion !== undefined &&
    bunVersions.size > 0 &&
    ![...bunVersions].every((version) => version === bunVersion)
  )
    problems.push(
      `template workflows pin bun-version ${[...bunVersions].toSorted().join(", ")}, and template package.json pins ${bunVersion}. Repair: align bun-version across ${HOSTED_CHECK_FOLDER}/.`,
    );
  return { bunVersion, actions, problems };
}

function triggerProblems(document: PlainObject, where: string): string[] {
  const problems: string[] = [];
  const on = asRecord(own(document, "on"));
  if (on === undefined)
    return [
      `${where} has no on trigger mapping. Repair: trigger on pull_request and push to main.`,
    ];
  const events = Object.keys(on).toSorted();
  if (!Bun.deepEquals(events, ["pull_request", "push"]))
    problems.push(
      `${where} triggers on ${events.join(", ") || "nothing"}, not pull_request and push. Repair: trigger on pull_request and push to branches: [main].`,
    );
  if (Object.hasOwn(on, "pull_request")) {
    const pr = own(on, "pull_request");
    const prRecord = pr === null ? {} : asRecord(pr);
    if (prRecord === undefined || Object.keys(prRecord).length > 0)
      problems.push(
        `${where} pull_request trigger filters or narrows events. Repair: leave pull_request empty with no path filter.`,
      );
  }
  if (Object.hasOwn(on, "push")) {
    const push = asRecord(own(on, "push"));
    const keys = push === undefined ? [] : Object.keys(push).toSorted();
    const branches = push === undefined ? undefined : own(push, "branches");
    if (
      push === undefined ||
      !Bun.deepEquals(keys, ["branches"]) ||
      !Bun.deepEquals(branches, ["main"])
    )
      problems.push(
        `${where} push trigger must target branches: [main] with no path filter. Repair: set push.branches to [main] with no paths or paths-ignore.`,
      );
  }
  return problems;
}

function permissionProblems(document: PlainObject, where: string): string[] {
  const permissions = asRecord(own(document, "permissions"));
  if (
    permissions === undefined ||
    !Bun.deepEquals(permissions, { contents: "read" })
  )
    return [
      `${where} must set read-only permissions (contents: read). Repair: set top-level permissions to contents: read.`,
    ];
  return [];
}

const GROWTH_CHECK = "the Fallow recorded-hits growth check";
const GROWTH_BASE =
  "${{ github.event.pull_request.base.sha || github.event.before }}";

function field(step: PlainObject, block: string, key: string) {
  const record = asRecord(own(step, block));
  return record === undefined ? undefined : scalar(own(record, key));
}

function stepSummary(step: PlainObject) {
  const run = scalar(own(step, "run"));
  return {
    uses: scalar(own(step, "uses"))?.split("@")[0],
    run: run?.includes('--fail-on-baseline-growth --baseline-base "$BASE"')
      ? GROWTH_CHECK
      : run,
    fetchDepth: field(step, "with", "fetch-depth"),
    base: field(step, "env", "BASE"),
  };
}

function pinStepProblems(
  steps: readonly PlainObject[],
  pins: TemplatePins,
  where: string,
): string[] {
  const problems: string[] = [];
  for (const [index, step] of steps.entries()) {
    const uses = scalar(own(step, "uses"));
    if (uses === undefined) continue;
    const stepLabel = `${where} job check step #${index + 1}`;
    const parsed = parseActionPin(uses);
    if (parsed === undefined) {
      problems.push(
        `${stepLabel} uses ${uses} without an action pin. Repair: pin it exactly as the template pins its own actions.`,
      );
      continue;
    }
    const [action] = parsed;
    const expected = pins.actions.get(action);
    if (expected === undefined)
      problems.push(
        `${stepLabel} uses ${uses}, which the template's workflows do not pin. Repair: use only actions pinned in the template's ${HOSTED_CHECK_FOLDER}/.`,
      );
    else if (uses !== expected)
      problems.push(
        `${stepLabel} uses ${uses}, and the template pins ${expected}. Repair: set uses: ${expected} in generated-repository/hosted-check/ci.yml.`,
      );
    if (action === SETUP_BUN_ACTION && pins.bunVersion !== undefined) {
      const inputs = asRecord(own(step, "with"));
      const version =
        inputs === undefined ? undefined : scalar(own(inputs, "bun-version"));
      if (inputs !== undefined && Object.hasOwn(inputs, "bun-version-file"))
        problems.push(
          `${stepLabel} uses bun-version-file. Repair: set bun-version: ${pins.bunVersion} in generated-repository/hosted-check/ci.yml.`,
        );
      else if (version === undefined)
        problems.push(
          `${stepLabel} has no bun-version. Repair: set bun-version: ${pins.bunVersion} in generated-repository/hosted-check/ci.yml.`,
        );
      else if (version !== pins.bunVersion)
        problems.push(
          `${stepLabel} sets bun-version ${version}, and the template pins ${pins.bunVersion}. Repair: set bun-version: ${pins.bunVersion} in generated-repository/hosted-check/ci.yml.`,
        );
    }
  }
  return problems;
}

function jobProblems(
  document: PlainObject,
  pins: TemplatePins,
  where: string,
): string[] {
  const jobs = asRecord(own(document, "jobs"));
  if (jobs === undefined || !Bun.deepEquals(Object.keys(jobs), ["check"]))
    return [
      `${where} must define only the check job. Repair: define jobs.check in generated-repository/hosted-check/ci.yml.`,
    ];
  const check = asRecord(own(jobs, "check"));
  if (check === undefined)
    return [
      `${where} job check is not a mapping. Repair: define jobs.check with runs-on and steps.`,
    ];
  const problems: string[] = [];
  if (scalar(own(check, "runs-on")) !== "ubuntu-latest")
    problems.push(
      `${where} job check runs on ${String(own(check, "runs-on"))}, not ubuntu-latest. Repair: set runs-on: ubuntu-latest.`,
    );
  if (Object.hasOwn(check, "permissions"))
    problems.push(
      `${where} job check overrides permissions. Repair: keep read-only permissions at top level only.`,
    );
  const rawSteps = own(check, "steps");
  if (!Array.isArray(rawSteps))
    return [
      ...problems,
      `${where} job check has no steps list. Repair: add checkout, setup-bun, bun install --frozen-lockfile and ${KERNEL_RECIPE.checkCommand}.`,
    ];
  const steps = rawSteps.map(asRecord);
  if (steps.some((step) => step === undefined))
    return [
      ...problems,
      `${where} job check has a non-mapping step. Repair: write each step as a mapping.`,
    ];
  const validSteps = steps.filter(
    (step): step is PlainObject => step !== undefined,
  );
  problems.push(...pinStepProblems(validSteps, pins, where));
  const checkoutPin = pins.actions.get(CHECKOUT_ACTION);
  const setupBunPin = pins.actions.get(SETUP_BUN_ACTION);
  const expectedSummary = [
    { uses: CHECKOUT_ACTION, run: undefined, fetchDepth: "0", base: undefined },
    {
      uses: SETUP_BUN_ACTION,
      run: undefined,
      fetchDepth: undefined,
      base: undefined,
    },
    {
      uses: undefined,
      run: "bun install --frozen-lockfile",
      fetchDepth: undefined,
      base: undefined,
    },
    {
      uses: undefined,
      run: KERNEL_RECIPE.checkCommand,
      fetchDepth: undefined,
      base: undefined,
    },
    {
      uses: undefined,
      run: GROWTH_CHECK,
      fetchDepth: undefined,
      base: GROWTH_BASE,
    },
  ];
  if (!Bun.deepEquals(validSteps.map(stepSummary), expectedSummary))
    problems.push(
      `${where} job check must run ${checkoutPin ?? CHECKOUT_ACTION} with fetch-depth: 0, ${setupBunPin ?? SETUP_BUN_ACTION}, bun install --frozen-lockfile, ${KERNEL_RECIPE.checkCommand}, then the Fallow recorded-hits growth check with BASE ${GROWTH_BASE}. Repair: match those five steps in order in generated-repository/hosted-check/ci.yml.`,
    );
  return problems;
}

export async function generatedHostedCheckProblems(
  template: string,
  generated: string,
  name: string,
): Promise<string[]> {
  const pins = await readTemplatePins(template);
  if (pins.problems.length > 0) return [...pins.problems];
  const where = `${name} ${WORKFLOW_FILE}`;
  const path = join(generated, WORKFLOW_FILE);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile())
    return [
      `${name} has no ${WORKFLOW_FILE}. Repair: copy generated-repository/hosted-check into ${HOSTED_CHECK_FOLDER} in KERNEL_RECIPE in src/recipe.ts.`,
    ];
  const loaded = parseYamlFile(path, where);
  if (
    loaded.error !== undefined ||
    loaded.document === undefined ||
    loaded.raw === undefined
  )
    return [loaded.error ?? `${where} could not be parsed.`];
  const problems: string[] = [];
  if (scalar(own(loaded.document, "name")) !== "Hosted check")
    problems.push(
      `${where} is named ${String(own(loaded.document, "name"))}, not Hosted check. Repair: set name: Hosted check in generated-repository/hosted-check/ci.yml.`,
    );
  if (/\bsecrets\./.test(loaded.raw))
    problems.push(
      `${where} references GitHub secrets. Repair: keep secrets out of generated-repository/hosted-check/ci.yml.`,
    );
  problems.push(...triggerProblems(loaded.document, where));
  problems.push(...permissionProblems(loaded.document, where));
  problems.push(...jobProblems(loaded.document, pins, where));
  return problems;
}
