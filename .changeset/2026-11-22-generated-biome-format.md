---
"bun-typescript-template": patch
---

Disabled Biome Markdown formatting in generated biome.json and restored the shipped pointer skills' front matter so formatting leaves Markdown files byte-identical.

Action: Run Template upgrade to merge the markdown.formatter.enabled setting into biome.json (a shared file merged with the repository's own edits) and update the pointer skills.
