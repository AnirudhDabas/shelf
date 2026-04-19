# Optimization trace (example)

A worked example: twelve experiments against the demo rain-gear catalog, starting from an AI Shelf Score of **8.0** and ending at **63.3**. Each entry has the full hypothesis, before/after, score delta, verdict, and a short note on *why*.

Scores are against the 50-query demo set at [fixtures/demo-store/queries.json](../fixtures/demo-store/queries.json), measured with 3 repetitions per `(query, provider)` pair across Perplexity + OpenAI + Anthropic.

---

## Iteration 1 — `kept` (+14.0)

- **Product**: The Explorer Pro (`gid://shopify/Product/8611123200001`)
- **Type**: `title_rewrite` on `title`
- **Score**: 8.0 → 22.0 (Δ +14.00)
- **Confidence**: high (0.86)

**Before**
```
The Explorer Pro
```

**After**
```
The Explorer Pro — Waterproof Hiking Rain Jacket (10,000mm, 3-Layer)
```

*Why it worked:* The original title was pure branding. AI shoppers retrieve on **function + feature**, not brand names they've never heard of. Adding "waterproof", "hiking", "rain jacket", "10,000mm", and "3-layer" gave the page four independent keyword anchors. Seven compare-intent queries started matching immediately.

---

## Iteration 2 — `kept` (+6.2)

- **Product**: StormChaser X3 (`gid://shopify/Product/8611123200002`)
- **Type**: `description_restructure` on `descriptionHtml`
- **Score**: 22.0 → 28.2 (Δ +6.20)
- **Confidence**: high (0.78)

**Before (excerpt)**
```html
<p>Embrace every adventure with StormChaser X3. Engineered for those
who refuse to be defined by the weather. Push your limits.</p>
```

**After (excerpt)**
```html
<h2>Specs</h2>
<ul>
  <li>Waterproofing: 15,000mm hydrostatic head</li>
  <li>Breathability: 20,000 g/m²/24h MVTR</li>
  <li>Fabric: 3-layer ripstop nylon with Pertex Shield</li>
  <li>Seams: Fully taped (13mm)</li>
  <li>Pit zips: Two-way, YKK AquaGuard</li>
</ul>
<h2>Best for</h2>
<p>Backpacking, alpine hiking, and storm-day scrambles where DWR
alone won't cut it.</p>
```

*Why it worked:* Specs-heavy descriptions read like the product pages the web-search models are trained against. Research-intent queries ("hydrostatic head rating", "MVTR breathability explained") now cite this page because the specs are the answer.

---

## Iteration 3 — `reverted` (-3.1)

- **Product**: RidgelineKit Pro (`gid://shopify/Product/8611123200003`)
- **Type**: `seo_title` on `seo.title`
- **Score**: 28.2 → 25.1 (Δ -3.10)
- **Confidence**: high (0.81)

**Before**
```
RidgelineKit Pro | Ridgeline Co
```

**After**
```
Buy RidgelineKit Pro — Best Rain Jacket 2026 — Shop Now
```

*Why it was reverted:* Stuffing "best", "buy", "shop now" reads as spam to both humans and AI shoppers. Score dropped across purchase-intent queries where the model preferred cleaner competitor titles. Reverted automatically; no store-side churn because the change is atomic.

---

## Iteration 4 — `kept` (+4.8)

- **Product**: Cascade Flow 2L (`gid://shopify/Product/8611123200004`)
- **Type**: `metafield_add` on `custom.waterproof_rating_mm`
- **Score**: 25.1 → 29.9 (Δ +4.80)
- **Confidence**: medium (0.55)

**Before**
```
(no metafield)
```

**After**
```
namespace: custom
key: waterproof_rating_mm
type: number_integer
value: 10000
```

*Why it worked:* Shopify renders metafields into the structured product data that both GPT-4's `web_search` and Perplexity's crawler pick up. The rating started appearing in research-intent queries about waterproofing levels.

---

## Iteration 5 — `checks_failed`

- **Product**: The Explorer Pro (`gid://shopify/Product/8611123200001`)
- **Type**: `title_rewrite` on `title`

**Proposed title**
```
Waterproof Waterproof Rain Jacket — Best Waterproof Waterproof Hiking Jacket for Waterproof Adventures
```

*Why it failed:* Keyword density check caught "waterproof" at 42%. Hard limit is 3%. Not applied to the store — logged as `checks_failed` with a ~0 cost.

---

## Iteration 6 — `kept_uncertain` (+1.2)

- **Product**: Altitude Alpine Shell (`gid://shopify/Product/8611123200005`)
- **Type**: `tags_update` on `tags`
- **Score**: 29.9 → 31.1 (Δ +1.20)
- **Confidence**: low (0.18)

**Before**
```
["outdoor", "apparel", "rain"]
```

**After**
```
["outdoor", "apparel", "rain", "3-layer", "pit-zips", "pertex-shield", "alpine", "storm-rated"]
```

*Why it's uncertain:* Positive delta but within the MAD noise band (±1.5). Kept because tags are cheap to maintain and unlikely to hurt, but flagged so the trace reader doesn't treat this as a confirmed win.

---

## Iteration 7 — `kept` (+8.4)

- **Product**: Kit Foundry Drift Shell (`gid://shopify/Product/8611123200006`)
- **Type**: `description_restructure` on `descriptionHtml`
- **Score**: 31.1 → 39.5 (Δ +8.40)
- **Confidence**: high (0.89)

*Why it worked:* Same playbook as iteration 2, applied to a more popular category (lightweight packable jackets). Larger query-match surface.

---

## Iteration 8 — `measure_failed`

- **Product**: Northwest Stormbreak (`gid://shopify/Product/8611123200007`)
- **Type**: `seo_description` on `seo.description`
- **Error**: `Perplexity API timeout after 30s (retry budget exhausted)`

*Why it was skipped:* Anthropic's web-search tool was rate-limited, Perplexity timed out twice, OpenAI returned successfully — but the engine requires at least two successful providers to aggregate. Logged as `measure_failed`, no store change reverted (because apply succeeded). Re-measured on the next iteration.

---

## Iteration 9 — `kept` (+7.6)

- **Product**: Ridgeline Co Packlight (`gid://shopify/Product/8611123200008`)
- **Type**: `metafield_add` on `custom.best_for`
- **Score**: 39.5 → 47.1 (Δ +7.60)
- **Confidence**: high (0.92)

**After**
```
value: "backpacking, thru-hiking, travel"
```

*Why it worked:* "Best for X" metafields are table-stakes product-data structure. Compare-intent queries ("best packable rain jacket for backpacking") surfaced this product in citations that had skipped it before.

---

## Iteration 10 — `reverted` (-2.8)

- **Product**: Cascadia Gear Shield 3L (`gid://shopify/Product/8611123200009`)
- **Type**: `title_rewrite` on `title`
- **Score**: 47.1 → 44.3 (Δ -2.80)

**Before**
```
Cascadia Gear Shield 3L — Waterproof Hardshell Jacket
```

**After**
```
Women's Hardshell
```

*Why it was reverted:* Stripped too much. The longer title matched more queries; truncating to two generic words lost seven compare-intent matches. Classic over-correction.

---

## Iteration 11 — `kept` (+11.2)

- **Product**: Northwest Outfitters Monsoon (`gid://shopify/Product/8611123200010`)
- **Type**: `title_rewrite` + `description_restructure` (sequenced)
- **Score**: 44.3 → 55.5 (Δ +11.20)
- **Confidence**: high (0.94)

*Why it worked:* The combined change (function-first title + specs-heavy description) on a popular category (men's rain jacket under $200) closed out a whole cluster of purchase-intent queries in one iteration.

---

## Iteration 12 — `kept` (+7.8)

- **Product**: Altitude & Co Trailpack Parka (`gid://shopify/Product/8611123200011`)
- **Type**: `seo_description` on `seo.description`
- **Score**: 55.5 → 63.3 (Δ +7.80)
- **Confidence**: high (0.87)

**Before**
```
The Altitude & Co Trailpack Parka - shop now!
```

**After**
```
Insulated waterproof parka for winter hiking. 800-fill down, 15,000mm
waterproofing, storm hood with wire brim. Sizes XS-XL.
```

*Why it worked:* Meta descriptions get lifted verbatim into search engine result pages, which both Perplexity and OpenAI parse before deep-crawling. A concrete spec-laden description pulls the product into citations for winter-specific queries.

---

## Summary

| Metric                    | Value                   |
| ------------------------- | ----------------------- |
| Iterations                | 12                      |
| Kept (confident)          | 7                       |
| Kept (uncertain)          | 1                       |
| Reverted                  | 2                       |
| Checks failed             | 1                       |
| Measure failed            | 1                       |
| Score delta               | 8.0 → 63.3 (+55.3)      |
| Total cost                | $3.87                   |

What the trace makes visible: **half the wins are description restructures**, two different title strategies have opposite results, and keyword stuffing is caught before it touches the store. The revert mechanism is what lets the loop stay aggressive — it's cheap to try a bold rewrite if the negative case fixes itself.
