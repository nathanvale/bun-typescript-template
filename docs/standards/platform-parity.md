# Platform Parity

The Hosted check workflow runs on Linux on every pull request; the macOS
nightly covers the Mac route once it reaches `main`. A case that cannot run on
a host is **unproved** there, and its title says so.

- Register a platform-bound case through `caseTest` or `supportingTest` in
  `tests/kernel/state/harness.ts`. Off its platform it runs the fail-closed
  control under a title containing `UNPROVED on <platform>`.
- Pin unproved counts as the shared "Observed evidence crosses a real
  boundary" rule asks. `R1.platform-outcomes-pinned` in
  `tests/kernel/diagnostics/cases.test.ts` is the local pattern.
- Derive a system path from the host, and check each precondition the test
  relies on with a test-owned read. Witnessed: [8e4ec47], [ff5fffe].
- Pass bulk data by file or stdin. Linux limits one argument to 131,072
  bytes. Witnessed: [2c70f30].
- Size a process exit bound for hosted Linux. It reported an aborted CLI gone
  after 24 to 27 s, past a 20 s default. Witnessed: [d1436c0].
- Prove a file's removal by its name and first record. ext4 gives a freed
  inode number to the next file created. Witnessed: [10545ea].

[8e4ec47]: https://github.com/nathanvale/bun-typescript-template/commit/8e4ec47c9603f50548edb7d71087bd7f8d840819
[ff5fffe]: https://github.com/nathanvale/bun-typescript-template/commit/ff5fffe0718d64921d899aba35fca14b58d6f69a
[2c70f30]: https://github.com/nathanvale/bun-typescript-template/commit/2c70f30517421a2a17fd9d33556166991e060762
[d1436c0]: https://github.com/nathanvale/bun-typescript-template/commit/d1436c0c13b2906e5eee1c08dfcea41c611f0bef
[10545ea]: https://github.com/nathanvale/bun-typescript-template/commit/10545eaaf548a3f1781718dab63603886fcd0ac5
