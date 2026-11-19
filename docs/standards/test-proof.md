# Test Proof

A test earns its name when it goes **red** for the reason the name gives. The
shared independent-oracle rule applies; this guide lists the ways this
repository broke it.

## Refusals and bounds

- Assert the exact refusal the named guard produces. An assertion that only
  something threw stays green when another guard refuses. Witnessed: [#91-count],
  [185c90d], [5990897], [fa359ec] (the repository description parser had
  five refusals and no test), [97f9e9b] (a length check accepted any reason
  for a parse failure; take the reason from an independent call of the
  parser), [#90-inventory] (exit 1 also covered unrelated inventory errors).
- Assert the route's response when a test says a command remains available.
  Exit zero with empty output can pass without a response. Witnessed:
  [#90-routes].
- Shape the input so only the named guard can refuse it. An earlier parse or
  build check, or a neighbouring cap at the same limit, keeps the test green
  with the named guard removed. Witnessed: [640ba05], [96ab832], [c193c51].
- Control each side of a boundary: the last admitted and the first refused
  value or case. Checks further out stay green under an off-by-one limit.
  Witnessed: [e07d962], [d72cd9e].
- Pin a bound with a tolerance tighter than the fault it must catch. A
  first-signal kill at 550 ms passed a 500 ms bound plus its tolerance.
  Witnessed: [b8760b4], [8485278], [aa161e5] (a lower bound only, so a late
  kill still passed), [dbd196e] (a timeout message that reads the same
  constant stays green when the timer is changed, so measure the elapsed
  time), [#73-deadline] (a 2 s assertion accepted a missed 300 ms
  deadline).
- Require a project's evidence list to exist and contain at least one entry.
  A check against an empty array can accept a missing field. Witnessed:
  [#91-projects].
- Prove a resolution by a refusal only the right folder can give. A recorded
  hit or an empty result passes for a skipped check too, and a process
  folder with the same tail as the injected one passes for the wrong
  folder. Give the test distinct fallback and destination folders, and
  assert the destination in the refusal. Witnessed: [9ad6bf2], [#72-cwd].
- Prove that a fixture meant to lack something lacks it, and fail loudly
  when its location supplies it. `STATE_TEST_DIR` can place a test folder
  inside the checkout, where git finds the parent repository for a case that
  expects none. Witnessed: [8946615].
- Require one recorded process before checking that it exited. A missing
  process ledger lets an empty-result check pass. Witnessed: [#84-ledger].
- Show that a planted input changes the result when nothing blocks it, with
  a control, before asserting the subject ignores it. A `HOME` change under
  `GIT_CONFIG_GLOBAL=/dev/null` hides the planted `.gitconfig` whether or not
  the isolation works. Witnessed: [315de28].

## Production entry

- Build a process proof's subject through `index.ts`, the production seam
  the shared test-execution rule asks for. A test entry such as `fixture.ts`,
  or a fault-wrapped CLI, proves only the fixture. Witnessed: [e55f94a],
  [7ea1ee3].
- Start the entry from the folder a caller starts it in. `bun run <script>`
  moves the child to the package root, so a proof through a package script
  never exercises the entry's own process folder. Witnessed: [c5a554e].

## In-process tests

- Call and assert each function a script or the CLI runs, unexported ones
  too, from the test that imports its file, beside the process proof that
  spawns the entry. Coverage cannot see into a spawned process, so a
  function proved only that way reads as untested and its mutants never
  run.
- Resolve each path from the environment a function is given, not from the
  process's own folder, so an in-process call runs on what the test injects.
  Witnessed: [244b63a].

## Planted faults

- Apply the shared RED-then-GREEN rule to every new refusal or bound.
- Record each planted fault in `tests/planted-faults/fault-records.json`.
  After the fix commit, run
  `bun run planted-fault:add <fix sha> <source path> <test file> <title>`,
  then `bun run fault-replay <id>` until it prints `KILLED`. Witnessed:
  [9050fec], [b8664cf] (each recorded faults for refusals that had landed
  with no record).
- Replay affected fault records when you edit or move a test that catches
  a planted fault, or change the source its patch targets. Keep the patch
  and test selector current in the same commit and require `KILLED`.
  A split guard left a patch stale, and the original changed-file selector
  missed test-only edits. Witnessed: [#54-stale], [#77-test].
- Treat a surviving fault as a missing test. Witnessed: [d72cd9e], [640ba05].

## Processes

- Bound every child below its test timeout, a fixture's git call and a
  script's synchronous git read included. Witnessed: [#85-probe], [e990da6],
  [#92-bound] (the in-process fault fixture could block on git),
  [4a32366],
  [7623343], [#91-bound] (the native admission fixture could outlive its
  case), [c77aaa9] (the production `execute` spawned tsc and fallow with
  no time limit), [24cbab3], [#84-probe] (blocking fixture commands could
  prevent the test timeout and cleanup), [#90-process] (bootstrap helpers
  could wait indefinitely for a generated repository command),
  [#109-bound] (a process-runner case started a nested child with no time
  limit).
- Template tests: reuse `spawnBounded` (`tests/support/process.ts`), which
  runs the child through `startChild` (`scripts/process-runner.ts`), for that
  bound.
- In `finally` or per-case teardown, release the CLI, its ledgered children,
  then its temporary folders. Witnessed: [d592b6d], [70c7280], [#84-cleanup],
  [#91-cleanup], [5533cd6].
- At teardown, send SIGKILL, and only to a pid still in its ledgered process
  group. Witnessed: [0ebe7cf], [1a29b19].

## Fake tools

- Fake a tool with a small stub script that holds its behaviour, not a
  system binary linked under the tool's name. A linked `/bin/echo` named
  `tsc` exited non-zero on GitHub's Linux runner, and a linked `/bin/sh`
  named `fallow` leaned on a file named `list` to become the script.
  Witnessed: [3729f36], [5f0c1d9] (Copilot review thread on the same pull
  request).

## Time

- Wait on an event the subject produces (a ready file, ledger line, or
  barrier). Witnessed: [b077b0b], [4386b03].
- Widen a race control until it catches its fault on every run. Witnessed:
  [2b2907a] (caught in 48 of 50 runs before widening).
- Bound a duration a test reads back from output by zero below and, above,
  by the wall time it measured plus half the printed precision (0.05 s for
  one decimal). A rounded duration can read 0.0 on a fast host, so an
  assertion above zero fails there. Witnessed: [07d2d72], [e50afb6].

## Timings

- Refresh the moved suites' entries in `tests/test-timings.json` from the
  hosted timing artifacts when a slow suite moves, and drop the keys of the
  paths it left. Witnessed: [#91-timings] (the original estimate stayed on
  the smallest suite, and all five moved suites ran on one shard),
  [#99-timings], [#99-shards] (the timings kept the old
  `tests/check-commits.test.ts` key, and every moved template suite ran on
  shard 3).

## Lint rules

- Prove a lint rule on each shape its matcher can meet, not only on the
  cases of the rule it ports: a callback with more or fewer parameters, a
  function nested inside the one it judges, a binding written more than
  once, a type argument that repeats its alias, an alias whose parameter
  shares a name with an outer one, a spread into call arguments, and a
  member key written as a template literal. A port inherits its source's
  gaps; the rule each port copies (oxc's `no_accumulating_spread` at
  `oxlint_v1.93.0`, or the anti-slop source that
  `config/anti-slop-rules.mjs` pins) shares each witnessed one.
  Witnessed: [#102-parameters] (a reducer that also takes the index passed
  `no-accumulating-spread`), [#102-alias] (`Identity<Identity<unknown>>`
  passed `no-unknown-type-aliases`), [#102-nested] (a spread in a `map`
  callback inside a reducer was reported against the reduce), [#102-reset]
  (a plain reset before a loop hid the loop's spread), [#102-outer]
  (`Wrap<T = unknown> = Fixed` lent its `T` to `Fixed`, so `Safe = Wrap` was
  reported), [#102-arity] (a one-parameter reducer passed
  `no-accumulating-spread`), [#102-arguments] (`consume(item, ...args)` was
  reported as an accumulator copy), [#102-mock-key] (``vi[`mock`]`` passed
  `no-module-mocking`), [#102-copy-key] (``all[`concat`]`` passed
  `no-reduce-accumulator-copy`).

[#91-count]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744321
[185c90d]: https://github.com/nathanvale/bun-typescript-template/commit/185c90d11dd167ee4874e383ba26cd7d64a70964
[640ba05]: https://github.com/nathanvale/bun-typescript-template/commit/640ba05881da2694fbdfad9b1d124bd85d36c0e4
[96ab832]: https://github.com/nathanvale/bun-typescript-template/commit/96ab832e7e7aa6fb992a0762fba6f833c172f800
[5990897]: https://github.com/nathanvale/bun-typescript-template/commit/5990897fadd6e452119666769b96d72452a197ab
[c193c51]: https://github.com/nathanvale/bun-typescript-template/commit/c193c5148054184659d921150f714603a72d48d0
[d72cd9e]: https://github.com/nathanvale/bun-typescript-template/commit/d72cd9e28a0e7d7d0ec1fc4f67ebc030e387c914
[b8760b4]: https://github.com/nathanvale/bun-typescript-template/commit/b8760b478768ab711252b16f9a4a2c97a0dd6d44
[e07d962]: https://github.com/nathanvale/bun-typescript-template/commit/e07d962f016dc07ca442724621fd0406084521cc
[8485278]: https://github.com/nathanvale/bun-typescript-template/commit/8485278bf38a457d7d1823ba98daa153a9bb35a8
[e55f94a]: https://github.com/nathanvale/bun-typescript-template/commit/e55f94a5b7dcb78f9b25f5d0a723a2196bd8c452
[7ea1ee3]: https://github.com/nathanvale/bun-typescript-template/commit/7ea1ee3853cb6251fcf93c6a6ecf683e065fbfef
[#92-bound]: https://github.com/nathanvale/bun-typescript-template/pull/92#discussion_r4607819546
[#85-probe]: https://github.com/nathanvale/bun-typescript-template/pull/85#discussion_r4607322041
[e990da6]: https://github.com/nathanvale/bun-typescript-template/commit/e990da67151a9c3b6a0e90c240f7e0860856c4d2
[4a32366]: https://github.com/nathanvale/bun-typescript-template/commit/4a32366bf79ea95479bda515313b33b849031507
[c77aaa9]: https://github.com/nathanvale/bun-typescript-template/commit/c77aaa9ec56157f4701db117f9aa04e736c6e5df
[#91-cleanup]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744353
[5533cd6]: https://github.com/nathanvale/bun-typescript-template/commit/5533cd63b22f8e5119969968e109af6788289e86
[d592b6d]: https://github.com/nathanvale/bun-typescript-template/commit/d592b6d1eb13754bd46e041313511e7530e9804e
[0ebe7cf]: https://github.com/nathanvale/bun-typescript-template/commit/0ebe7cf570b901653e090cb9062d0b438a5c25d1
[1a29b19]: https://github.com/nathanvale/bun-typescript-template/commit/1a29b19ac6e32452d230dcbf46ccecc4f60223fc
[b077b0b]: https://github.com/nathanvale/bun-typescript-template/commit/b077b0bc152a2ea1f9d8b17b49ba0cf61435111a
[4386b03]: https://github.com/nathanvale/bun-typescript-template/commit/4386b03503e12787b7d20062c9ae1b4f6942fbdf
[2b2907a]: https://github.com/nathanvale/bun-typescript-template/commit/2b2907a6b15e23a3ca8b8111b251ca6c68f467c3
[fa359ec]: https://github.com/nathanvale/bun-typescript-template/commit/fa359ece5ae03bc913393e4d80b78836c39b7ef9
[aa161e5]: https://github.com/nathanvale/bun-typescript-template/commit/aa161e5b402b55037192f9ccbcd74896e9a62d11
[9050fec]: https://github.com/nathanvale/bun-typescript-template/commit/9050fec545a21a1995b0014151b4d486c2188e06
[b8664cf]: https://github.com/nathanvale/bun-typescript-template/commit/b8664cfdcb826e3870b52b0141c0f4f2efb2eba0
[70c7280]: https://github.com/nathanvale/bun-typescript-template/commit/70c7280c8253b0badc173898fcb5ca44b8e2198b
[07d2d72]: https://github.com/nathanvale/bun-typescript-template/commit/07d2d72ed7c68fda55cd6b065dbb5b4e5f407763
[e50afb6]: https://github.com/nathanvale/bun-typescript-template/commit/e50afb6e27a9facc40ec0b932779ffa81a29784c
[244b63a]: https://github.com/nathanvale/bun-typescript-template/commit/244b63a814ddbb60b4831cabc0e2f8cd1b73bca4
[c5a554e]: https://github.com/nathanvale/bun-typescript-template/commit/c5a554e0034342f6918775909fcd3b15e27facca
[8946615]: https://github.com/nathanvale/bun-typescript-template/commit/894661580864b423b07cd4571bdd0c9da69c1911
[#91-bound]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744346
[7623343]: https://github.com/nathanvale/bun-typescript-template/commit/76233438395b1e967f461ded4a34f6c1d2c8a533
[315de28]: https://github.com/nathanvale/bun-typescript-template/commit/315de28d3e1da69a4e8d65923654846405a3d1c8
[dbd196e]: https://github.com/nathanvale/bun-typescript-template/commit/dbd196e8dd2dc19163d201cfb4f089952f1c471f
[#91-projects]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744327
[9ad6bf2]: https://github.com/nathanvale/bun-typescript-template/commit/9ad6bf2528f0c65fc5106e8377c469b2e48b1743
[97f9e9b]: https://github.com/nathanvale/bun-typescript-template/commit/97f9e9b82277a054b8b64ac03194a31be27e5ded
[3729f36]: https://github.com/nathanvale/bun-typescript-template/commit/3729f3644cb30ea5decc9c085bc6b9c4304eaae4
[5f0c1d9]: https://github.com/nathanvale/bun-typescript-template/commit/5f0c1d99741751de14f5cb92618eda3bd92e8887
[#72-cwd]: https://github.com/nathanvale/bun-typescript-template/pull/72#discussion_r4606134426
[#73-deadline]: https://github.com/nathanvale/bun-typescript-template/pull/73#discussion_r4606053862
[#54-stale]: https://github.com/nathanvale/bun-typescript-template/pull/54#discussion_r4603739936
[#77-test]: https://github.com/nathanvale/bun-typescript-template/pull/77#discussion_r4606037347
[24cbab3]: https://github.com/nathanvale/bun-typescript-template/commit/24cbab36274dd093e76f248e7d36f86a2ef12cee
[#84-ledger]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244520
[#84-probe]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244511
[#84-cleanup]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244525
[#90-inventory]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634930
[#90-routes]: https://github.com/nathanvale/bun-typescript-template/pull/90#pullrequestreview-5948919460
[#90-process]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634935
[#91-timings]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607696012
[#99-timings]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608746456
[#99-shards]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608771631
[#109-bound]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4610027050
[#102-parameters]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4608976426
[#102-alias]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019138
[#102-nested]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019144
[#102-reset]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019149
[#102-outer]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659195
[#102-arity]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659202
[#102-arguments]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659207
[#102-mock-key]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609902952
[#102-copy-key]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609902960
