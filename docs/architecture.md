# Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         SHELF LOOP                           │
│                                                              │
│   ┌──────────┐      ┌──────────┐      ┌──────────┐           │
│   │  Query   │─────▶│ Scoring  │─────▶│  Decide  │           │
│   │Generator │      │  Engine  │      │  Keep /  │           │
│   │ (Claude) │      │          │      │  Revert  │           │
│   └──────────┘      │Perplexity│      └────┬─────┘           │
│        ▲            │ OpenAI   │           │                 │
│        │            │Anthropic │           │                 │
│        │            └──────────┘           │                 │
│        │                 ▲                 ▼                 │
│   ┌──────────┐      ┌──────────┐      ┌──────────┐           │
│   │Hypothesis│─────▶│ Shopify  │◀─────│Backpress.│           │
│   │Generator │      │Admin API │      │  Checks  │           │
│   │ (Claude) │      │(apply/   │      │          │           │
│   └──────────┘      │ revert)  │      └──────────┘           │
│                     └──────────┘                             │
│                          │                                   │
│                          ▼                                   │
│                   ┌──────────────┐                           │
│                   │ shelf.jsonl  │                           │
│                   │ (append-only)│                           │
│                   └──────┬───────┘                           │
│                          │ SSE                               │
│                          ▼                                   │
│                   ┌──────────────┐                           │
│                   │  Dashboard   │                           │
│                   │  (Next.js)   │                           │
│                   └──────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

## Packages

- **`packages/core`** — the loop itself, typed config, scoring engine, hypothesis pipeline, backpressure checks, confidence math, JSONL + session loggers, event emitter, Shopify clients, and the `shelf` CLI.
- **`apps/dashboard`** — Next.js 15 App Router app. Reads `shelf.jsonl` via an SSE endpoint that tails the file and renders the score chart + recent experiments.
- **`scripts/`** — one-shot TS scripts: `seed-store.ts` populates a Shopify dev store from `fixtures/demo-store/products.json`; `export-trace.ts` renders `shelf.jsonl` into readable markdown.
- **`fixtures/demo-store/`** — 40 deliberately-bad-for-AI rain-gear products + 50 shopper queries used by the demo.

## Data flow

1. `shelf run` loads `.env` through the typed config loader, wires up the three provider scorers, the Shopify admin + storefront clients, the JSONL logger, the session logger, and the event emitter.
2. Query generator produces ~50 queries grounded in the real catalog (purchase / compare / research intents).
3. Scoring engine fans out across all configured providers per query. Appearance = store domain appears in web-search citations. Results cache to disk keyed by `{query, store}`.
4. Hypothesis generator picks a product whose query-failure pattern matches its current state, proposes one typed change, and hands it to the backpressure check.
5. On pass, the applier writes the change through Shopify's Admin GraphQL. On fail, `checks_failed` is logged and the loop continues.
6. The engine re-scores. If the delta is positive the change is *kept*; if negative, the reverter restores the original value and the verdict is *reverted*. MAD-based confidence catches the borderline cases as *kept_uncertain*.
7. The experiment is appended to `shelf.jsonl`; the four-section `shelf.md` is updated.
8. The dashboard picks up the new line via SSE and re-renders.

## Files that matter

- [`packages/core/src/loop.ts`](../packages/core/src/loop.ts) — the outer loop with the six verdict states.
- [`packages/core/src/scorer/index.ts`](../packages/core/src/scorer/index.ts) — provider fan-out + majority-vote aggregation.
- [`packages/core/src/hypothesis/`](../packages/core/src/hypothesis/) — generator, applier, reverter, validation.
- [`packages/core/src/checks/backpressure.ts`](../packages/core/src/checks/backpressure.ts) — quality guardrails.
- [`packages/core/src/confidence/mad.ts`](../packages/core/src/confidence/mad.ts) — median absolute deviation for noise-vs-signal.
- [`packages/core/src/logger/jsonl.ts`](../packages/core/src/logger/jsonl.ts) — the experiment log shape.
- [`packages/core/src/logger/session.ts`](../packages/core/src/logger/session.ts) — the four-section shelf.md writer.
- [`apps/dashboard/app/api/events/route.ts`](../apps/dashboard/app/api/events/route.ts) — the SSE file tail.
