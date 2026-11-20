# Lint Rule Proof

A lint rule earns its place when it refuses each shape its matcher can meet.
This guide moved here, word for word, from the test proof guide when that
guide reached the file size limit.

## Lint rules

- Prove a lint rule on each shape its matcher can meet, not only on the
  cases of the rule it ports: a callback with more or fewer parameters, a
  function nested inside the one it judges, a binding written more than
  once, a type argument that repeats its alias, an alias whose parameter
  shares a name with an outer one, a spread into call arguments, and a
  member key written as a template literal. A port inherits its source's
  gaps: oxc's `no_accumulating_spread` at `oxlint_v1.93.0`, or the source
  `config/anti-slop-rules.mjs` pins, shares each witnessed one.
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

[#102-parameters]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4608976426
[#102-alias]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019138
[#102-nested]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019144
[#102-reset]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609019149
[#102-outer]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659195
[#102-arity]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659202
[#102-arguments]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609659207
[#102-mock-key]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609902952
[#102-copy-key]: https://github.com/nathanvale/bun-typescript-template/pull/102#discussion_r4609902960
