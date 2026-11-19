# One Owner

The shared rule "One owner per sealed vocabulary and per test fake" applies.
This repository also drifted on constants and helpers, so the rule covers them
here.

- Import a cause code, route token, or built-in identity from its owner
  module. Witnessed: [56aee86], [e7c771c].
- Run a format or shape rule through its one helper. A second copy of a
  constructor's shape rule gave admission a different refusal text.
  Witnessed: [892a700], [f2270b3], [#113-path] (the kernel reader returned a
  file name with a backslash, which the stamp record's path rule refuses,
  until the reader ran that rule's helper too).
- Import shared test fakes and fixtures from
  `tests/kernel/kernel-repair/handlers.ts` and `shapes.ts`. Witnessed:
  [810345d], [cf72627].
- Give admission commands that launch Git the same isolated environment as
  direct fixture calls. Witnessed: [#91-git].
- Isolate a test's git from the caller's configuration with `gitEnv` from
  `tests/support/git-fixture.ts`, and set it on `process.env` around an
  in-process subject that runs git. The standards fixture used to inherit
  runtime configuration. Witnessed: [#85-env], [#92-git]. The shared environment
  disables the global and system files and clears runtime configuration (`GIT_CONFIG_COUNT`, its `KEY_n` and
  `VALUE_n` pairs, and `GIT_CONFIG_PARAMETERS`). A user's `diff.orderFile`
  changed what the staged readers listed. Witnessed: [f929eb7], [7a62deb],
  [#84-git] (a local copy left runtime configuration in the replay fixture),
  [#90-git] (the bootstrap fixture inherited a signing requirement),
  [#101-git] (the naming fixture inherited a setting that disabled its hook),
  [#113-lazy] (a git control inherited `GIT_NO_LAZY_FETCH`, which hid the
  behaviour it was there to show).
- Start every child and git call a hook can reach from
  `withoutRepositoryLocation` in `scripts/process-runner.ts`, so none reads
  the hook's repository through `GIT_DIR` or the variables beside it.
  Witnessed: [def3ec4] (the runner, and a bare `Bun.spawn` beside it, handed
  a hook's `GIT_DIR` to each child), [#109-git] (the fault tool's
  synchronous git reads kept it too).

[#91-git]: https://github.com/nathanvale/bun-typescript-template/pull/91#discussion_r4607744335
[56aee86]: https://github.com/nathanvale/bun-typescript-template/commit/56aee86bf059fb2629819fa2b6a1664d776629d5
[e7c771c]: https://github.com/nathanvale/bun-typescript-template/commit/e7c771c89f63ffeeb609b03e4f670e9d43ea53fb
[892a700]: https://github.com/nathanvale/bun-typescript-template/commit/892a7005ab00d6ffb24b8d760e9d4a2dc9e0b081
[f2270b3]: https://github.com/nathanvale/bun-typescript-template/commit/f2270b3916114f0d693544fb1dfb3ed190c92288
[810345d]: https://github.com/nathanvale/bun-typescript-template/commit/810345d01ab28f5b3108ea4b5420fb05743ec6b4
[cf72627]: https://github.com/nathanvale/bun-typescript-template/commit/cf726279ccbe1fa540745be879343c379390fdd1
[#92-git]: https://github.com/nathanvale/bun-typescript-template/pull/92#discussion_r4607819556
[#85-env]: https://github.com/nathanvale/bun-typescript-template/pull/85#discussion_r4607322049
[f929eb7]: https://github.com/nathanvale/bun-typescript-template/commit/f929eb7fe9fbba24f5990269c27cddf302deb9de
[7a62deb]: https://github.com/nathanvale/bun-typescript-template/commit/7a62deb4233ecad8b18fb1206b03f70e0d1262f3
[#84-git]: https://github.com/nathanvale/bun-typescript-template/pull/84#discussion_r4607244506
[#90-git]: https://github.com/nathanvale/bun-typescript-template/pull/90#discussion_r4607634940
[#101-git]: https://github.com/nathanvale/bun-typescript-template/pull/101#discussion_r4609075462
[def3ec4]: https://github.com/nathanvale/bun-typescript-template/commit/def3ec4a0b0bbe9047f9296dc0bbf6424c44a807
[#109-git]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609955976
[#113-path]: https://github.com/nathanvale/bun-typescript-template/pull/113#pullrequestreview-5971206975
[#113-lazy]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4626555126
