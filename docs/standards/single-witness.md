# Single Witness

A lesson seen once waits here as one bullet: the lesson as an imperative,
then `Witnessed:` and its citation. When a second witness arrives, it moves
to a row in the [rule table](../../CODING_STANDARDS.md#rule-table) and leaves
this file.

- Run a control through the same function as the check it controls, so it
  shows that check finding its target. A control that finds the target
  another way stays green when the check finds nothing. Witnessed:
  [d29b755] (the control for the kernel folder scan checked the kernel
  reader's text for a string, not the scan's result).
- Give a generated repository's lint settings none of the allowances meant
  for code it does not own. Witnessed: [#116-addons] (the settings passed
  every add-on's allowances, so code under `src/addons/programs/` could call
  `Bun.spawn`).
- Make a guard against an empty gate count what the gate would run.
  Witnessed: [ac11ed9] (a test area whose tests sit only in subfolders was
  counted as empty).
- Build a test's environment without any variable the test then asserts on,
  so a value set in the parent process cannot change the result. Witnessed:
  [cd2498b] (an inherited `MARKER` changed the first output of `execute`).
- Make a lint rule that reads a template literal fall back to its raw text,
  so a head with an invalid escape is still checked. Witnessed: [fc4fa62]
  (`String.raw` with `\u` left the cooked value undefined, and
  `no-host-path-literal` checked an empty string).
- Give each binding a lint repair introduces a name that no binding or
  reference in the reported scope uses, so the repair compiles where it is
  pasted. Witnessed: [r4606943319] (`key in read()` beside a `key`
  parameter gave `const key = key;`).
- Build a lint repair from the source it replaces, so the code it leaves
  unchanged still finds every name it reads. Witnessed: [r4607149514] (the
  `for...in` repair named `const key`, and the loop body read `field`).
- Split the union that a type parameter's constraint resolves to, so a lint
  judges a generic target as it judges the plain union. Witnessed:
  [r4607149524] (`"a" in value` with `T extends { a: number } | { b: string }`
  was refused, and the same check on the union passed).
- Assert any step a near-zero limit can catch, not the first one, since which
  step loses that race depends on the host. Witnessed: [27c2676] (a 1 ms
  replay limit named `git apply` instead of `git worktree add` on a hosted
  runner).
- Freeze a child that outran its bound before inspecting it, and stop it
  whatever the inspection does. Witnessed: [3f6443b] (a synchronous `ps` let a
  hung child run 10 s past its bound, and a `ps` that could not start skipped
  the kill).
- Build an expected command from the path the code runs, not a no-space
  pattern. Witnessed: [bfc3a67] (`\S+` would have refused a Bun installed
  under a path with a space).
- Trigger a compiler check when its configuration changes. Witnessed:
  [r4608935157] (a staged `tsconfig.base.json` could change compilation
  while the hook only looked for staged source edits).
- Locate a change by the text it changes, not by unchanged text beside it,
  so an edit to that other text cannot lose the change. Witnessed:
  [r4609956051] (a hunk with two changed regions was anchored on the
  unchanged lines between them, so editing those lines made its fault
  STALE).
- Read staged Git blobs in one batch by object ID. Witnessed:
  [r4609890969] (the file-size gate started a Git process for each staged
  file).
- Give each dependency group a gate claims to read its own case, so the
  claim cannot outlive the coverage. Witnessed: [r4623512643] (the generated
  toolchain check read `peerDependencies`, and no case declared a peer).
- Treat a declaration the installer does not install as absent, not as a
  stale record. Witnessed: [r4623566979] (an optional peer has no `bun.lock`
  package record, and the check would have called the lock stale).
- Hold a tool to a limit with a setting that every release you support
  reads, or refuse the release that does not read it. Witnessed:
  [r4625304791] (an older git does not read `GIT_NO_LAZY_FETCH`, so a
  partial clone could still fetch there).
- Compare an identity you derive from a tool's listing with the tool's own
  before you trust it. Witnessed: [r4625304802] (`git ls-tree -r` lists no
  empty folder, so a tree identity built from the listed files was not
  git's).
- Allow nothing with an empty allowlist, not with a name you expect to match
  nothing, since the tool looks that name up too. Witnessed: [r4625603158]
  (`GIT_ALLOW_PROTOCOL=none` let git run a `git-remote-none` helper found on
  `PATH`).
- Check a name another tool reads by that tool's rules, not only by the
  characters it allows, so the parser admits no name the tool refuses.
  Witnessed: [r4625152049] (the kernel pin's branch pattern `/^[\w./-]+$/`
  admitted `main..next`, which git refuses as a branch name).
- Check that a declared path is the kind it is declared as, a regular file
  or a folder, not only that it exists. Witnessed: [#114-types] (Bootstrap
  took a folder named `config/template-rules.mjs` as a template file, copied
  it whole, and reported success for a malformed repository).
- Report a folder that holds nothing as an entry itself, since a walk that
  lists only what is inside a folder shows no sign of an empty one.
  Witnessed: [r4626801130] (an extra empty folder in a stamp root produced
  no entry, so the stamp check gave `intact`).

[ac11ed9]: https://github.com/nathanvale/bun-typescript-template/commit/ac11ed98b7d538e8a304cac053aaefcaaf6b2cb3
[cd2498b]: https://github.com/nathanvale/bun-typescript-template/commit/cd2498b7189a2d45d1906b9c870e8d13da6cd2dd
[fc4fa62]: https://github.com/nathanvale/bun-typescript-template/commit/fc4fa628535ecc6729048cb6fbb759f153edd040
[r4606943319]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943319
[r4607149514]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149514
[r4607149524]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4607149524
[27c2676]: https://github.com/nathanvale/bun-typescript-template/commit/27c26764ecac5849752fb39df5384539e60e1456
[3f6443b]: https://github.com/nathanvale/bun-typescript-template/commit/3f6443be7abaf2e0881d48a03e0d3b4072b6247f
[bfc3a67]: https://github.com/nathanvale/bun-typescript-template/commit/bfc3a67b8aea06d0c630c2b9ef1ecd9f32a3266b
[r4608935157]: https://github.com/nathanvale/bun-typescript-template/pull/101#discussion_r4608935157
[r4609956051]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956051
[r4609890969]: https://github.com/nathanvale/bun-typescript-template/pull/108#discussion_r4609890969
[r4623512643]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623512643
[r4623566979]: https://github.com/nathanvale/bun-typescript-template/pull/111#discussion_r4623566979
[r4625304791]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304791
[r4625304802]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304802
[r4625603158]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625603158
[r4625152049]: https://github.com/nathanvale/bun-typescript-template/pull/112#discussion_r4625152049
[#114-types]: https://github.com/nathanvale/bun-typescript-template/pull/114#pullrequestreview-5971659214
[r4626801130]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4626801130
[d29b755]: https://github.com/nathanvale/bun-typescript-template/commit/d29b7552547144c165d0402a54c3e22fb8e7487e
[#116-addons]: https://github.com/nathanvale/bun-typescript-template/pull/116#discussion_r4638567030
