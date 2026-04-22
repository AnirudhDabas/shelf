# Contributing

Thanks for taking a look. Bug reports, feature requests, and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/AnirudhDabas/shelf
cd shelf
pnpm install
pnpm build
```

Requires Node ≥ 20 and pnpm ≥ 9.

## Local checks

Before opening a pull request, the following must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same gate on Node 20 and Node 22.

## Trying changes end-to-end

The fastest way to exercise the loop without burning credentials is the offline dry-run:

```bash
node packages/core/dist/cli.js run --dry-run --no-shopify --max-iterations 5
```

This stubs every external AI call and reads catalog data from `fixtures/demo-store/`. Use it to validate hypothesis generation, applier, reverter, scorer aggregation, and logging in one pass.

For a UI smoke test:

```bash
node packages/core/dist/cli.js dashboard
```

## Pull request guidelines

- Keep PRs focused — one logical change per PR. Refactor PRs and feature PRs are separate.
- Add tests for new behavior in `packages/core/tests/`. Tests are run with [Vitest](https://vitest.dev).
- Don't introduce new runtime dependencies without a comment explaining why.
- Don't add features behind flags that aren't reachable from the CLI; prefer code that is fully on or removed.

## Reporting issues

Use the GitHub issue templates. For bugs, include:
- The exact command you ran.
- The relevant excerpt from `shelf.jsonl` (or the full file if it's small).
- The version: `node --version`, `npx shelf-ai --version`, OS.

## Security

If you find a security issue (e.g. a way `shelf` could leak credentials, write to the wrong store, or escape its working directory), please email anirudhdabas@gmail.com instead of filing a public issue.
