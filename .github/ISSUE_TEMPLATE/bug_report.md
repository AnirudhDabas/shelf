---
name: Bug report
about: Something is broken or behaves unexpectedly
title: ''
labels: bug
assignees: ''
---

## What happened?

A clear description of the bug.

## What did you expect to happen?

## How to reproduce

Exact command:

```bash
npx shelf-ai run ...
```

Relevant `.env` shape (do **not** include actual keys — just which providers are configured):

```
SHOPIFY_STORE_DOMAIN=example.myshopify.com
ANTHROPIC_API_KEY=sk-ant-...
# ...
```

## Logs

Paste the relevant excerpt from `shelf.jsonl`, or the terminal output around the failure. Truncate aggressively — usually the iteration that broke is enough.

## Environment

- shelf version (`npx shelf-ai --version`):
- Node version (`node --version`):
- pnpm version (only if working from source):
- OS:
