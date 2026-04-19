# SHELF — Complete Build Prompt for Claude Code

## COMMIT PROTOCOL — READ THIS FIRST

After completing each of the following steps, STOP and tell me:
"Ready to commit: [what was just built]. Run: git add . && git commit -m '[suggested message]'"

Do not proceed to the next step until I say "continue".

Commit checkpoints:
1. After root workspace setup (package.json, turbo.json, tsconfig, pnpm-workspace)
2. After packages/core/src/config.ts and all types
3. After packages/core/src/shopify/ (all Shopify API code)
4. After packages/core/src/scorer/ (all scoring providers)
5. After packages/core/src/hypothesis/ (generator, applier, reverter)
6. After packages/core/src/queries/ and packages/core/src/confidence/ and packages/core/src/checks/
7. After packages/core/src/logger/ and packages/core/src/events/
8. After packages/core/src/loop.ts
9. After packages/core/src/cli.ts and packages/core/src/index.ts
10. After all tests in packages/core/tests/
11. After apps/dashboard/ (entire dashboard)
12. After fixtures/ and scripts/
13. After all documentation (README, BUILDING, architecture, scoring, trace)
14. After CI workflow and final cleanup

Each commit message should be specific and lowercase, like:
"feat: add shopify admin graphql client with product queries and mutations"
NOT:
"added files" or "update"

---

You are building `shelf`, an open-source CLI tool and dashboard that autonomously optimizes a Shopify store's product catalog until AI shopping agents (ChatGPT, Perplexity, Claude) actually surface those products in response to natural-language shopper queries.

This is modeled directly on Karpathy's autoresearch pattern and Shopify's pi-autoresearch extension (https://github.com/davebcn87/pi-autoresearch). Read and internalize the pi-autoresearch repo structure before writing any code. We are porting that exact loop shape — propose, measure, keep/revert — to a new optimization target: AI discoverability of Shopify products.

## IMPORTANT CONTEXT — READ THIS FIRST

This project exists at the intersection of two things Shopify CEO Tobi Lütke cares about RIGHT NOW (April 2026):

1. **Autoresearch loops** — On March 12, 2026, Tobi personally ran pi-autoresearch against Shopify's Liquid template engine and got 53% faster parse+render from 120+ autonomous experiments. He tweeted the PR. The pi-autoresearch repo has 3,600+ stars. A Shopify Engineering blog post about it was published April 15, 2026.

2. **Agentic Storefronts** — On March 24, 2026, Shopify activated Agentic Storefronts by default for all eligible merchants, connecting 5.6M stores to ChatGPT, Perplexity, Microsoft Copilot, and Google AI Mode. But most stores are invisible — Metricus audit data shows the average store scores 42/100 for AI readiness.

`shelf` closes this gap. It is not a chatbot, not a wrapper, not an audit tool. It is an autonomous optimization loop where the judges are the actual AI shopping agents.

The creator is a University of Waterloo CS student applying for Shopify's Fall 2026 Toronto engineering internship. The code must be production-grade, well-documented, and genuinely impressive to a Shopify engineering lead reviewing it.

---

## PROJECT STRUCTURE

Create EXACTLY this file tree. Do not deviate.

```
shelf/
├── .github/
│   ├── FUNDING.yml
│   └── workflows/
│       └── ci.yml                    # GitHub Actions: lint, typecheck, test
├── apps/
│   └── dashboard/                    # Next.js 15 dashboard app
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx              # Main dashboard page
│       │   ├── globals.css
│       │   └── api/
│       │       └── events/
│       │           └── route.ts      # SSE endpoint for live experiment stream
│       ├── components/
│       │   ├── score-chart.tsx       # Line chart of AI Shelf Score over time
│       │   ├── experiment-table.tsx  # Table of recent experiments with diffs
│       │   ├── status-bar.tsx        # Current score, iteration count, elapsed
│       │   ├── diff-viewer.tsx       # Inline diff of what changed
│       │   └── confidence-badge.tsx  # Shows MAD confidence level
│       ├── lib/
│       │   └── use-event-stream.ts   # React hook for SSE consumption
│       ├── next.config.ts
│       ├── tailwind.config.ts
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   └── core/                         # The engine — CLI + loop + scoring
│       ├── src/
│       │   ├── index.ts              # Main entry point
│       │   ├── cli.ts                # CLI argument parsing and commands
│       │   ├── config.ts             # Configuration loader (BYOK keys, store domain)
│       │   ├── loop.ts               # The autoresearch loop controller
│       │   ├── scorer/
│       │   │   ├── index.ts          # Unified scoring interface
│       │   │   ├── perplexity.ts     # Perplexity sonar scoring provider
│       │   │   ├── openai.ts         # OpenAI Responses API w/ web_search scoring
│       │   │   ├── anthropic.ts      # Anthropic Claude w/ web search scoring
│       │   │   └── types.ts          # Shared scoring types
│       │   ├── shopify/
│       │   │   ├── admin.ts          # Shopify Admin GraphQL client (read/write products)
│       │   │   ├── storefront.ts     # Storefront MCP client (read-only, agent's view)
│       │   │   ├── mutations.ts      # GraphQL mutation strings
│       │   │   ├── queries.ts        # GraphQL query strings
│       │   │   └── types.ts          # Shopify product/metafield types
│       │   ├── hypothesis/
│       │   │   ├── generator.ts      # Claude-powered hypothesis generator
│       │   │   ├── applier.ts        # Applies a hypothesis via Admin API
│       │   │   ├── reverter.ts       # Reverts a failed hypothesis
│       │   │   └── types.ts          # Hypothesis types
│       │   ├── queries/
│       │   │   └── generator.ts      # Generates realistic shopper queries per category
│       │   ├── confidence/
│       │   │   └── mad.ts            # MAD-based confidence scoring
│       │   ├── checks/
│       │   │   └── backpressure.ts   # Quality checks: title length, keyword density, reading level
│       │   ├── logger/
│       │   │   ├── jsonl.ts          # Appends to shelf.jsonl
│       │   │   └── session.ts        # Manages shelf.md session state
│       │   ├── events/
│       │   │   └── emitter.ts        # EventEmitter for dashboard SSE bridge
│       │   └── utils/
│       │       ├── retry.ts          # Exponential backoff for API calls
│       │       ├── cache.ts          # Response cache for --dry-run and deduplication
│       │       └── cost.ts           # Token/cost estimator and budget enforcer
│       ├── tests/
│       │   ├── loop.test.ts
│       │   ├── scorer.test.ts
│       │   ├── hypothesis.test.ts
│       │   ├── confidence.test.ts
│       │   ├── backpressure.test.ts
│       │   └── fixtures/
│       │       ├── sample-products.json
│       │       ├── sample-queries.json
│       │       └── sample-experiments.jsonl
│       ├── tsconfig.json
│       └── package.json
├── docs/
│   ├── architecture.md               # System architecture diagram and explanation
│   ├── scoring.md                     # How AI Shelf Score is calculated
│   ├── hypothesis-types.md            # Catalog of hypothesis types with examples
│   └── optimization-trace-example.md  # A real trace from a demo run, annotated
├── fixtures/
│   └── demo-store/
│       ├── products.json              # 40 seed products for demo store
│       └── queries.json               # 50 pre-generated shopper queries
├── scripts/
│   ├── seed-store.ts                  # Seeds a Shopify dev store with demo products
│   └── export-trace.ts               # Exports shelf.jsonl as readable markdown
├── .env.example                       # Template for all required env vars
├── .gitignore
├── .eslintrc.cjs
├── .prettierrc
├── LICENSE                            # MIT
├── README.md                          # The main README (detailed below)
├── BUILDING.md                        # How this was built (AI-assisted workflow)
├── CONTRIBUTING.md
├── package.json                       # Root workspace package.json
├── pnpm-workspace.yaml
└── turbo.json                         # Turborepo config for monorepo
```

---

## TECH STACK — USE EXACTLY THESE

| Concern | Package / Tool | Version |
|---|---|---|
| Runtime | Node.js | ≥20 |
| Language | TypeScript | 5.x, strict mode |
| Package manager | pnpm | 9.x |
| Monorepo | Turborepo | latest |
| CLI framework | `commander` | latest |
| Shopify Admin API | `@shopify/admin-api-client` | latest |
| Shopify Storefront API | `@shopify/storefront-api-client` | latest |
| Perplexity API | OpenAI SDK pointed at `https://api.perplexity.ai` | `openai` npm package |
| OpenAI Responses API | `openai` | latest (must support `client.responses.create`) |
| Anthropic API | `@anthropic-ai/sdk` | latest |
| Dashboard framework | Next.js | 15.x (App Router) |
| Dashboard styling | Tailwind CSS 4.x + shadcn/ui | latest |
| Dashboard charts | Recharts | latest |
| Testing | Vitest | latest |
| Linting | ESLint + Prettier | latest |
| Env vars | `dotenv` | latest |
| Streaming | Node EventEmitter → SSE via Next.js Route Handler | native |

---

## DETAILED FILE SPECIFICATIONS

### `.env.example`

```env
# Shopify
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxx
SHOPIFY_STOREFRONT_ACCESS_TOKEN=xxxxx

# Scoring Providers (BYOK — bring your own keys)
PERPLEXITY_API_KEY=pplx-xxxxx
OPENAI_API_KEY=sk-xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Optional
SHELF_BUDGET_LIMIT_USD=25
SHELF_MAX_ITERATIONS=100
SHELF_QUERIES_PER_MEASUREMENT=3
SHELF_LOG_FILE=shelf.jsonl
SHELF_SESSION_FILE=shelf.md
```

---

### `packages/core/src/config.ts`

Load config from `.env` file AND CLI flags. CLI flags override env vars. Validate that at least one scoring provider key is present. Validate that Shopify credentials are present. Export a typed `ShelfConfig` interface:

```typescript
export interface ShelfConfig {
  store: {
    domain: string;
    adminAccessToken: string;
    storefrontAccessToken: string;
  };
  providers: {
    perplexity?: { apiKey: string };
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  loop: {
    maxIterations: number;
    budgetLimitUsd: number;
    queriesPerMeasurement: number; // how many times to repeat each query for noise reduction
  };
  paths: {
    logFile: string;   // default: shelf.jsonl
    sessionFile: string; // default: shelf.md
  };
  dryRun: boolean;
}
```

---

### `packages/core/src/cli.ts`

Use `commander` to expose these commands:

```
shelf init                    # Interactive setup — prompts for store domain + API keys, writes .env
shelf run [--dry-run] [--max-iterations N] [--budget N]
                              # Starts the autoresearch loop
shelf score                   # Runs scoring once without modifying anything, prints current AI Shelf Score
shelf dashboard               # Starts the Next.js dashboard on localhost:3847
shelf reset                   # Deletes shelf.jsonl and shelf.md, fresh start
shelf export                  # Exports shelf.jsonl as readable markdown
shelf queries generate        # Generates shopper queries for the store's product categories
```

Make the CLI output beautiful. Use `chalk` for colors, `ora` for spinners, `cli-table3` for tables. The CLI is a first impression — make it look like a professional tool, not a script.

---

### `packages/core/src/scorer/` — THE SCORING ENGINE

This is the most critical module. The AI Shelf Score is the single metric the loop optimizes.

#### How scoring works:

1. Load the store's products via Shopify Storefront API (this is how AI agents see the store)
2. Load pre-generated shopper queries from `queries.json` (or generate fresh ones)
3. For each query, ask each enabled scoring provider: "Would you recommend any products from [store domain] for this query?"
4. Parse the response: did any product from the store appear? If yes, at what position?
5. Score = (number of queries where at least one product appeared) / (total queries) × 100

#### `packages/core/src/scorer/types.ts`

```typescript
export interface ScoringQuery {
  id: string;
  text: string;           // "waterproof packable rain jacket under $200"
  category: string;       // "outerwear"
  intent: 'purchase' | 'compare' | 'research';
}

export interface ScoringResult {
  queryId: string;
  provider: 'perplexity' | 'openai' | 'anthropic';
  appeared: boolean;
  position?: number;      // 1-indexed position in recommendations, if found
  rawSnippet?: string;    // The relevant snippet from the AI response
  latencyMs: number;
  tokensUsed?: number;
  timestamp: string;
}

export interface AggregatedScore {
  overall: number;        // 0-100
  byProvider: Record<string, number>;
  byQuery: Record<string, boolean>;
  queriesTotal: number;
  queriesMatched: number;
  measuredAt: string;
}

export interface ScoringProvider {
  name: string;
  score(query: ScoringQuery, storeDomain: string): Promise<ScoringResult>;
}
```

#### `packages/core/src/scorer/perplexity.ts`

Use the OpenAI SDK pointed at Perplexity's endpoint:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: config.providers.perplexity.apiKey,
  baseURL: 'https://api.perplexity.ai',
});

// Use model: 'sonar' (cheapest, sufficient for product discovery checks)
// The prompt should be a natural shopping query
// Parse the response text + citations to check if store domain appears
// Citations are in the response — check if any citation URL contains the store domain
```

The key insight: Perplexity returns citations with URLs. Check if ANY citation URL contains the store's domain or any product URL from the store. This is the most reliable signal.

#### `packages/core/src/scorer/openai.ts`

Use the OpenAI Responses API with web_search:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: config.providers.openai.apiKey });

const response = await client.responses.create({
  model: 'gpt-4o-mini',  // cheapest model that supports web_search
  tools: [{ type: 'web_search' }],
  input: `I'm shopping for: ${query.text}. What specific products would you recommend? Include links to where I can buy them.`,
});

// Parse response.output to find:
// 1. web_search_call items (contains sources/URLs)
// 2. Text output mentioning the store domain or product names
// Check sources array for store domain matches
```

#### `packages/core/src/scorer/anthropic.ts`

Use Anthropic's API with web search tool (the tool we're using right now in this conversation):

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: config.providers.anthropic.apiKey });

// Note: Claude's web search is available via the API with tools
// Use model: 'claude-sonnet-4-6' (good balance of cost and quality)
// Parse response for citations and domain mentions
```

IMPORTANT: For ALL providers, implement:
- Exponential backoff retry (3 attempts, 1s/2s/4s delays)
- Response caching keyed on (query_text + provider + store_domain + date)
- Cost tracking per call
- Timeout of 30 seconds per call

#### `packages/core/src/scorer/index.ts`

The unified scorer:

```typescript
export async function measureScore(
  queries: ScoringQuery[],
  storeDomain: string,
  providers: ScoringProvider[],
  repetitions: number = 3, // repeat each query N times for noise reduction
): Promise<AggregatedScore> {
  // For each query:
  //   For each provider:
  //     Run the query `repetitions` times
  //     Use majority vote: appeared = true if appeared in >50% of runs
  // 
  // Overall score = queries where appeared=true in ANY provider / total queries × 100
  // Also compute per-provider scores
}
```

---

### `packages/core/src/hypothesis/` — THE CHANGE PROPOSER

#### `packages/core/src/hypothesis/types.ts`

```typescript
export type HypothesisType =
  | 'title_rewrite'           // Rewrite product title to lead with product type
  | 'description_restructure' // Rewrite description for AI readability
  | 'metafield_add'           // Add a missing metafield (material, use_case, etc.)
  | 'metafield_update'        // Update an existing metafield value
  | 'seo_title'               // Update SEO title
  | 'seo_description'         // Update SEO meta description
  | 'tags_update'             // Update product tags
  | 'variant_title';          // Clarify variant option names

export interface Hypothesis {
  id: string;                  // ulid or nanoid
  type: HypothesisType;
  productId: string;           // Shopify GID
  productTitle: string;        // For logging clarity
  description: string;         // Human-readable: "Rewrite title from 'The Explorer' to 'Packable Rain Jacket — Men's Ultralight Waterproof Shell'"
  field: string;               // Which field is being changed
  before: string;              // Current value
  after: string;               // Proposed value
  reasoning: string;           // Why this change should improve discoverability
  confidence: 'low' | 'medium' | 'high';
  estimatedImpact: string;     // "Should match queries like: 'packable rain jacket', 'ultralight waterproof jacket'"
}
```

#### `packages/core/src/hypothesis/generator.ts`

This uses Claude Sonnet to propose ONE atomic change per iteration.

```typescript
// System prompt for the hypothesis generator:
const SYSTEM_PROMPT = `You are an AI catalog optimization specialist. Your job is to propose ONE small, specific, atomic change to a Shopify product that will make it more likely to be surfaced by AI shopping agents (ChatGPT, Perplexity, Google AI Mode).

RULES:
1. ONE change per proposal. Never batch multiple changes.
2. Changes must be factually accurate — never fabricate product attributes.
3. Prefer adding structured data (metafields, clear attributes) over rewriting prose.
4. Product titles should lead with the product type, not the brand name.
   BAD: "The Explorer Pro" → GOOD: "Packable Rain Jacket — Men's Ultralight Waterproof Shell | BrandName"
5. Descriptions should be structured for machine parsing:
   - Lead with what the product IS (category, type)
   - Include material, dimensions, weight, use cases
   - Use natural language a shopper would search for
   - Avoid marketing fluff ("revolutionary", "game-changing")
6. Never keyword-stuff. Write naturally.
7. Metafields should use Shopify's standard taxonomy where possible.
8. Consider what a shopper would ACTUALLY type into ChatGPT when looking for this product.

OUTPUT FORMAT:
Return a JSON object matching the Hypothesis type exactly. No markdown, no explanation outside the JSON.`;

// User prompt includes:
// - The product's current state (from Storefront API view)
// - Queries that FAILED to surface this product
// - Previous hypotheses that were already tried (to avoid repeats)
// - The store's category context
```

#### `packages/core/src/hypothesis/applier.ts`

Applies a hypothesis to the store via Shopify Admin API:

```typescript
// Based on hypothesis.type:
// - title_rewrite → productUpdate mutation with title field
// - description_restructure → productUpdate mutation with descriptionHtml field
// - metafield_add/update → metafieldsSet mutation
// - seo_title → productUpdate with seo.title
// - seo_description → productUpdate with seo.description
// - tags_update → productUpdate with tags

// ALWAYS save the 'before' state so we can revert
// Return the mutation result for logging
```

#### `packages/core/src/hypothesis/reverter.ts`

Reverts a hypothesis by applying the 'before' state:

```typescript
// Takes a Hypothesis object
// Applies the 'before' value to the same field
// Logs the revert to shelf.jsonl
```

---

### `packages/core/src/loop.ts` — THE AUTORESEARCH LOOP

This is the heart of the project. Model it DIRECTLY on pi-autoresearch's loop shape.

```typescript
export async function runLoop(config: ShelfConfig): Promise<void> {
  // 1. INITIALIZE
  //    - Load or create session (shelf.md)
  //    - Load experiment log (shelf.jsonl) if resuming
  //    - Load products from Shopify Storefront API
  //    - Load or generate shopper queries
  //    - Measure baseline score
  //    - Emit 'session:start' event

  // 2. LOOP (until maxIterations or budget exhausted or user ctrl+c)
  for (let i = 0; i < config.loop.maxIterations; i++) {
    // a. SELECT a product to optimize
    //    Strategy: round-robin through products that have the lowest
    //    per-product score (queries targeting this product that fail)

    // b. GENERATE a hypothesis
    //    Call the hypothesis generator with:
    //    - The product's current Storefront MCP view
    //    - Failed queries for this product
    //    - List of already-tried hypotheses (to avoid repeats)

    // c. RUN BACKPRESSURE CHECKS on the proposed change
    //    - Title length: must be ≤ 255 chars, ideally 40-80
    //    - Keyword density: reject if any word appears >3x in title+description
    //    - Reading level: Flesch-Kincaid grade level should be 6-10
    //    - If checks fail: log as 'checks_failed', skip to next iteration

    // d. APPLY the hypothesis via Admin API
    //    - Save the 'before' snapshot first
    //    - Apply the change
    //    - Wait 5 seconds for Shopify's CDN/index to propagate
    //    - Emit 'hypothesis:applied' event

    // e. RE-MEASURE the score
    //    - Run the full scoring suite
    //    - Compare to previous score

    // f. DECIDE: keep or revert
    //    - If score improved AND confidence > noise floor → KEEP
    //      Log as 'kept', update baseline, emit 'experiment:kept'
    //    - If score unchanged or decreased → REVERT
    //      Apply the 'before' state, log as 'reverted', emit 'experiment:reverted'
    //    - If score improved but within noise floor → KEEP but flag as 'uncertain'
    //      (MAD confidence scoring determines this)

    // g. LOG the experiment to shelf.jsonl
    //    One line per experiment, structured as ExperimentLog (see below)

    // h. UPDATE session state in shelf.md
    //    - Current score, iteration count, best score, products optimized

    // i. CHECK budget
    //    - If estimated cost > budget limit → stop loop, warn user

    // j. EMIT events for dashboard SSE
  }

  // 3. FINALIZE
  //    - Print summary: starting score → ending score, iterations, time elapsed
  //    - List top 5 most impactful kept changes
  //    - Save final session state
}
```

#### Experiment log format (`shelf.jsonl`):

Each line is one JSON object:

```typescript
export interface ExperimentLog {
  id: string;
  iteration: number;
  timestamp: string;
  hypothesis: Hypothesis;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
  verdict: 'kept' | 'reverted' | 'checks_failed' | 'error';
  confidence: number;       // 0-1, from MAD scoring
  confidenceLevel: 'high' | 'medium' | 'low' | 'noise';
  durationMs: number;
  costEstimateUsd: number;
  error?: string;
}
```

---

### `packages/core/src/confidence/mad.ts`

Port pi-autoresearch's confidence scoring:

```typescript
// After 3+ experiments, compute confidence for the current gain:
//
// 1. Collect all score deltas from the current session
// 2. Compute MAD (Median Absolute Deviation) as a robust noise estimator
// 3. confidence = |current_delta| / (MAD * 1.4826)
//    (1.4826 is the consistency constant for normal distribution)
// 4. Map to levels:
//    > 3.0 → 'high'
//    > 1.5 → 'medium'
//    > 0.5 → 'low'
//    ≤ 0.5 → 'noise' (within noise floor, might not be a real gain)
```

---

### `packages/core/src/checks/backpressure.ts`

Quality guardrails that prevent the optimizer from gaming the score:

```typescript
export interface BackpressureResult {
  passed: boolean;
  failures: string[];
}

export function checkHypothesis(hypothesis: Hypothesis, product: Product): BackpressureResult {
  const failures: string[] = [];

  // 1. Title length: 10-255 chars, warn if >100
  // 2. Keyword density: no single non-stop-word should appear >3x in title+description combined
  // 3. Reading level: Flesch-Kincaid grade 5-12 (reject if <5 or >12)
  // 4. No fabricated attributes: if hypothesis adds a metafield, the value must appear
  //    somewhere in the original product data or be a reasonable inference
  // 5. Description length: must be 50-5000 chars
  // 6. No ALL CAPS words (except acronyms ≤4 chars)
  // 7. Title must not start with "Buy" or "Shop" or "Best" (spammy patterns)

  return { passed: failures.length === 0, failures };
}
```

---

### `packages/core/src/queries/generator.ts`

Generate realistic shopper queries using Claude:

```typescript
// Input: list of products from the store
// Output: 50 diverse shopper queries that a real person might type into ChatGPT

// The prompt should generate queries across different intents:
// - Direct purchase: "waterproof hiking jacket under $200"
// - Comparison: "best packable rain jacket vs poncho for travel"  
// - Research: "what to look for in a rain jacket for cycling"
// - Specific attribute: "lightweight waterproof jacket that fits in a daypack"
// - Gift: "rain jacket gift for someone who hikes"

// Each query should be tagged with:
// - intent: purchase | compare | research
// - target product IDs (which products SHOULD match this query)
// - category
```

---

### `packages/core/src/shopify/mutations.ts`

```typescript
export const PRODUCT_UPDATE = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
        descriptionHtml
        seo {
          title
          description
        }
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const METAFIELDS_SET = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
        value
        type
      }
      userErrors {
        field
        message
      }
    }
  }
`;
```

---

### `packages/core/src/shopify/queries.ts`

```typescript
export const GET_PRODUCTS = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          descriptionHtml
          productType
          vendor
          tags
          seo {
            title
            description
          }
          metafields(first: 20) {
            edges {
              node {
                id
                key
                namespace
                value
                type
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                availableForSale
                sku
              }
            }
          }
          images(first: 5) {
            edges {
              node {
                url
                altText
              }
            }
          }
          onlineStoreUrl
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
```

---

### DASHBOARD (`apps/dashboard/`)

The dashboard is a single-page Next.js app that shows the autoresearch loop running in real time. It connects to the CLI via Server-Sent Events.

#### Design direction:

- **Aesthetic: utilitarian, data-dense, dark theme.** Think Bloomberg terminal meets GitHub's dark mode. NOT a marketing page. NOT gradient-heavy AI slop.
- **Font: JetBrains Mono for data, Inter for labels** (yes I know Inter is common — it's correct here for a data dashboard, not a landing page)
- **Colors:**
  - Background: `#0a0a0a`
  - Surface: `#141414`
  - Border: `#1e1e1e`
  - Text primary: `#e5e5e5`
  - Text secondary: `#737373`
  - Accent green (kept): `#22c55e`
  - Accent red (reverted): `#ef4444`
  - Accent yellow (uncertain): `#eab308`
  - Accent blue (running): `#3b82f6`
- **Layout: single column, top to bottom:**
  1. Status bar: current score (big number), delta from start, iteration count, elapsed time, estimated cost
  2. Score chart: Recharts line chart, x=iteration, y=score. Green dots for kept, red dots for reverted. Light grid lines.
  3. Experiment table: last 20 experiments. Columns: #, product, hypothesis type, description (truncated), before→after score, delta, verdict (green/red badge), confidence badge. Click to expand and see the full diff.

#### `apps/dashboard/app/page.tsx`

The main page. Server component that renders the client components. No data fetching on the server — everything comes from SSE.

#### `apps/dashboard/app/api/events/route.ts`

SSE endpoint. The CLI writes events to a local file or named pipe; the dashboard reads them and streams to the browser. For simplicity in v1, use file polling on `shelf.jsonl` — watch the file for new lines and stream them as SSE events.

#### `apps/dashboard/components/score-chart.tsx`

```
'use client';
// Recharts LineChart
// X axis: iteration number
// Y axis: AI Shelf Score (0-100)
// Data points colored by verdict: green=kept, red=reverted, yellow=uncertain
// Smooth line connecting only the 'kept' scores (the actual progression)
// Tooltip showing hypothesis description on hover
// Responsive, fills container width
```

#### `apps/dashboard/components/experiment-table.tsx`

```
'use client';
// shadcn/ui Table component
// Columns: iteration, product title, hypothesis type, description, score delta, verdict badge, confidence badge
// Expandable rows: click to see full diff (before/after values)
// Most recent experiment at top
// Auto-scrolls to newest entry
// Alternating row background for readability
```

#### `apps/dashboard/components/status-bar.tsx`

```
'use client';
// Big number: current AI Shelf Score (large, monospace font)
// Subtitle: "+{delta} from baseline {starting_score}"
// Stats row: iteration count | elapsed time | estimated cost | products touched
// Animated: score number should smoothly transition when it changes
// Pulse animation on the score when a new experiment is kept
```

---

### `README.md`

This is CRITICAL. It is the single most important file for virality. Write it as if it will be read by Tobi Lütke, Andrej Karpathy, and 10,000 developers on Hacker News.

Structure:

```markdown
# shelf

> autoresearch for storefronts

Your Shopify store is enrolled in ChatGPT, Perplexity, and Google AI Mode.
It isn't showing up.

`shelf` is an autonomous agent that tunes your product catalog until it does.

[screenshot of dashboard showing score going from ~8 to ~84]

## How it works

[numbered list, 7 steps, matching the loop description above]
[emphasize: the judges are the ACTUAL AI agents, not heuristics]

## Quick start

\`\`\`bash
npx shelf init
npx shelf run
\`\`\`

## The loop

[diagram or description of: propose → apply → measure → keep/revert → loop]
[credit pi-autoresearch and Karpathy's autoresearch explicitly]

## AI Shelf Score

[brief explanation of how scoring works]
[which providers are supported]
[how noise reduction works]

## Dashboard

\`\`\`bash
npx shelf dashboard
\`\`\`

[screenshot of dashboard]

## Configuration

[table of all .env vars with descriptions]

## Dry run

\`\`\`bash
npx shelf run --dry-run
\`\`\`

[explanation: uses cached responses, no API costs, no store modifications]

## Hypothesis types

[table of all 8 hypothesis types with one-line examples]

## Backpressure checks

[list of quality guardrails]

## Optimization trace

[link to docs/optimization-trace-example.md]
[or inline a shortened version showing 5 experiments with verdicts]

## Built with

- Shopify Admin GraphQL API + Storefront API
- Perplexity Sonar API
- OpenAI Responses API with web_search
- Anthropic Claude API
- Inspired by [autoresearch](link) by @karpathy and [pi-autoresearch](link) by @davebcn87

## Why

Shopify activated Agentic Storefronts for all merchants on March 24, 2026.
5.6M stores connected to 880M monthly AI users.
Most are invisible because product data isn't structured for machine consumption.

This closes the loop.

## License

MIT
```

The README must be concise, not bloated. No badges wall. No "table of contents" for a README this short. No emojis in headers. One screenshot placeholder (the dashboard). The tone is confident and dry — let the tool speak for itself.

---

### `BUILDING.md`

```markdown
# How shelf was built

This project was built in 7 days using AI-assisted development.

## Tools used

- **Claude Code** — primary coding agent for scaffolding, implementation, and iteration
- **Shopify Dev MCP Server** — for validated Shopify API code generation
- **Cursor** — for focused file editing and debugging

## Workflow

Day 1-2: Scoring engine and Shopify API integration
Day 3-4: Hypothesis generator and autoresearch loop
Day 5: Dashboard
Day 6: Polish, documentation, demo data
Day 7: Demo video and launch

## Philosophy

Shopify's engineering culture expects reflexive AI usage. This project was built
that way — not to hide the AI contribution, but to demonstrate fluency with the
tools Shopify's own engineers use daily.

Every architectural decision, scoring design choice, and quality guardrail was
a human judgment call. The implementation was accelerated by AI.
```

---

### `docs/architecture.md`

Include a clear system diagram (ASCII art or Mermaid syntax) showing:

```
┌─────────────────────────────────────────────────┐
│                  SHELF LOOP                      │
│                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │  Query    │───▶│ Scoring  │───▶│ Decide   │   │
│  │ Generator │    │ Engine   │    │ Keep/    │   │
│  │ (Claude)  │    │          │    │ Revert   │   │
│  └──────────┘    │ Perplexity│    └────┬─────┘   │
│       ▲          │ OpenAI    │         │         │
│       │          │ Anthropic │         │         │
│       │          └──────────┘         │         │
│       │               ▲               │         │
│       │               │               ▼         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │Hypothesis│───▶│ Shopify  │◀───│ Backpress│   │
│  │Generator │    │Admin API │    │ Checks   │   │
│  │ (Claude) │    │(apply/   │    │          │   │
│  └──────────┘    │ revert)  │    └──────────┘   │
│                  └──────────┘                    │
│                       │                          │
│                       ▼                          │
│              ┌──────────────┐                    │
│              │  shelf.jsonl │                    │
│              │  (exp. log)  │                    │
│              └──────┬───────┘                    │
│                     │ SSE                        │
│                     ▼                            │
│              ┌──────────────┐                    │
│              │  Dashboard   │                    │
│              │  (Next.js)   │                    │
│              └──────────────┘                    │
└─────────────────────────────────────────────────┘
```

---

### `docs/scoring.md`

Detailed explanation of AI Shelf Score methodology:
- How queries are generated
- How each provider is called
- How appearance detection works (domain matching in citations/sources)
- Noise reduction via majority vote across repetitions
- Per-provider scoring vs. aggregate scoring
- Why we use real API calls instead of heuristics
- Known limitations (stochasticity, API changes, cost)

---

### `docs/optimization-trace-example.md`

A realistic annotated trace. Write 10-15 experiment entries showing:
- 3-4 kept changes (score going up)
- 2-3 reverted changes (score staying same or dropping)
- 1 checks_failed (keyword stuffing caught)
- 1 error (API timeout)

Each entry should include the full hypothesis, before/after values, score delta, and a brief annotation explaining WHY it worked or didn't.

This file is critical for credibility. Technical reviewers will read this to judge whether the tool actually works.

---

### Seed data: `fixtures/demo-store/products.json`

Generate 40 realistic products in the "outdoor rain gear" category. Each product should have:
- A branded title that is intentionally BAD for AI discovery (e.g., "The Explorer Pro", "StormChaser X3")
- A marketing-heavy description (fluff, no specs)
- Empty metafields
- Realistic prices ($50-$350)
- 2-3 variants (sizes)
- One product image URL (use placeholder)
- A vendor name

These products are intentionally poorly optimized so the demo starts at a low score and has room to improve.

### Seed data: `fixtures/demo-store/queries.json`

Generate 50 realistic shopper queries across multiple intents. Examples:
- "lightweight packable rain jacket for backpacking"
- "best waterproof jacket under $150 for cycling"
- "rain poncho vs rain jacket for festivals"
- "women's breathable rain shell with hood"
- "gore-tex alternative rain jacket affordable"

---

### Tests

Write meaningful tests, not boilerplate. Focus on:

1. `loop.test.ts` — Test the keep/revert logic with mocked scorer. Verify that:
   - A positive delta leads to 'kept' verdict
   - A negative delta leads to 'reverted' verdict with before state restored
   - Budget exhaustion stops the loop
   - Max iterations stops the loop

2. `scorer.test.ts` — Test scoring aggregation with mock provider responses. Verify that:
   - A query appearing in 2/3 runs counts as 'appeared' (majority vote)
   - A query appearing in 1/3 runs counts as 'not appeared'
   - Score calculation is correct: matched/total × 100

3. `hypothesis.test.ts` — Test that generated hypotheses pass type validation

4. `confidence.test.ts` — Test MAD calculation with known inputs:
   - Deltas [0.1, -0.2, 0.3, 0.1, -0.1] → verify MAD and confidence level
   - All zeros → confidence should be 'noise' for any delta

5. `backpressure.test.ts` — Test each quality check:
   - Title >255 chars → fail
   - Keyword appearing 4x → fail
   - Flesch-Kincaid grade 15 → fail
   - Normal title → pass

---

### CI: `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

---

## CODE QUALITY REQUIREMENTS

1. **TypeScript strict mode everywhere.** No `any` types. No `// @ts-ignore`. Use proper generics and type narrowing.

2. **Error handling:** Every API call must be wrapped in try/catch with meaningful error messages. Never let a single API failure crash the loop — log it, mark the experiment as 'error', and continue.

3. **No console.log in library code.** Use the EventEmitter for all output. The CLI subscribes to events and renders them. The dashboard subscribes to the same events via SSE. This is a clean separation.

4. **Comments:** Write comments that explain WHY, not WHAT. No `// increment counter` style comments. DO explain non-obvious design decisions, especially around scoring methodology and confidence calculation.

5. **Imports:** Use ESM imports (`import`/`export`), not CommonJS. Target ESNext.

6. **Code formatting:** 2-space indent, single quotes, trailing commas, no semicolons. Consistent with Shopify's own OSS style (check pi-autoresearch repo).

7. **File length:** No file should exceed 300 lines. If it does, split it. The loop.ts is the only file that might approach this — that's fine.

8. **Naming:** camelCase for variables/functions, PascalCase for types/interfaces, SCREAMING_SNAKE for true constants only. File names in kebab-case.

---

## CRITICAL REMINDERS

- This is NOT a chatbot. It does NOT have a chat interface. It is a CLI tool with a dashboard.
- The scoring uses REAL API calls to REAL AI agents. This is the entire point. Do not mock them out or replace them with heuristics in the main code path. Mocks are for tests only.
- The loop is modeled on pi-autoresearch. If you haven't read that repo, read it now. The file layout (jsonl log, md session state), the keep/revert mechanism, and the confidence scoring should all be recognizable to someone who knows pi-autoresearch.
- The dashboard is SECONDARY to the CLI. The tool must work perfectly without the dashboard. The dashboard is a viewer, not a controller.
- BYOK is non-negotiable. No API keys are hardcoded. No API keys are sent to any server. Everything runs locally.
- The README is a marketing document. It must be tight, confident, and demonstrate craft. No filler.

---

## EXECUTION ORDER

Build in this order to avoid dependency issues:

1. Root workspace setup (package.json, pnpm-workspace.yaml, turbo.json, tsconfig)
2. `packages/core/src/config.ts` and types
3. `packages/core/src/shopify/` — all Shopify API code
4. `packages/core/src/scorer/` — all scoring providers
5. `packages/core/src/hypothesis/` — generator, applier, reverter
6. `packages/core/src/queries/generator.ts`
7. `packages/core/src/confidence/mad.ts`
8. `packages/core/src/checks/backpressure.ts`
9. `packages/core/src/logger/` — jsonl and session
10. `packages/core/src/events/emitter.ts`
11. `packages/core/src/loop.ts` — the main loop
12. `packages/core/src/cli.ts` — CLI commands
13. `packages/core/src/index.ts` — entry point
14. Tests
15. `apps/dashboard/` — entire dashboard app
16. `fixtures/` — seed data
17. `scripts/` — seed-store.ts, export-trace.ts
18. Documentation (README.md, BUILDING.md, architecture.md, scoring.md, etc.)
19. CI workflow
20. Final review: lint, typecheck, test, verify everything compiles

After each major module (steps 2-6), run `tsc --noEmit` to verify types. After step 14, run `vitest` to verify tests pass. After step 15, run `next build` to verify dashboard compiles.

---

## FINAL CHECK

Before declaring the project complete, verify:

- [ ] `pnpm install` succeeds
- [ ] `pnpm lint` passes with zero warnings
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (all tests)
- [ ] `pnpm --filter dashboard build` succeeds
- [ ] `shelf --help` prints clean usage info
- [ ] `shelf init` runs the interactive setup flow
- [ ] `shelf run --dry-run` completes without errors using cached data
- [ ] `shelf score` prints a score without modifying anything
- [ ] `shelf dashboard` starts on localhost:3847
- [ ] README.md reads well, has no TODOs or placeholders (except screenshot)
- [ ] BUILDING.md is present and honest
- [ ] LICENSE is MIT
- [ ] .env.example has all required vars documented
- [ ] No hardcoded API keys anywhere in the codebase
- [ ] No `console.log` in library code (only in CLI rendering)
- [ ] Zero TypeScript `any` types

Now build the entire project. Start with the workspace setup and work through the execution order above. Do not skip steps. Do not leave TODOs — implement everything fully.
## UPDATES FROM TECHNICAL REVIEW (add to implementation)

1. Verdict states: use kept | reverted | kept_uncertain | 
   checks_failed | apply_failed | measure_failed

2. Stopping conditions (add to loop.ts):
   - No kept changes in last 10 iterations → stop
   - Score improvement < 0.5 points per iteration averaged over last 15 → stop  
   - All products above 80/100 → stop

3. Hypothesis object must include:
   - queryFailurePatterns: string[] (which failing queries this targets)
   - predictedEffect: string
   - riskLevel: 'low' | 'medium' | 'high'
   - promptVersion: string

4. Anti-thrashing: product not eligible for re-selection 
   for 3 iterations after being modified

5. SSE event types: session:start | hypothesis:proposed | 
   checks:failed | hypothesis:applied | measurement:complete | 
   experiment:kept | experiment:reverted | budget:warning | session:end
   — each with: productId, iteration, scoreDelta, confidence, 
     costUsd, elapsedMs

6. Factual consistency check in backpressure: 
   new metafield values must be present in or 
   inferable from original product data