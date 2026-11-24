---
"bun-typescript-template": minor
---

Removed the nine forced-off overrides from generated repositories' .fallowrc.json so unused-class-members, unused-enum-members, duplicate-exports, misconfigured-dependency-overrides, unused-dev-dependencies, unused-optional-dependencies, duplicate-export-aliases, unlisted-binaries, and unused-dependency-overrides run at Fallow's default severities.

Action: Nothing to do by hand: .fallowrc.json is a shared file for Template upgrade (key-level JSON merge), so the nine keys are removed automatically unless the repository customised them.
