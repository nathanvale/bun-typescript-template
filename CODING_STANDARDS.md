# Coding Standards

Read at review. This file holds only lessons this repository witnessed in
review feedback or repair commits. It extends Engineering's shared coding
standard. The guides call it the shared standard and cite it by title.

Read the shared standard from the first available source.

1. The copy your task brief supplies.
2. Its current source, `docs/standards/CODING_STANDARDS.md` in
   `nathanvale/dotfiles-private`, pinned at [6bcadfd][shared-standard]. This
   pin is a bridge until your domain selects an approved version.

If you can reach neither, apply this file and its guides alone, and report the
shared standard as missing context. No approved route delivers the shared
standard to a fresh checkout yet. [MAG-65] owns preparing that route,
[MAG-88] owns source adoption, and [MAG-78] owns the deployment repository.

A rule row enters with at least two witnesses. Its guide cites them, or its gate
note does when the row has no guide in `docs/standards/`. A guide bullet cites
the witnesses that taught it, one or more. A guide bullet with no citation tells the
reviewer how to apply the rule row. A lesson with one witness waits in
[Single witness](docs/standards/single-witness.md) until a second arrives.

Each rule row names what enforces it today:

- **Review only**: no gate; the reviewer applies the guide.
- **Partial**: the gates in its Gates cell cover the part its gate note
  names; the reviewer applies the guide to the rest.

The Gates cell names each gate as `script`, `lint`, `job` or `fault` with its
id, and links the gate note. A `fault` id is a record id in
`tests/planted-faults/fault-records.json`. **Planned (parked)** names agreed
gates that do not exist yet. Plan units U4 to U6 in the description of [#8]
first named them. The lints and the fault replay have landed. The rest has no
slot, and [MAG-98], the Contract 3 scope issue, does not list them.

When a planned gate lands, name it in the Gates cell, mark the row Partial,
and cut the guide bullets it now enforces. `bun run test:area standards`
checks that every cited commit, link and named gate exists, and that each
row's guide or gate note cites two distinct witnesses.

## Rule table

| Rule                                                         | Today       | Gates                                                                                                                     | Planned (parked)                           | Guide                                                               |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Each test fails for the reason its name gives                | Partial     | [lint `repository/require-to-throw-message`](#test-proof)                                                                 | Typed rule ids                             | [Test proof](docs/standards/test-proof.md#refusals-and-bounds)      |
| Each new refusal or bound has a planted fault                | Partial     | [script `fault-replay`, job `fault-replay`](#planted-faults)                                                              | None                                       | [Test proof](docs/standards/test-proof.md#planted-faults)           |
| Process proofs use the production entry                      | Review only | None                                                                                                                      | None                                       | [Test proof](docs/standards/test-proof.md#production-entry)         |
| Script functions are tested in-process                       | Partial     | [job `test`, fault `aaedd58-doctor`](#in-process-tests)                                                                   | None                                       | [Test proof](docs/standards/test-proof.md#in-process-tests)         |
| Test processes are bounded and released                      | Review only | None                                                                                                                      | Lint `tests-use-bounded-runner`            | [Test proof](docs/standards/test-proof.md#processes)                |
| Tests fake a tool with a stub script                         | Review only | None                                                                                                                      | Lint `tests-stub-tools`                    | [Test proof](docs/standards/test-proof.md#fake-tools)               |
| Tests wait on events, not wall time                          | Partial     | [lint `repository/tests-no-sleep`](#time)                                                                                 | None                                       | [Test proof](docs/standards/test-proof.md#time)                     |
| Test timings follow a moved suite                            | Review only | None                                                                                                                      | Test that timing keys match the test files | [Test proof](docs/standards/test-proof.md#timings)                  |
| A lint rule holds on each shape it can meet                  | Review only | None                                                                                                                      | None                                       | [Test proof](docs/standards/test-proof.md#lint-rules)               |
| One rule holds on every construction route                   | Review only | None                                                                                                                      | `AdmittedCommand` brand                    | [One rule, one path](docs/standards/one-rule-one-path.md)           |
| Every exit path emits exactly one envelope                   | Review only | None                                                                                                                      | None                                       | [Failure envelopes](docs/standards/failure-envelopes.md)            |
| Untrusted values are read once, as own data                  | Partial     | [lint `repository/no-locale-compare`, lint `repository/no-in-operator`, fault `b9e392f-payload-rules`](#untrusted-values) | None                                       | [Untrusted values](docs/standards/untrusted-values.md#object-model) |
| Delays, waits, and work have stated bounds                   | Review only | None                                                                                                                      | `Milliseconds` and `Bound` brands          | [Untrusted values](docs/standards/untrusted-values.md#bounds)       |
| Untrusted bytes are decoded strictly                         | Review only | None                                                                                                                      | Gate job for its planted faults            | [Untrusted values](docs/standards/untrusted-values.md#bytes)        |
| A path or file name may hold any byte but NUL                | Review only | None                                                                                                                      | Gate job for its planted faults            | [Untrusted values](docs/standards/untrusted-values.md#separators)   |
| A path is refused in every spelling but the plain one        | Review only | None                                                                                                                      | Gate job for its planted faults            | [Untrusted values](docs/standards/untrusted-values.md#plain-paths)  |
| An entry is inspected itself, not what a link points to      | Review only | None                                                                                                                      | Gate job for its planted faults            | [Untrusted values](docs/standards/untrusted-values.md#links)        |
| An unreadable input is reported, never read as empty         | Review only | None                                                                                                                      | Gate job for its planted faults            | [Untrusted values](docs/standards/untrusted-values.md#failed-reads) |
| Behaviour holds on Linux and macOS                           | Partial     | [job `test`, lint `repository/no-host-path-literal`, fault `b79a4ac-platform-rules`](#linux-and-macos)                    | None                                       | [Platform parity](docs/standards/platform-parity.md)                |
| Glossary terms only                                          | Partial     | [job `test`](#glossary)                                                                                                   | Lint `glossary-term`                       | [Glossary map](GLOSSARY-MAP.md)                                     |
| One owner per constant, fake, and helper                     | Partial     | [lint `repository/tests-use-test-folder`](#one-owner)                                                                     | None                                       | [One owner](docs/standards/one-owner.md)                            |
| Each commit is green at its own head                         | Partial     | [script `check:commits`, job `commits`](#commits)                                                                         | None                                       | None                                                                |
| Say it in code, not in a comment                             | Partial     | [lint `repository/no-comments`, fault `5ac4285-template-rules`, fault `bbfce9a-template-rules`](#comments)                | None                                       | None                                                                |
| A gate reads what a lock resolved, not only what it declares | Partial     | [fault `d7aa03e-generated-toolchain-overridden`](#resolved-records)                                                       | None                                       | None                                                                |
| A gate refuses an input form it cannot read                  | Partial     | [fault `d7aa03e-generated-toolchain-exact`, fault `d7aa03e-generated-toolchain-exclusions`](#unread-forms)                | None                                       | None                                                                |

## Gate notes

### Linux and macOS

- `.github/workflows/ci.yml` runs on every pull request.
- `R1.platform-outcomes-pinned` pins unproved diagnostics rows only.
- State `caseTest` titles can show `UNPROVED` off their platform, but no test
  pins their count.
- `tests/kernel/approval/component.test.ts` still reports unproved cases
  through `test.skip`.
- `.github/workflows/macos-nightly.yml` runs on schedule once it reaches
  `main`.
- Lint `repository/no-host-path-literal` refuses a host path written as a
  literal. Review a path built at run time. See
  [the gate's coverage](docs/standards/gate-coverage.md#host-path-lint).
- Fault `b79a4ac-platform-rules` drops `/private` from that list; the lint
  case for the [ff5fffe] shape kills it.
- Witnessed: [8e4ec47], [ff5fffe].

### Glossary

- `tests/template/glossary/glossary.test.ts`, with its shrinking `known-hits.json`,
  checks the `scope` listed in `tests/template/glossary/term-table.json`.
- That scope is kernel source, kernel tests, and the kernel's lint config.
  `src/`, the starters, and docs are review only.
- Witnessed: [2784de0], [356cce9].

### Test proof

- The lint checks for a message argument. Review which guard
  refused the input. See [the gate's coverage](docs/standards/gate-coverage.md#refusal-lint).
- Witnessed: [185c90d].

### In-process tests

- The coverage-gaps test checks which runtime files and exports
  tests reach by import. Review what the tests assert. See [the gate's coverage](docs/standards/gate-coverage.md#import-coverage).
- Witnessed: [9f3c666], [fa8b6f5].

### Planted faults

- `bun run fault-replay` replays each record in
  `tests/planted-faults/fault-records.json` in a temporary worktree. The
  `fault-replay` job in `.github/workflows/ci.yml` runs it on every pull
  request.
- Pre-push runs `bun run fault-replay --changed-since <base>` for faults
  affected by the push. The hosted `fault-replay` check replays every fault record.
- Fault replay fails on a fault record it cannot judge or place. Review
  whether the place it chose is the one the fault meant. See
  [the gate's coverage](docs/standards/gate-coverage.md#fault-replay).
- A new refusal or bound with no fault record stays review. So does a fault
  record whose test title matches more tests than the planted fault reaches.
- Witnessed: [d72cd9e], [640ba05].

### Time

- The lint catches delay-only waits. Review the timing controls
  outside its matcher. See [the gate's coverage](docs/standards/gate-coverage.md#timer-lint).
- Witnessed: [d1436c0].

### Untrusted values

- Review scopes and exceptions in [Untrusted-value lints](docs/standards/gate-coverage.md#untrusted-value-lints).
- Fault `b9e392f-payload-rules` lets an index signature declare every key;
  the lint case for the [r4580070979] shape kills it.
- Witnessed: [b456208], [5cbff3a], [r4580070968], [r4580070979],
  [r4580077776], [r4606943328].

### One owner

- Lint `repository/tests-use-test-folder` refuses `tmpdir()`, `mkdtemp()`
  and `mkdtempSync()` in `tests/`, outside `tests/support/test-folder.ts`.
  That shared `tests/support/` module owns test folders through
  `testFolder()`, which honours `STATE_TEST_DIR`.
- The lint traces a callee to the name it was imported or read as: a named,
  renamed, default or namespace import, `require()`, `import()`,
  destructuring, an alias, or a member with a string key. A key built at
  runtime, a function passed in as a parameter, and a helper module that
  re-exports one under another name stay review.
- Witnessed: [e7c771c], [c0b4bf5].

### Commits

- `bun run check:commits <base>` installs, type-checks and lints each commit
  in `<base>..HEAD` at its own head, in a temporary worktree. The `commits`
  job in `.github/workflows/ci.yml` runs it against the pull request base.
- It never checks `f20777f` or an older commit. Some of those are red.
- Format and tests at each commit stay review.
- Witnessed: [2d0c390], [258365e], [59d45c1], [de45f44], [d3df03e],
  [4737c48], [e07d962].

### Comments

- The lint checks comment markers, directives and cast placement.
  Review the truth of `Platform:` and `Interface:` claims. See [the gate's coverage](docs/standards/gate-coverage.md#comments).
- Witnessed: [08284b7], [887b514].

### Resolved records

- Fault `d7aa03e-generated-toolchain-overridden` drops the comparison of
  `bun.lock`'s records for an overridden package, nested ones included,
  with what the override installs; the overridden-package case in
  `tests/template/toolchain/generated-toolchain.test.ts` kills it.
- Review only: every other gate that reads a lock or a generated file.
  Static admission's `checkLock` compares an override's declaration and
  its resolved record already.
- Witnessed: [r4623512571], [r4623566986].

### Unread forms

- Fault `d7aa03e-generated-toolchain-exact` compares any version string
  as an exact version; the caret-range case in
  `tests/template/toolchain/generated-toolchain.test.ts` kills it. Fault
  `d7aa03e-generated-toolchain-exclusions` reads a `workspaces` list
  with a `!` exclusion as plain member folders; the exclusion case kills
  it.
- Review only: the forms every other gate reads, and whether its refusal
  names the forms it does read.
- Witnessed: [r4623512612], [r4623566970], [r4623566963].

### Recorded hits

Use the [recorded hits guide](docs/standards/gate-coverage.md#recorded-hits)
when adding, fixing, or pruning a lint hit.

## Review routine

1. List the rule rows the diff touches.
2. For each Partial rule row, find each gate in the hosted check result
   for the head your caller passed in the prompt. Report a gate the result
   does not show green as **unproved**, never as a pass. For questions
   about coverage, follow its gate note and any linked detail.
3. For each Review only or Partial rule row, open its guide, or its gate note when
   it has no guide, and apply every bullet to the diff.
4. Report each finding with its rule row and the guide or gate-note bullet it breaks.

[MAG-98]: https://linear.app/myagentdojo/issue/MAG-98/command-contract-30-foundation-accepted-implementation-scope
[#8]: https://github.com/nathanvale/bun-typescript-template/pull/8
[MAG-65]: https://linear.app/myagentdojo/issue/MAG-65/define-coordinator-privacy-and-composable-task-execution
[MAG-88]: https://linear.app/myagentdojo/issue/MAG-88/epic-reproducible-repository-foundations
[MAG-78]: https://linear.app/myagentdojo/issue/MAG-78/name-and-create-the-deployment-repository
[shared-standard]: https://github.com/nathanvale/dotfiles-private/blob/6bcadfd752107a980ce4f0a8982ff18399dc78f2/docs/standards/CODING_STANDARDS.md
[185c90d]: https://github.com/nathanvale/bun-typescript-template/commit/185c90d11dd167ee4874e383ba26cd7d64a70964
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[d1436c0]: https://github.com/nathanvale/bun-typescript-template/commit/d1436c0c13b2906e5eee1c08dfcea41c611f0bef
[c0b4bf5]: https://github.com/nathanvale/bun-typescript-template/commit/c0b4bf5e77558cc08922d5b303f5d9ba0af87066
[b456208]: https://github.com/nathanvale/bun-typescript-template/commit/b456208a45baa1f912a27a60eb70353c1e64d251
[5cbff3a]: https://github.com/nathanvale/bun-typescript-template/commit/5cbff3a87746defffd2672320038c48fbd1ddbc6
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[2784de0]: https://github.com/nathanvale/bun-typescript-template/commit/2784de083f90d5f72f1b10037bfc64a8eeccff3f
[356cce9]: https://github.com/nathanvale/bun-typescript-template/commit/356cce90dd2c4a75c7462f5d8f789b52bdaefaed
[2d0c390]: https://github.com/nathanvale/bun-typescript-template/commit/2d0c3902e6ca538b1e9dfd64c97458bd4b4f88ae
[258365e]: https://github.com/nathanvale/bun-typescript-template/commit/258365ed51313b4b190361d79609bc93bfc13d6a
[59d45c1]: https://github.com/nathanvale/bun-typescript-template/commit/59d45c1b84d347e3a8b2d617ac73e36096790dc9
[de45f44]: https://github.com/nathanvale/bun-typescript-template/commit/de45f443c1c71221a29ae03c203bd00ef1a4bffb
[d3df03e]: https://github.com/nathanvale/bun-typescript-template/commit/d3df03eccd47e3054de9e442971f778d1f13e803
[4737c48]: https://github.com/nathanvale/bun-typescript-template/commit/4737c4869802bb53893387df9919171855e83b11
[e07d962]: https://github.com/nathanvale/bun-typescript-template/commit/e07d962f016dc07ca442724621fd0406084521cc
[08284b7]: https://github.com/nathanvale/bun-typescript-template/commit/08284b762cf58a08777c846637a427e84caf0fe9
[887b514]: https://github.com/nathanvale/bun-typescript-template/commit/887b5140efe57411a674f872c1269d40b7bf019b
[9f3c666]: https://github.com/nathanvale/bun-typescript-template/commit/9f3c66623003b3ef1dd355b6b7ef93882cd937a2
[fa8b6f5]: https://github.com/nathanvale/bun-typescript-template/commit/fa8b6f5ac1733b1eedc1e8d78d267414ebc5c4cb
[8e4ec47]: https://github.com/nathanvale/bun-typescript-template/commit/8e4ec47c9603f50548edb7d71087bd7f8d840819
[ff5fffe]: https://github.com/nathanvale/bun-typescript-template/commit/ff5fffe0718d64921d899aba35fca14b58d6f69a
[r4580070968]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070968
[r4580070979]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070979
[r4580077776]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077776
[r4606943328]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943328
[r4623512571]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623512571
[r4623566986]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623566986
[r4623512612]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623512612
[r4623566970]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623566970
[r4623566963]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623566963
