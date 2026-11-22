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

## Shipped paths

`bun run check:change-notes --base origin/main` requires a new change note when a branch changes any of:

- `generated-repository/**` (including `generated-repository/bun.lock`)
- the lint rule files in `config/` copied by `KERNEL_RECIPE`
- `tests/support/test-folder.ts`
- `kernel-pin.json`
- `src/recipe.ts`, `src/bootstrap.ts`, `src/bootstrap-arguments.ts`, `src/token-substitution.ts`, `src/kernel-pin.ts`
