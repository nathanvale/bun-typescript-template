# Untrusted Values

Declarations, argv, environment, files, and host-supplied objects are
untrusted until the boundary parser returns a frozen copy. Code past the
boundary trusts the types.

## Object model

- Check own data with `Object.hasOwn` where the lint does not reach: an
  index read such as `fields[key]` with a key from a payload, and a key
  check in a test. Both also find `Object.prototype` members such as
  `toString`. Witnessed: [r4580070968], [r4580070979], [r4580077776],
  [5cbff3a].
- Read each value once into the copy you validate, then check and use that
  same copy. A second read of an accessor, or a read after an `await`, can
  differ. Witnessed: [75b4bc0], [r4580077763], [3088c03], [r4606886521],
  [r4606943307] (the `no-in-operator` repair read a member expression
  twice), [2a68a20] (the kernel trial and the kernel row read their
  request's kernel seam and lockfile bytes again after a wait).
- Validate the same object you pass on. A spread drops non-enumerable
  properties, and a hidden `toJSON` rewrites serialised data. Witnessed:
  [r4580070938], [r4580077749].
- Return frozen copies of tables and stations, so a caller keeps the
  validator's reference data intact. Witnessed: [r4580070877],
  [r4580070890].
- Freeze what a boundary parser returns, so a caller cannot replace a field
  after the parser checked it. Witnessed: [r4624877543] (`parseKernelPin`
  returned a mutable pin, so a caller could swap its validated commit for a
  short one), [a639dc0] (a passed kernel trial's record could be spread with
  its commit replaced, or its lockfile bytes changed, before the pin move
  wrote them).
- Compare identifiers and keys by code unit. `localeCompare` treats distinct
  keys as equal and follows the runtime collation. Witnessed: [r4580077765],
  [57c8c8b].

## Bounds

- Check `NaN` explicitly. `Math.max` and `Math.min` pass it through, and a
  wait compared against it never ends. Witnessed: [6021454].
- Arm a delay above 2,147,483,647 ms in steps. A runtime timer fires a longer
  delay after 1 ms. Witnessed: [f00dc2a].
- Bound every wait, including the settle after a handler returns. Witnessed:
  [b54d325], [1d03d99], [8de7e09] (a test's ledger poll had no bound),
  [r4625304827] (a synchronous read of a named pipe waits for a writer and
  takes no bound, so open only a plain file), [r4625592689] (a check of the
  path and then an open of the path left a gap in which the entry could
  become a named pipe, so open with `O_NONBLOCK` first, then check the open
  file with `fstatSync`).
- State a complexity bound for each traversal and append. Witnessed:
  [r4580077771] (a shared subgraph cost about 2^35 visits), [d972ded]
  (quadratic append).

## Bytes

- Decode untrusted bytes with a strict decoder, such as
  `new TextDecoder("utf-8", { fatal: true })`, and refuse the bytes it
  refuses. A lossy decoder writes U+FFFD for each byte that is not text, so
  its result cannot tell that byte from text that holds U+FFFD. Witnessed:
  [r4625243717], [r4625304816] (a kernel declaration with a byte that is not
  UTF-8 was decoded and read), [r4625243680], [r4625304810] (a file name
  that holds U+FFFD itself was refused as not UTF-8), [r4625592501] (paths
  that were not UTF-8 were matched against a source folder through their lossy
  decoding, so one outside a source folder whose name holds U+FFFD was refused;
  compare bytes with bytes before decoding), [#113-copilot] (folder entries
  were read as decoded text, so a name that is not UTF-8 read the same as a
  file name holding U+FFFD; read each name as bytes, then decode it),
  [a639dc0] (the pin move report keyed kernel file names by their lossy
  decoding, so two names that were not UTF-8 read as one).
- Decode a name with `ignoreBOM: true`, so that every character of it is
  kept. A strict decoder still drops a byte-order mark at the start of its
  input. Witnessed: [r4625804683] (a path that starts with U+FEFF lost its
  first character, so its kernel declaration was reported missing).

## Separators

- Let a path or file name hold any byte but NUL: a tab, a line feed and a
  colon included. End a raw name with NUL, and split a tool's record at its
  first separator only. Where a tool takes paths in a list that a path can
  split, confirm what the tool found, in each form it can find. Witnessed:
  [r4625304844] (a
  `git ls-tree -z` record split at every tab cut a file name that held one),
  [r4625304853] (a raw path ended with a line feed could not hold one),
  [r4625304781] (a colon in the path above a folder defeated
  `GIT_CEILING_DIRECTORIES`, a colon-separated list, so a folder inside a
  repository was read as that repository), [r4625593933] (the confirmation
  read a working tree's prefix, which git prints empty in a bare repository,
  so a folder inside a bare repository still passed), [r4625956755] (git
  prints a path as stored, line feeds included, and rev-parse's output was
  split on line feeds, so a folder named with one was misread; ask for each
  printed path in a call of its own, or framed by NUL).

## Plain paths

- Refuse every spelling of a path but the plain one where it is read, so
  each consumer of the value matches the same files and none leaves the
  folder. Witnessed: [r4608771621] (a test area folder written as `./tests`,
  `tests/` or with `..` ran in the area runner, and the test placement check
  matched no file under it), [r4625243640] (the record's plain-path
  refusal split a path on `/` alone, so `..\outside` passed, and a backslash
  separates folders on Windows), [#113-copilot] (a path with a NUL byte
  passed the plain-path rule and threw at the first file system call).

## Links

- Inspect the entry at a path itself, with `lstatSync`, before you read
  through it or call it absent. `existsSync`, `statSync` and `readdirSync`
  follow a symbolic link and answer for what it points to. Open a file with
  `O_NOFOLLOW`, so the open itself fails on a link. Witnessed:
  [r4625243750] (a source folder replaced by a link to a folder with the same
  files gave `intact`), [r4625304836] (a record file that was a link to
  nothing read as absent, so the check reported no record), [r4625772395]
  (the reader checked a file with `statSync` and opened what a link pointed
  to, so a checking script that was a link to a file with the recorded bytes
  outside the folder gave `intact`), [#113-copilot] (a source file was
  inspected with `lstatSync` and then read with `readFileSync`, which
  follows a link; read through the same open that was checked).

## Failed reads

- Read a required input as present or refused, never as empty, so a file or
  folder that cannot be read does not pass for one with nothing in it.
  Witnessed: [r4609956011] (a missing patch file read as an empty patch, so
  replay reported that it held no hunk and `--changed-since` skipped its
  fault), [r4625304821] (a folder in a source folder that could not be listed
  read as empty, so the file comparison passed without reading it).
- Call an entry absent only when its lookup fails because nothing has that
  name: `ENOENT`, or `ENOTDIR` for a name on the way. Report every other
  lookup failure. Witnessed: [r4625594357], [r4625772325] (every failed
  `lstatSync` read as absent, so a record file in a folder that may not be
  searched was reported absent).

[r4580070968]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070968
[r4580070979]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070979
[r4580077776]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077776
[r4580077763]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077763
[r4580070938]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070938
[r4580077749]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077749
[r4580070877]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070877
[r4580070890]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580070890
[r4580077765]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077765
[r4580077771]: https://github.com/nathanvale/bun-typescript-template/pull/6#discussion_r4580077771
[r4606886521]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606886521
[r4606943307]: https://github.com/nathanvale/bun-typescript-template/pull/80#discussion_r4606943307
[r4608771621]: https://github.com/nathanvale/bun-typescript-template/pull/99#discussion_r4608771621
[r4609956011]: https://github.com/nathanvale/bun-typescript-template/pull/109#discussion_r4609956011
[r4625243640]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625243640
[r4625243680]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625243680
[r4625243717]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625243717
[r4625243750]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625243750
[r4625304781]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304781
[r4625304810]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304810
[r4625304816]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304816
[r4625304821]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304821
[r4625304827]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304827
[r4625304836]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304836
[r4625304844]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304844
[r4625304853]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625304853
[r4625592501]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625592501
[r4625592689]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625592689
[r4625593933]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625593933
[r4625594357]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625594357
[r4625772325]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625772325
[r4625772395]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625772395
[r4625804683]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625804683
[r4625956755]: https://github.com/nathanvale/bun-typescript-template/pull/113#discussion_r4625956755
[#113-copilot]: https://github.com/nathanvale/bun-typescript-template/pull/113#pullrequestreview-5971793022
[r4624877543]: https://github.com/nathanvale/bun-typescript-template/pull/112#discussion_r4624877543
[75b4bc0]: https://github.com/nathanvale/bun-typescript-template/commit/75b4bc045d038970858b95b136f9f176fd3fc4cc
[57c8c8b]: https://github.com/nathanvale/bun-typescript-template/commit/57c8c8b881c66e967688d05a3a70e1ef487c5553
[5cbff3a]: https://github.com/nathanvale/bun-typescript-template/commit/5cbff3a87746defffd2672320038c48fbd1ddbc6
[6021454]: https://github.com/nathanvale/bun-typescript-template/commit/6021454e9d4a5426724b08a17fabec084eca3eac
[f00dc2a]: https://github.com/nathanvale/bun-typescript-template/commit/f00dc2af3e7ea13f694b4adcfe0404ad6e4d8e9b
[b54d325]: https://github.com/nathanvale/bun-typescript-template/commit/b54d3256aa2b5302eeea41f33649093a82c5410d
[1d03d99]: https://github.com/nathanvale/bun-typescript-template/commit/1d03d99aee3455127c218056db2added1410912e
[d972ded]: https://github.com/nathanvale/bun-typescript-template/commit/d972ded023d0558d9cf47e4e7e2ee5eb5f37b029
[3088c03]: https://github.com/nathanvale/bun-typescript-template/commit/3088c032c90df81d9d0e5f93700c0769daac5cff
[8de7e09]: https://github.com/nathanvale/bun-typescript-template/commit/8de7e09c322e1b40304bad9f9332cb976048102e
[a639dc0]: https://github.com/nathanvale/bun-typescript-template/commit/a639dc0cb92d859552ca1eec75ee1a66d3cc0ced
[2a68a20]: https://github.com/nathanvale/bun-typescript-template/commit/2a68a201a1a56a15a41447450070484b96db5b5d
