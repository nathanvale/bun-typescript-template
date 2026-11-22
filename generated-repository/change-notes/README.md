# Change notes

Add one JSON file per pull request that changes what this repository ships:

`change-notes/YYYY-MM-DD-<kebab-slug>.json`

```json
{
  "kind": "added",
  "breaking": false,
  "affects": ["cli"],
  "summary": "Past-tense summary of what changed for readers.",
  "action": null
}
```

## Fields

- `kind`: `"added"`, `"changed"`, `"fixed"`, `"removed"`, or `"none"` (for an internal change with no consumer effect).
- `breaking`: `true` or `false`. Must be `false` when `kind` is `"none"`.
- `affects`: lowercase surface names (`[]` allowed only when `kind` is `"none"`).
- `summary`: non-empty past-tense sentence describing the change.
- `action`: required non-empty step when `breaking` is `true`, otherwise a non-empty string or `null`.
