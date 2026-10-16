# Baseline (Milestone 0.2)

- Node v24.18.0, npm 11.16.0, git 2.55, gitleaks 8.30.1, TypeScript 7.0.2, vitest 5.0.5.
- better-sqlite3 installed with a prebuilt binary; smoke test passes.
- tsconfig: TypeScript 7 removed `moduleResolution=node10`, so it is omitted (module commonjs).
- `npm audit --omit=dev`: 0 vulnerabilities.
- Existing `marketplace-mvp/run-tests.js` (TC1..TC9): NOT run here. It needs the original team wallet keys (`.env`, not in the repo) and a funded buyer wallet. Re-run after fresh wallets exist (0.3) if wanted.
- `marketplace-mvp/` and `foundation-test/` left untouched.
