# Change notes

Add one JSON file per pull request that changes what the template ships:

`change-notes/YYYY-MM-DD-<kebab-slug>.json`

```json
{
  "kind": "added",
  "breaking": false,
  "affects": ["bootstrap", "generated-repository"],
  "summary": "Past-tense summary of what changed for generated repositories.",
  "action": null
}
```

## Fields

- `kind`: `"added"`, `"changed"`, `"fixed"`, `"removed"`, or `"none"` (for an internal change on a shipped path with no effect on generated repositories).
- `breaking`: `true` or `false`. Must be `false` when `kind` is `"none"`.
- `affects`: affected template surfaces, chosen from `"bootstrap"`, `"generated-repository"`, `"kernel-pin"`, `"lint-rules"`, and `"test-support"`. May be `[]` only when `kind` is `"none"`.
- `summary`: non-empty past-tense sentence for the reader.
- `action`: required non-empty step when `breaking` is `true`, otherwise a non-empty string or `null`.

Unknown fields are refused.

## When to set `breaking`

Set `"breaking": true` (and write a concrete, non-empty `action`) when a change:

- changes Bootstrap's CLI flags, accepted arguments, or `--json` / `.cli-design-template.json` output in a way existing callers must update;
- removes or renames a generated script in a generated repository's `package.json`; or
- adds a lint or type rule that can fail an unmodified generated repository.

Non-breaking additions, fixes, or template-internal changes (`kind: "none"`) keep `"breaking": false`.

## Template versions

`bun run template-version --lead "<one-sentence summary>"` reads committed change notes added since the last `vX.Y.Z` git tag (starting from `0.1.0` when none exists), computes the next template version, and writes `template-versions/vX.Y.Z.md` (or prints it with `--print`). It never deletes change notes and never creates git tags or commits.

## Shipped paths

`bun run check:change-notes --base origin/main` requires a new change note when a branch changes any of:

- `generated-repository/**` (including `generated-repository/bun.lock`)
- the lint rule files in `config/` copied by `KERNEL_RECIPE`
- `tests/support/test-folder.ts`
- `kernel-pin.json`
- `src/recipe.ts`, `src/bootstrap.ts`, `src/bootstrap-arguments.ts`, `src/token-substitution.ts`, `src/kernel-pin.ts`
