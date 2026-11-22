# Gate Coverage

Use this reference when reviewing what a gate covers or reproducing a
refusal. The [rule table](../../CODING_STANDARDS.md#rule-table) names the
gates and their witnesses.

A gate that would check nothing must fail. The names of this repository's own
gates belong to its standards, not to the glossary.

## File size

- `bun run check:file-size` counts tokens with the pinned `tiktoken`
  `o200k_base` encoding. A tracked regular UTF-8 text file can have up to
  5,000 tokens. The template's `bun run check` and the hosted `check` job
  scan the working tree. Pre-commit checks the changed files in the active
  Git index using their staged bytes.
- Declare this template-only gate in Fallow's `supportEntry`. This is the
  local exception to the shared `entry` rule for the file-size gate. The
  normal Fallow audit includes the gate, and the tokenizer stays in
  `devDependencies`. See [Fallow entry settings](https://fallow.tools/docs/configuration/overview/#supportentry).
- The scan excludes files under `vendor/` directories, every `bun.lock`, and
  the generated `fallow-gate.sh` at exactly `.claude/hooks/` and
  `.codex/hooks/`.
- [The gate's recorded hits](../../scripts/file-size-recorded-hits.json) name each
  exception, its reason, and its lifetime. The standing fault-replay record
  reports its token count whenever scanned. Remove a temporary record in the
  change that brings the file within the limit or takes it out of the scan.
  The working tree scan checks every temporary record. Pre-commit checks
  temporary records for changed paths, including removals and renames. It
  reads the recorded hits from the active Git index.

## Refusal lint

- Lint `repository/require-to-throw-message` refuses `toThrow()`,
  `toThrowError()` and `rejects.toThrow()` in `tests/` with no argument, or
  with one that names no message: `undefined` or `void 0`, an empty string,
  or a regular expression that matches a lone NUL character, as `/.*/`,
  `/.+/`, `/^/` and `/(?:)/` do. It reads through a type-only wrapper such
  as `undefined as never`. `.not.toThrow()` passes.
- A message that another guard also throws stays review. So do an error
  class or `expect.anything()` as the argument, a refusal asserted without
  `toThrow`, and input that more than one guard refuses.
- Review only, because the argument is built at run time: `new RegExp("")`,
  `String()`, a template with an expression such as `${""}`, and
  `expect.stringContaining("")`.

## Import coverage

- `tests/template/standards/coverage-gaps.test.ts` runs
  `fallow health --coverage-gaps` and refuses each runtime file, and each
  export of one, that no test reaches by import, unless
  `tests/template/standards/coverage-gaps-recorded-hits.json` records it. It also
  refuses a recorded hit that fallow no longer reports, so the list only
  shrinks. The `test` job runs it through `bun run test`, in three shards.
- It reads a list that fallow leaves out as empty only when the report's
  summary counts none of that kind.
- Fault `aaedd58-doctor` adds to `scripts/doctor.ts` an exported `doneLine`
  that only the spawned doctor calls; the test refuses it.
- Review only: a test that imports a function but never calls it, or calls
  it without asserting what it does; a function the file does not export,
  which counts as reached once a test imports its file; a gap hidden by a
  `fallow-ignore` comment, which the comments lint admits as a directive;
  and a file fallow does not count as runtime, because no entry point
  reaches it or `.fallowrc.json` ignores it.

## Timer lint

- Lint `repository/tests-no-sleep` refuses, in `tests/`: `Bun.sleep` and
  `Bun.sleepSync`, also as `Bun["sleep"]` or destructured from `Bun`; the
  `node:timers/promises` `setTimeout` import; a default, namespace, `import()`
  or `require()` of that module.
- It also refuses a `setTimeout` inside a `new Promise` executor whose
  callback is the executor's `resolve`, or a function whose only statement
  calls `resolve()`, `resolve(undefined)` or `resolve(void 0)`, or that
  passes `resolve` with no value after the delay. It traces `setTimeout` to
  the global, `globalThis` or `node:timers`, under any import name, through
  aliases, `(0, setTimeout)` and type-only wrappers.
- A `setTimeout` that rejects, aborts or resolves with a value passes the
  lint rule. Review what it bounds. A watchdog such as `spawnBounded`
  races a timeout against the child's exit. Awaiting a valued timer on
  its own still waits on wall time. Clearing its handle after the wait
  leaves that delay in place.
- Review only: `setInterval`, `Atomics.wait`, a `Date.now()` poll, a race
  control too narrow to catch its fault, and `scheduler.wait` from a named
  `node:timers/promises` import.
- Also review only: a resolver from `Promise.withResolvers`, a resolver
  pulled out of its promise or aliased inside the executor, a callback that
  resolves another way (`r.bind(null)`, `() => void r()`, `(r(), 0)`, a
  body of more than one statement), and a timer reached through `window`,
  `Bun.setTimeout` or a computed key.

## Generated repositories

- Bootstrap copies the six lint rule files in `config/` into every
  generated repository. Its `eslint.config.mjs` turns on every lint rule
  this repository's `eslint.config.mjs` turns on for a file at the same
  path.
- `tests/template/toolchain/generated-lint.test.ts` generates a repository
  with Bootstrap, and installs the template's packages and the kernel at the
  template's Pin beside it. It fails when the repository lacks a lint rule
  file, holds
  another text of one, or sets a lint rule another way for a file. It
  judges each generated file and twelve probe paths, `scripts/probe.ts`
  among them, so a lint rule narrowed to today's files fails too. It also
  plants one violation of each lint rule, and every comment case.
- The check reads every file form the template's lint rules cover: `.ts`,
  `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.jsx`. Fault
  `815691a-generated-lint-forms` drops the `.js`, `.cjs`, `.jsx` and `.tsx`
  probes; the case that names each file and probe path a lint rule misses
  kills it. Witnessed: [r4625491126].
- Fault `19348a4-recipe-rule-file` drops a lint rule file from the recipe,
  and fault `19348a4-eslint-config-rule-off` drops `no-comments` from the
  generated repository's lint settings; the case that compares a generated
  repository's lint rules kills both.
- `no-in-operator` reads types, so a generated `scripts/` file needs the
  project service and a `tsconfig.json` that includes it. Faults
  `39a7c22-generated-script-types` and `39a7c22-generated-script-tsconfig`
  take each away; the script case kills both through the rule's plain
  JavaScript form.
- The comment and planted-violation cases count each refusal of the lint
  rules they name and every fatal parse error. They leave out the kernel's
  own notices, such as an inline directive that its `src/` settings refuse.
- A generated repository's `tests/pointer-skills.test.ts` holds its pin
  to what an install resolved: `bun.lock`'s kernel line and resolved
  record, and the installed kernel's `.bun-tag`, not only `package.json`.
  Faults `90ef4a0-pointer-skills-lockfile`,
  `44762a3-pointer-skills-resolved` and `90ef4a0-pointer-skills-installed`
  drop each comparison. Witnessed: [90ef4a0] (a pin and pointer moved with
  no install passed the check), [44762a3] (a resolved record at another
  commit passed, and a frozen install then installed it). A new refusal in it with no fault record
  stays review. Witnessed: [47e2ec3] (one landed with none).
- Review only: the truth of a `Platform:` or `Interface:` claim in a
  generated repository; a lint rule file edited in a generated repository;
  a folder the template has no file under, such as a package's own
  `scripts/`; and each gate script of this repository, which no generated
  repository gets.

## Untrusted-value lints

Both rules run on `.ts` files under `src/` and `scripts/`. Review other
file extensions in those directories.

- Lint `repository/no-locale-compare` refuses `localeCompare` and
  `Collator` as a property, a destructured name, or a constant string such as
  `Reflect.get(Intl, "Collator")`.
- Lint `repository/no-in-operator` in `config/payload-rules.mjs` refuses
  the `in` operator and `Reflect.has` on a key the target's type does not
  declare, and every `for...in`. A key
  declared on the target's type, or on one member of its union, passes, so
  `in` still narrows a union. A private name (`#id in value`) and
  `Object.hasOwn` pass.
- Tests stay review. The `in` witnesses were source reading another
  program's payload, and a test reads values it built.
- Also review only: an index read such as `fields[key]` with a key from a
  payload, and a key the type declares that a value only inherits.
- Other source stays review in this table.

## Comments

- Lint `repository/no-comments` refuses every comment block in a file
  `eslint.config.mjs` lints: `src/`, `scripts/`, `tests/`, `config/` and the
  root `.mjs` files. Consecutive line comments are one block.
- A block stays only when it is one of these:
  - `Platform:` on its first line: behaviour of a runtime, operating system
    or tool this repository cannot change, such as an errno meaning or a Bun
    limit.
  - `Interface:` on its first line: a public contract the types cannot
    state.
  - The phrase "accepted decision" or "accepted decisions" anywhere in
    the block.
  - A lint or compiler directive, such as `eslint-disable-next-line` or
    `@ts-expect-error`. Other rules govern those.
  - `SAFETY:` and a justification on its first line, on its own lines
    directly above the statement that holds a type cast (`as T`, not
    `as const`).
- Everything else goes into code: a name, a type, a test title, or a lint
  rule whose message explains the constraint. An empty `catch` says what
  happens next in code (`return`, `continue`, or a rethrow), not in prose.
- Fault `5ac4285-template-rules` admits a marker on any line of a block; the
  lint test that refuses `Platform:` on a second line kills it.
- Fault `bbfce9a-template-rules` admits a `SAFETY:` block anywhere; the lint
  test that refuses one above a statement with no cast kills it.
- In review, verify what a `Platform:` or `Interface:` comment claims and
  whether it names something outside this repository. Witnessed: [47e2ec3]
  (a `Platform:` claim said token substitution refuses every entry that is
  not a regular file; it walks folders).
- In review, verify each accepted decision citation. Require a Command
  Contract 3 question number, an ID such as `N4a`, or the ruling date.
  Consult the [CLI kernel authority](../agents/cli-kernel.md).
- A generated repository gets these lint rules too: see
  [Generated repositories](#generated-repositories).
- Not covered: `generated-repository/`, which ESLint skips here and a
  generated repository lints, the `.ts.txt` fixtures, YAML and Markdown.

## Host path lint

- Lint `repository/no-host-path-literal` refuses a string, or the head of a
  template literal, that starts at `/private`, `/usr`, `/var`, `/tmp`,
  `/etc`, `/opt`, `/Users`, `/home`, `/Library` or `/System`, in every file
  `eslint.config.mjs` lints. `/dev/null`, `/bin/sh` and a shebang pass: both
  hosts have them.
- Review only: a path built at run time, such as `"/" + "tmp"` or
  `join("/", "usr")`; a host path after a template expression; other roots,
  such as `/proc` or `/run`; and `generated-repository/`, which ESLint
  skips here.

## Fault replay

- Fault replay fails on a fault record whose named test passes with the
  planted fault applied or fails without it, or whose patch file is
  missing. A patch also fails replay when it creates or deletes a whole
  file, or when a changed region's anchor is in no file replay searches, or
  is at more than one place and its context lines do not choose one.
  Witnessed: [50dbf8e] (a new line took the semicolon a fault's anchor
  held, and replay reported the fault STALE).
- Replay places each changed region of a hunk by its anchor: the lines it
  removes, or, for a region that only inserts, the context lines next to
  it. A region lands wherever its anchor occurs once, even if its other
  context moved. Only a region that removes lines is searched for in
  other tracked files when its recorded file lacks the anchor; a region
  that only inserts stays in its recorded file. Context chooses between
  places only when one matches at least as far as every other on both
  sides, and further on one.
- Whether the chosen place is the one the fault meant stays review: a
  fault in the wrong place still fails its test.

## Names check

- `tests/template/names-check/names.test.ts`, with its shrinking
  `tests/template/names-check/recorded-hits.json`, checks every tracked file and
  folder name against `GLOSSARY.md`. Pre-commit runs the same names check on
  staged names (`--staged`), file-creation hooks run `--tool-call`, and pull
  requests run `--against`.
- The symbol gate (`scripts/public-declarations.ts`) applies those rules to the
  public surface in `tests/template/names-check/public-surface.json`: exports
  in Bootstrap's copied code and consumed exports in `src/*.ts`, one level of
  members and parameters deep. Locals and comments stay review only.
- For added paths and new public declarations against the base (`--staged`,
  `--against`, `--tool-call`, and new given paths), `scripts/name-words.ts`
  requires every word to come from a term heading in `GLOSSARY.md`, a kernel
  term in `glossary-ownership.json`, the design words, or
  `names-plain-words.json` (matching an optional trailing `s` either way).
  Existing names and renamed paths that keep their last segment are not judged
  again; Avoid and Qualify refusals keep their own lines and run first.
- To propose a new plain word when no glossary term fits, add a sorted
  `{ "word", "reason" }` entry to `names-plain-words.json` and list each added
  word under its own heading in the pull request description for Nathan's
  decision.

## Recorded hits

- `eslint-suppressions.json` holds the recorded hits each lint rule found
  when it landed.
- ESLint records a count per lint rule and file. `bun run lint` fails when
  the count grows or when the count falls and leaves an unused suppression.
  Run `bunx eslint . --prune-suppressions` after fixing a recorded hit.
- Review replacements within a file. Replacing one violation with another
  for the same lint rule can keep the count and pass lint.
- The template's lint rules live in `config/template-rules.mjs`,
  `config/platform-rules.mjs` and `config/payload-rules.mjs`.
  `platform-rules.mjs` owns `no-host-path-literal` and `payload-rules.mjs`
  owns `no-in-operator`. `eslint.config.mjs` joins the three under the
  `repository` plugin.
- The kernel's lint rules and their recorded hits left with the kernel. The
  kernel repository owns them.

[r4625491126]: https://github.com/nathanvale/bun-typescript-template/pull/114#discussion_r4625491126
[47e2ec3]: https://github.com/nathanvale/bun-typescript-template/commit/47e2ec3c245279421f11ab054db621c97e213333
[50dbf8e]: https://github.com/nathanvale/bun-typescript-template/commit/50dbf8ea8f54524939c2a76d992fa9c7ded90c02
[90ef4a0]: https://github.com/nathanvale/bun-typescript-template/commit/90ef4a0963b1909615f144a78f1946c661c38a89
[44762a3]: https://github.com/nathanvale/bun-typescript-template/commit/44762a309b311944da6f0f9038a26e769b1e7cbb
