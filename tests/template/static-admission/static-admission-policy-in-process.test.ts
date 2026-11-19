import {
  type Profile,
  type Document as Fields,
  checkLock,
  checkPolicy,
} from "../../../src/static-admission.ts";
import { copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "bun:test";
import {
  createAdmissionFolder,
  policyFiles,
  copyRuleFiles,
  packet,
  causeOf,
  optionsFor,
  fields,
  editJson,
} from "../../support/static-admission-in-process-fixture.ts";
import { EXPECTED_RULE_FILES } from "../../support/lint-rule-files.ts";

const folder = createAdmissionFolder();

function policyProject(profile: Profile = "simple"): string {
  const root = folder();
  for (const file of policyFiles)
    copyFileSync(join(packet, profile, file), join(root, file));
  copyRuleFiles(root);
  return root;
}

function goodLock(): Fields {
  return {
    lockfileVersion: 3,
    workspaces: {
      "": { devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" } },
    },
    overrides: { "@scope/old@npm:ts@^6": { ".": "npm:ts@6.0.2" } },
    packages: {
      eslint: ["eslint@10.15.0"],
      native: ["ts@7.0.2"],
      "@scope/old": ["ts@6.0.2"],
    },
  };
}

function goodExpected(): Fields {
  return {
    devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
    overrides: { "@scope/old@npm:ts@^6": "npm:ts@6.0.2" },
  };
}

async function lockCause(
  lock: unknown,
  expected: Fields = goodExpected(),
): Promise<unknown> {
  const root = folder();
  writeFileSync(join(root, "bun.lock"), JSON.stringify(lock));
  return await causeOf(() => checkLock(root, expected));
}

function lockWith(change: (lock: Fields) => void): Fields {
  const lock = goodLock();
  change(lock);
  return lock;
}

test("checkPolicy accepts a project that carries each profile's policy files exactly", async () => {
  for (const profile of ["simple", "complex"] as const) {
    const root = policyProject(profile);
    const actual = await checkPolicy(optionsFor(root, profile));
    expect(actual).toEqual(
      fields(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))),
    );
  }
});

test("checkPolicy refuses a profile whose policy differs from the project's", async () => {
  const root = policyProject("simple");
  expect(
    await causeOf(() => checkPolicy(optionsFor(root, "complex"))),
  ).toStartWith("policy:");
});

test("checkPolicy refuses a changed package.json field by its name", async () => {
  const changes: [string, unknown][] = [
    ["packageManager", "bun@0.0.1"],
    ["private", false],
    ["type", "commonjs"],
    ["scripts", {}],
    ["dependencies", { extra: "1.0.0" }],
    ["devDependencies", {}],
    ["overrides", {}],
  ];
  for (const [key, value] of changes) {
    const root = policyProject("simple");
    editJson(root, "package.json", (doc) => {
      doc[key] = value;
    });
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toStartWith(
      `policy:package.json.${key}`,
    );
  }
});

test("checkPolicy ignores a package.json field outside the policy", async () => {
  const root = policyProject("simple");
  editJson(root, "package.json", (doc) => {
    doc.name = "another-name";
    doc.description = "another";
    doc.version = "9.9.9";
  });
  await checkPolicy(optionsFor(root));
});

test("checkPolicy names the path of an extra key in each JSON policy file", async () => {
  for (const file of [
    "tsconfig.base.json",
    "tsconfig.json",
    "biome.json",
    ".fallowrc.json",
  ]) {
    const root = policyProject("simple");
    editJson(root, file, (doc) => {
      doc.extra = 1;
    });
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `policy:${file}.extra`,
    );
  }
});

test("checkPolicy names each text policy file that changed", async () => {
  for (const file of [
    ".gitignore",
    "bunfig.toml",
    "eslint.config.mjs",
    "eslint-rules.mjs",
  ]) {
    const root = policyProject("simple");
    writeFileSync(
      join(root, file),
      `${readFileSync(join(root, file), "utf8")}\nextra\n`,
    );
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `policy:${file}`,
    );
  }
});

test("checkPolicy names each lint rule file that differs from the template's", async () => {
  const causes: unknown[] = [];
  for (const file of EXPECTED_RULE_FILES) {
    const root = policyProject("simple");
    writeFileSync(
      join(root, file),
      `${readFileSync(join(root, file), "utf8")}\nextra\n`,
    );
    causes.push(await causeOf(() => checkPolicy(optionsFor(root))));
  }
  expect(causes).toEqual(EXPECTED_RULE_FILES.map((file) => `policy:${file}`));
});

test("checkPolicy passes on the read error of a missing lint rule file", async () => {
  for (const file of EXPECTED_RULE_FILES) {
    const root = policyProject("simple");
    rmSync(join(root, file));
    const cause = await causeOf(() => checkPolicy(optionsFor(root)));
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toHaveProperty("code", "ENOENT");
  }
});

test("checkPolicy names a missing JSON policy file", async () => {
  for (const file of [
    "package.json",
    "tsconfig.base.json",
    "tsconfig.json",
    "biome.json",
    ".fallowrc.json",
    "bun.lock",
  ]) {
    const root = policyProject("simple");
    rmSync(join(root, file));
    expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
      `file:missing:${file}`,
    );
  }
});

test("checkPolicy passes on the read error of a missing text policy file", async () => {
  for (const file of [
    ".gitignore",
    "bunfig.toml",
    "eslint.config.mjs",
    "eslint-rules.mjs",
  ]) {
    const root = policyProject("simple");
    rmSync(join(root, file));
    const cause = await causeOf(() => checkPolicy(optionsFor(root)));
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toHaveProperty("code", "ENOENT");
  }
});

test("checkPolicy refuses a lock file of another version", async () => {
  const root = policyProject("simple");
  editJson(root, "bun.lock", (doc) => {
    doc.lockfileVersion = 2;
  });
  expect(await causeOf(() => checkPolicy(optionsFor(root)))).toBe(
    "policy:bun.lock.lockfileVersion",
  );
});

test("checkLock accepts a lock that pins each dependency and override the policy names", async () => {
  expect(await lockCause(goodLock())).toBe("accepted");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), extra: ["extra@1.0.0"] };
      }),
    ),
  ).toBe("accepted");
});

test("checkLock refuses a lock of another version", async () => {
  for (const version of [2, 4, "3", undefined])
    expect(
      await lockCause(
        lockWith((lock) => {
          lock.lockfileVersion = version;
        }),
      ),
    ).toBe("policy:bun.lock.lockfileVersion");
});

test("checkLock refuses a lock without workspaces, a root workspace or packages", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.workspaces;
      }),
    ),
  ).toBe("policy:bun.lock.workspaces");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = { other: {} };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root");
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.packages;
      }),
    ),
  ).toBe("policy:bun.lock.packages");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = [];
      }),
    ),
  ).toBe("policy:bun.lock.packages");
});

test("checkLock refuses an override the policy does not pin or the lock does not record", async () => {
  expect(await lockCause(goodLock(), {})).toBe("policy:package.json.overrides");
  expect(
    await lockCause(goodLock(), { ...goodExpected(), overrides: [] }),
  ).toBe("policy:package.json.overrides");
  expect(
    await lockCause(goodLock(), {
      ...goodExpected(),
      overrides: { "@scope/old@npm:ts@^6": 6 },
    }),
  ).toBe("policy:package.json.overrides");
  expect(
    await lockCause(
      lockWith((lock) => {
        delete lock.overrides;
      }),
    ),
  ).toBe("policy:bun.lock.overrides");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.overrides = { "@scope/old@npm:ts@^6": { ".": "npm:ts@6.0.3" } };
      }),
    ),
  ).toBe("policy:bun.lock.overrides.@scope/old@npm:ts@^6..");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.overrides = {
          ...fields(lock.overrides),
          "extra@npm:ts@^1": { ".": "npm:ts@1.0.0" },
        };
      }),
    ),
  ).toBe("policy:bun.lock.overrides.extra@npm:ts@^1");
});

test("checkLock resolves an override selector without a registry alias to its own name", async () => {
  const expected = { overrides: { "left-pad": "1.0.0" } };
  const lock = {
    lockfileVersion: 3,
    workspaces: { "": {} },
    overrides: { "left-pad": { ".": "1.0.0" } },
    packages: { "left-pad": ["left-pad@1.0.0"] },
  };
  expect(await lockCause(lock, expected)).toBe("accepted");
  expect(
    await lockCause(
      { ...lock, packages: { "left-pad": ["left-pad@1.0.1"] } },
      expected,
    ),
  ).toBe("policy:bun.lock.packages.left-pad");
});

test("checkLock refuses a root workspace whose dependency groups differ from the policy", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = { "": { devDependencies: { eslint: "10.15.0" } } };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.devDependencies.native");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = {
          "": {
            devDependencies: {
              eslint: "10.15.1",
              native: "npm:ts@7.0.2",
            },
          },
        };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.devDependencies.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.workspaces = {
          "": {
            devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
            dependencies: { extra: "1.0.0" },
          },
        };
      }),
    ),
  ).toBe("policy:bun.lock.workspaces.root.dependencies.extra");
});

test("checkLock checks the runtime dependency group as well as the dev group", async () => {
  const expected = {
    ...goodExpected(),
    dependencies: { runtime: "2.0.0" },
  };
  const lock = lockWith((value) => {
    value.workspaces = {
      "": {
        devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
        dependencies: { runtime: "2.0.0" },
      },
    };
    value.packages = {
      ...fields(value.packages),
      runtime: ["runtime@2.0.0"],
    };
  });
  expect(await lockCause(lock, expected)).toBe("accepted");
  expect(
    await lockCause(
      lockWith((value) => {
        value.workspaces = {
          "": {
            devDependencies: fields(fields(goodLock().workspaces)[""])
              .devDependencies,
          },
        };
      }),
      expected,
    ),
  ).toBe("policy:bun.lock.workspaces.root.dependencies.runtime");
  expect(
    await lockCause(
      lockWith((value) => {
        value.workspaces = {
          "": {
            devDependencies: { eslint: "10.15.0", native: "npm:ts@7.0.2" },
            dependencies: { runtime: "2.0.0" },
          },
        };
      }),
      expected,
    ),
  ).toBe("policy:bun.lock.packages.runtime");
});

test("checkLock refuses a dependency group the policy does not write as a document", async () => {
  const lock = lockWith((value) => {
    value.overrides = {};
  });
  for (const group of ["dependencies", "devDependencies"])
    expect(await lockCause(lock, { overrides: {}, [group]: "pinned" })).toBe(
      `policy:package.json.${group}`,
    );
});

test("checkLock refuses a package that resolved to another version or is not recorded", async () => {
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = {
          ...fields(lock.packages),
          eslint: ["eslint@10.15.1"],
        };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), native: ["ts@7.0.3"] };
      }),
    ),
  ).toBe("policy:bun.lock.packages.native");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { ...fields(lock.packages), eslint: "eslint@10.15.0" };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
  expect(
    await lockCause(
      lockWith((lock) => {
        lock.packages = { native: ["ts@7.0.2"], "@scope/old": ["ts@6.0.2"] };
      }),
    ),
  ).toBe("policy:bun.lock.packages.eslint");
});

test("checkLock treats absent dependency groups as empty", async () => {
  const lock = {
    lockfileVersion: 3,
    workspaces: { "": {} },
    overrides: {},
    packages: {},
  };
  expect(await lockCause(lock, { overrides: {} })).toBe("accepted");
});
