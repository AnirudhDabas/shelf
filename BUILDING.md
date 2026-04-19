# How shelf was built

This project was built in seven days using AI-assisted development.

## Tools used

- **Claude Code** — primary coding agent for scaffolding, implementation, and iteration.
- **Shopify Dev MCP server** — validated Shopify Admin + Storefront GraphQL at code-gen time, so mutations compile against the real schema instead of hallucinated shapes.
- **Cursor** — focused file editing and quick debugging passes.

## Workflow

- Day 1-2 — monorepo scaffold, typed config loader, scoring engine against the three providers.
- Day 3-4 — hypothesis generator, backpressure checks, the autoresearch loop, confidence/MAD math.
- Day 5 — Next.js dashboard with SSE log tailing, score chart, experiment table.
- Day 6 — polish, test suite, demo fixture catalog and query set, seed + export scripts.
- Day 7 — README, docs, trace example, demo video, launch.

Each of the fourteen checkpoints landed as a single commit with a descriptive message — the git history is the build log.

## Philosophy

Shopify's engineering culture expects reflexive AI usage. This project was built that way — not to hide the AI contribution, but to demonstrate fluency with the tools Shopify's own engineers use daily.

Every architectural decision, scoring design choice, and quality guardrail was a human judgement call. The implementation was accelerated by AI.

## Architectural inheritance

Two load-bearing pieces are deliberately modeled on [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch):

1. **`shelf.jsonl`** — append-only experiment log, one JSON object per line. Same shape family: `id`, `iteration`, `timestamp`, `verdict`, `scoreBefore`, `scoreAfter`, `scoreDelta`, `confidence`.
2. **`shelf.md`** — living session document with four sections: *Objective / What's been tried / Dead ends / Key wins*. A fresh agent can resume from `shelf.md` alone without parsing the jsonl.

Both trace back to [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — the original pattern. Shelf applies it to a new optimization target: AI shopper discoverability of a Shopify catalog.

Everything else — the scoring engine that calls real AI agents, the typed hypothesis generator, the backpressure checks, the Shopify integration, the Next.js dashboard — is original.
