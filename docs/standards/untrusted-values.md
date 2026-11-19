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
  twice).
- Validate the same object you pass on. A spread drops non-enumerable
  properties, and a hidden `toJSON` rewrites serialised data. Witnessed:
  [r4580070938], [r4580077749].
- Return frozen copies of tables and stations, so a caller keeps the
  validator's reference data intact. Witnessed: [r4580070877],
  [r4580070890].
- Freeze what a boundary parser returns, so a caller cannot replace a field
  after the parser checked it. Witnessed: [r4624877543] (`parseKernelPin`
  returned a mutable pin, so a caller could swap its validated commit for a
  short one).
- Compare identifiers and keys by code unit. `localeCompare` treats distinct
  keys as equal and follows the runtime collation. Witnessed: [r4580077765],
  [57c8c8b].

## Bounds

- Check `NaN` explicitly. `Math.max` and `Math.min` pass it through, and a
  wait compared against it never ends. Witnessed: [6021454].
- Arm a delay above 2,147,483,647 ms in steps. A runtime timer fires a longer
  delay after 1 ms. Witnessed: [f00dc2a].
- Bound every wait, including the settle after a handler returns. Witnessed:
  [b54d325], [1d03d99], [8de7e09] (a test's ledger poll had no bound).
- State a complexity bound for each traversal and append. Witnessed:
  [r4580077771] (a shared subgraph cost about 2^35 visits), [d972ded]
  (quadratic append).

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
