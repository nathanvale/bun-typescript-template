import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  recordedHitsFile,
  stagedNewPaths,
  stagedText,
} from "../../../scripts/glossary.ts";
import { git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { timed, whileGitHangs } from "../../support/hung-git.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  check,
  glossary,
  hostHit,
  hostRefusal,
  namesCheckFixture,
  put,
  thrownBy,
} from "./names-check-fixture.ts";

const { emptyRepository, folder, namesRepository, outsideRepository } =
  namesCheckFixture();

function stage(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    put(root, path, content);
    git(root, "add", "--", path);
  }
}

function commitAll(root: string, files: Record<string, string>): void {
  stage(root, files);
  git(root, "commit", "--quiet", "-m", "base");
}

test("in process: --staged judges an added and a renamed name, and ignores a modified, a deleted and a given one", async () => {
  const root = namesRepository();
  const body = "A file long enough for git to see its move as a rename.\n";
  commitAll(root, {
    "docs/mutation-notes.md": "before\n",
    "docs/planted-fault-notes.md": body,
    "docs/removed-mutation.md": "gone\n",
  });
  stage(root, { "docs/mutation-notes.md": "after\n" });
  git(root, "rm", "--quiet", "--", "docs/removed-mutation.md");
  expect(await check(root, ["--staged"])).toEqual({ stderr: "", code: 0 });
  git(root, "mv", "docs/planted-fault-notes.md", "docs/host.md");
  stage(root, { "src/allowlist.ts": "" });
  expect(await check(root, ["--staged"])).toEqual({
    stderr: [
      hostRefusal,
      'src/allowlist.ts uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: rename it with the glossary word.\n',
    ].join(""),
    code: 1,
  });
});

test("in process: --staged refuses a name whose recorded hit is only an unstaged edit", async () => {
  const root = namesRepository();
  stage(root, { "docs/host.md": "notes\n" });
  put(root, recordedHitsFile, JSON.stringify({ hits: [hostHit] }));
  expect(await check(root, ["--staged"])).toEqual({
    stderr: hostRefusal,
    code: 1,
  });
});

test("in process: --staged passes a name whose recorded hit is staged, though the working tree has lost it", async () => {
  const root = namesRepository();
  stage(root, {
    "docs/host.md": "notes\n",
    [recordedHitsFile]: JSON.stringify({ hits: [hostHit] }),
  });
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  expect(await check(root, ["--staged"])).toEqual({ stderr: "", code: 0 });
});

test("in process: --staged refuses a name that uses an Avoid word only the staged glossary lists", async () => {
  const root = namesRepository();
  stage(root, {
    "GLOSSARY.md": glossary.replace("mutant, mutation", "mutant, canary"),
    "docs/canary-notes.md": "notes\n",
  });
  put(root, "GLOSSARY.md", glossary);
  expect(await check(root, ["--staged"])).toEqual({
    stderr:
      'docs/canary-notes.md uses "canary", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.\n',
    code: 1,
  });
});

test.each([["GLOSSARY.md"], [recordedHitsFile]])(
  "in process: --staged with no staged %s cannot run, and names the file and the repair",
  async (path) => {
    const root = namesRepository();
    git(root, "rm", "--cached", "--quiet", "--", path);
    expect(await check(root, ["--staged"])).toEqual({
      stderr: `git has no staged ${path}, so the names check cannot judge a commit by the ${path} it will contain. Repair: stage it with git add ${path}, then run the names check again.\n`,
      code: 2,
    });
  },
);

test("in process: a folder meant to sit outside any repository is refused when STATE_TEST_DIR puts a repository above it", () => {
  const above = namesRepository();
  const chosen = process.env.STATE_TEST_DIR;
  process.env.STATE_TEST_DIR = above;
  try {
    expect(thrownBy(outsideRepository)).toContain(
      `sits inside the repository at ${above}, so a case that needs no repository would find it.`,
    );
  } finally {
    if (chosen === undefined) delete process.env.STATE_TEST_DIR;
    else process.env.STATE_TEST_DIR = chosen;
  }
});

test("in process: --staged outside a git repository exits 2 with git's reason", async () => {
  const outcome = await check(outsideRepository(), ["--staged"]);
  expect(outcome.code).toBe(2);
  expect(outcome.stderr).toStartWith(
    "git diff --cached --name-only --diff-filter=ACR failed: ",
  );
  expect(outcome.stderr).toEndWith("\n");
});

test(
  "in process: --staged with a git that never answers exits 2 at its bound, naming the command and the repair",
  async () => {
    const root = namesRepository();
    const command = "git diff --cached --name-only --diff-filter=ACR -z";
    const { value, milliseconds } = await whileGitHangs(folder(), () =>
      timed(() => check(root, ["--staged"])),
    );
    expect(milliseconds).toBeGreaterThanOrEqual(10_000 - 100);
    expect(milliseconds).toBeLessThan(10_000 + 1_500);
    expect(value).toEqual({
      stderr: `names check: ${command} did not exit within 10000 ms. Repair: find what holds git in ${root} (a stale index.lock, a hung hook or a stalled disk), then run the check again. Done when ${command} exits 0 there.\n`,
      code: 2,
    });
  },
  processWatchdog(1),
);

test(
  "in process: the fixture's git stops a call that never answers at its bound",
  async () => {
    const root = namesRepository();
    const { value, milliseconds } = await whileGitHangs(folder(), () =>
      timed(() => thrownBy(() => git(root, "status"))),
    );
    expect(milliseconds).toBeGreaterThanOrEqual(4_000 - 100);
    expect(milliseconds).toBeLessThan(4_000 + 1_500);
    expect(value).toBe("git status did not exit within 4000 ms.");
  },
  processWatchdog(1),
);

test("in process: stagedNewPaths lists staged additions and renames, and no modification or deletion", () => {
  const root = emptyRepository();
  const body = "A file long enough for git to see its move as a rename.\n";
  commitAll(root, {
    "docs/edited.md": "before\n",
    "docs/moved.md": body,
    "docs/removed.md": "gone\n",
  });
  expect(stagedNewPaths(root)).toEqual([]);
  stage(root, {
    "docs/edited.md": "after\n",
    "docs/added.md": "new\n",
    "docs/with space.md": "new\n",
    "docs/café.md": "new\n",
  });
  git(root, "mv", "docs/moved.md", "docs/renamed.md");
  git(root, "rm", "--quiet", "--", "docs/removed.md");
  put(root, "docs/unstaged.md", "untracked\n");
  expect(stagedNewPaths(root).sort()).toEqual([
    "docs/added.md",
    "docs/café.md",
    "docs/renamed.md",
    "docs/with space.md",
  ]);
});

function reversedOrderConfig(): { home: string; order: string } {
  const home = folder();
  const order = join(home, "order");
  put(home, "order", "docs/z.md\n");
  put(home, ".gitconfig", `[diff]\n\torderFile = ${order}\n`);
  return { home, order };
}

function stagedOrderUnder(root: string, env: Record<string, string>): string[] {
  const result = Bun.spawnSync(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACR"],
    {
      cwd: root,
      env: { ...inherited(), ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim().split("\n");
}

function withProcessEnv(changes: Record<string, string>, run: () => void) {
  const before = new Map(Object.keys(changes).map((n) => [n, process.env[n]]));
  Object.assign(process.env, changes);
  try {
    run();
  } finally {
    for (const [name, value] of before)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

test("in process: the planted git configuration reverses git's order when it is reachable", () => {
  const root = emptyRepository();
  const { home } = reversedOrderConfig();
  stage(root, { "docs/a.md": "a\n", "docs/z.md": "z\n" });
  expect(
    stagedOrderUnder(root, {
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    }),
  ).toEqual(["docs/z.md", "docs/a.md"]);
});

test("in process: stagedNewPaths lists names in git's own order, whatever the user's git configuration says", () => {
  const root = emptyRepository();
  const { home } = reversedOrderConfig();
  stage(root, { "docs/a.md": "a\n", "docs/z.md": "z\n" });
  withProcessEnv({ HOME: home }, () => {
    expect(stagedNewPaths(root)).toEqual(["docs/a.md", "docs/z.md"]);
  });
});

test("in process: the isolation also drops configuration injected through the environment", () => {
  const root = emptyRepository();
  const { order } = reversedOrderConfig();
  stage(root, { "docs/a.md": "a\n", "docs/z.md": "z\n" });
  const injected = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.orderFile",
    GIT_CONFIG_VALUE_0: order,
  };
  expect(stagedOrderUnder(root, injected)).toEqual(["docs/z.md", "docs/a.md"]);
  expect(stagedOrderUnder(root, { ...injected, ...gitEnv })).toEqual([
    "docs/a.md",
    "docs/z.md",
  ]);
  withProcessEnv(injected, () => {
    Object.assign(process.env, gitEnv);
    expect(stagedNewPaths(root)).toEqual(["docs/a.md", "docs/z.md"]);
  });
});

test("in process: stagedNewPaths outside a git repository names the command and git's reason", () => {
  const message = thrownBy(() => stagedNewPaths(outsideRepository()));
  expect(message).toStartWith(
    "git diff --cached --name-only --diff-filter=ACR failed: ",
  );
  expect(message.length).toBeGreaterThan(
    "git diff --cached --name-only --diff-filter=ACR failed: ".length,
  );
});

test("in process: stagedText returns the staged content, not the committed or the working one", () => {
  const root = emptyRepository();
  commitAll(root, { "docs/note.md": "committed\n" });
  stage(root, { "docs/note.md": "staged\n\n" });
  put(root, "docs/note.md", "working");
  expect(stagedText(root, "docs/note.md")).toBe("staged\n\n");
});

test("in process: stagedText of a path git has not staged names the path and the repair", () => {
  const root = emptyRepository();
  put(root, "docs/note.md", "working\n");
  expect(thrownBy(() => stagedText(root, "docs/note.md"))).toBe(
    "git has no staged docs/note.md, so the names check cannot judge a commit by the docs/note.md it will contain. Repair: stage it with git add docs/note.md, then run the names check again.",
  );
});
