# FatSecret Basic evaluation

Status: **complete; no-go for production on the current Basic account.**
Documentation and bounded live evaluation completed 2026-09-10.
Nothing in this evaluation activates a patient-facing provider.

## Account and policy findings

| Question | Evidence | Account-specific status |
| --- | --- | --- |
| Edition/cost | [Editions](https://platform.fatsecret.com/api-editions): Basic is free, US-only, English, 5,000 calls/day. [Terms §1.4](https://platform.fatsecret.com/terms): allowance is per application, not per patient. | The live OAuth grant returned `basic`; no Premier scope was requested or used. |
| Standard text search | [Search v1](https://platform.fatsecret.com/docs/v1/foods.search) documents `foods.search`, page 0, JSON, up to 50 results, Brand and Generic results. Default market is US. Its OAuth scope label says `premier` despite the Basic editions table listing search. | The Basic token did return some standard-search results, so the endpoint is at least partially granted. Intermittent IP rejection prevents calling the access reliable or fully verified. No extra scope was requested. |
| Standard food detail | [Food detail v1](https://platform.fatsecret.com/docs/v1/food.get) documents `food.get` with serving IDs and nutrition. | Some returned IDs were readable through standard `food.get`; others hit the same intermittent IP rejection. Latest/Premier detail versions were not used. |
| OAuth/network | [OAuth2](https://platform.fatsecret.com/docs/guides/authentication/oauth2): server-side client credentials; tokens requested from registered finite IP addresses. CIDR ranges are identified as Premier/Premier Free. Omitting scope returns scopes already granted. | Both an implicit token and an explicit `basic` request returned only `scope=basic`. The observed development egress `136.67.38.143` was allowlisted, but requests from that reported IP still alternated between success and FatSecret error 21. Preview hostname was not treated as egress. Production egress remains unverified. |
| Storage | [Storable data](https://platform.fatsecret.com/docs/guides/storable-data): food/serving IDs are storable; other information must be requested each time. Terms §1.5 also imposes removal/re-request within 24 hours. Basic's editions column does **not** include caching. | Do not interpret the 24-hour maximum as permission to cache on Basic. No nutrition-response persistence planned. |
| Intended use | Terms §1.7(iii) restrict diet/nutrition/health advice, guidance and diagnosis. | THINNR coaching and provider workflows need review of the actual agreement or written provider clarification. A key does not resolve this. |
| Attribution | [Policy](https://platform.fatsecret.com/attribution) requires attribution wherever content appears, an accessible signed-out location, website, and app-store listings. Terms §1.6 also addresses linking the terms and user agreement. | Production UX/legal work is unresolved and out of this evaluation's implementation scope. |

Excluded: barcode, autocomplete, advanced search v5, brand-only filters,
localization parameters, images, NLP, recipes API, upgrades, patient data.
Marketing claims such as “zero duplicates” are not measured evidence.

## Public benchmark

These are authored US search intentions, not patient searches or verified
manufacturer nutrition claims. Verify flavor and requested size independently;
a matching brand alone is not an exact product match.

| Group | Query | Intended variant/size to assess |
| --- | --- | --- |
| Branded | Chobani Zero Sugar Vanilla Yogurt | Vanilla, 5.3 oz cup |
| Branded | Oikos Triple Zero Vanilla Greek Yogurt | Vanilla, 5.3 oz cup |
| Branded | Fairlife Core Power Chocolate 26g | 26 g protein variant, 14 fl oz bottle |
| Branded | Premier Protein Chocolate Shake | Chocolate, 11 fl oz carton |
| Branded | Quest Chocolate Chip Cookie Dough Protein Bar | Cookie dough, 60 g bar |
| Branded | Nature Valley Oats n Honey Crunchy Granola Bars | Oats and honey, two-bar serving |
| Branded | Oreo Original Sandwich Cookies | Original, not Double Stuf; package size unspecified |
| Branded | Coca Cola Zero Sugar | Zero Sugar, 12 fl oz can |
| Branded | Cheerios Original Cereal | Original, not Honey Nut; package size unspecified |
| Branded | Heinz Tomato Ketchup | Regular, not no-sugar-added; package size unspecified |
| Restaurant | McDonald's Big Mac | One standard sandwich |
| Restaurant | Chick-fil-A Chicken Sandwich | Original, not deluxe/spicy |
| Restaurant | Taco Bell Crunchy Taco | Standard beef taco |
| Restaurant | Wendy's Small Chili | Small, not large |
| Restaurant | Starbucks Caffe Latte Grande | Hot, standard milk, grande |
| Restaurant | Subway 6 Inch Turkey Breast | Six-inch standard sandwich; customization unknown unless supplied |
| Restaurant | Panda Express Orange Chicken | Standard entree serving |
| Restaurant | Chipotle Chicken Bowl | Ambiguous components: do not label a generic bowl an exact configured meal |
| Restaurant | Dunkin Glazed Donut | One standard glazed donut |
| Restaurant | Domino's Hand Tossed Pepperoni Pizza Large | Large hand-tossed, one slice; crust/diameter must agree |

### Budget and scoring

- Entire run hard ceiling: 150 outbound/API attempts, including failures.
  Reserve 20 FatSecret searches, up to 60 FatSecret detail calls, 20 OFF searches,
  20 anonymous THINNR shared-catalog reads, plus authentication/access probes.
  Maintain distinct provider, search, detail, and probe counters. No automatic
  retries or second search pages. Stop on quota/entitlement denial; record
  unrun queries as unrun, never no-match.
- FatSecret: standard v1, first five results, default US market, no Premier-only
  parameters. Score identity/flavor/size from available evidence in those five.
  Detail at most three candidates per query: best identity candidate, then the
  remaining highest-ranked candidates. Detail-derived rates must state this
  selected-candidate denominator, not pretend all five were detailed.
- Compare identical query strings with current OFF search and anonymous shared
  catalog behavior. OFF currently has no market filter; do not call its global
  results US-qualified. Unknown market is distinct from demonstrably wrong market.
  Do not use a real patient session to obtain external search results.
- Record first exact identity rank; flavor/size confirmed, unknown, or conflict;
  complete calories/protein/carbohydrate/fat; printed serving and metric
  quantity/unit; available optional nutrient names, not fabricated zeros;
  duplicates by source ID and suspected semantic duplicates separately.
- Successful zero-result searches, incomplete nutrition, HTTP failures,
  OAuth/scope failures, rate limits, malformed responses and timeouts are
  separate outcomes. Report timings with failed-request timing separate from
  successful latency. Single-pass latency is illustrative, not an SLA.
- Use existing OFF normalization for eligibility, without invoking the catalog
  selection/promotion or barcode routes. If a bounded OFF window cannot fill
  five usable results, label it truncated rather than claiming the full
  paginated THINNR search has no match.
- Keep payloads transient in process memory only; never write provider
  nutrition, descriptions, credentials, or tokens to logs, fixtures, reports,
  files, browser storage, or databases. Preserve authored queries, permitted
  identifiers, and derived evaluation counts/ratings, not copied nutrition.
  All retained fixtures must be synthetic.

## Measured results

### Run accounting and reliability

- **126 total requests**, including OAuth, access probes, FatSecret search/detail,
  one targeted access-failure rerun, and 20 OFF searches. There were no patient
  calls, retries for content ranking, second search pages, Premier methods, or
  selection/persistence calls.
- OAuth consistently returned `basic`. No authentication secret or access token
  was printed or retained.
- FatSecret initially produced successful searches for 11/20 benchmark queries.
  The other 9 received error 21 ("invalid IP") and remain **unavailable**, not
  no-match. Repeating only access-failed requests after allowlist propagation
  still left those 9 failures. Additional method-style checks also alternated
  between success and error 21 for previously successful queries.
- On the first complete pass, FatSecret search latency for successful HTTP calls
  was 74 ms median / 182 ms p95; detail was 69 ms / 72 ms. These timings include
  responses that can carry an API error inside HTTP 200, so they are not uptime
  or useful-result latency. Method-style checks measured 70 ms median search,
  209 ms p95, and 70/72 ms detail. Single-run timings are illustrative.
- OFF search completed for 9/20 requests and had 11 transport/provider failures:
  327 ms median / 810 ms p95 among successful responses. This was substantially
  slower, but neither provider's observed reliability is production-ready.
- A normal useful FatSecret interaction costs **2 calls** (search + selected
  food detail); detailing three candidates costs 4. At 5,000 calls shared by the
  whole application, the theoretical maximum is 2,500 two-call interactions/day
  before probes, failures, retries or other methods. At three details it is
  1,250. This is not a per-patient allowance.

### Search quality

The strict denominator is the 11 FatSecret queries that returned a result page;
9 access-failed queries are reported separately.

- A requested product/restaurant identity appeared in the first five for
  **9/11 available queries (82%)**. Eight were rank 1; Fairlife Core Power
  Chocolate 26 g was rank 2 behind the 42 g Elite variant.
- Exact requested package-size evidence was missing for the Fairlife 14 fl oz
  and Premier Protein 11 fl oz intentions. Counting those as unresolved gives
  **7/11 (64%)** first-five matches with all expressly requested variant/size
  evidence available.
- Useful rank-1 examples: Nature Valley Oats 'N Honey (two bars), Heinz Tomato
  Ketchup, Big Mac, Crunchy Taco, Grande hot Caffè Latte, Panda Express Orange
  Chicken and Dunkin Glazed Donut.
- Wrong/weak examples: “Cheerios Original” ranked a Berry Burst Cheerios item
  first and generic cereal rows thereafter; no Original Cheerios result appeared
  in five. The Domino's query ranked **Ultimate** Pepperoni rather than proving
  the standard pepperoni variant. Starbucks correctly put hot latte ahead of
  multiple iced variants.
- No duplicate FatSecret `food_id` occurred in 55 returned rows. That measures
  ID duplicates only; visually similar flavor/size variants remained and
  marketing's “zero duplicates” claim was not adopted.
- Wrong-market rate is unavailable from Basic FatSecret responses because the
  evaluation used the default US dataset and no Premier localization metadata.
  It would be misleading to infer market from a brand name.

### Nutrition and serving fidelity

- The first pass attempted detail on the top three candidates of each of 11
  available searches: **33 attempts**. Twelve returned a complete
  calories/protein/carbohydrate/fat serving during that pass; all 12 carried
  serving descriptions and 11 carried metric quantity/unit. Because error 21
  was intermittent, **12/33 (36%) is observed usable yield, not database
  completeness**.
- Independent standard-method checks confirmed that successful food details can
  carry source-specific food/serving IDs, printed serving descriptions, metric
  quantity/unit and optional nutrients. One observed complete serving lacked a
  metric quantity; absence must remain unknown.
- No observed successful branded serving contradicted the documented
  `number_of_units=1` rule. The adapter must still enforce the semantic rule:
  one unit is the full branded serving description, never a second multiplier.
- The same 20 OFF text searches returned 29 top-five rows across 9 successful
  queries; 25 passed THINNR's complete-core-nutrition gate and 19 explicitly
  indicated US in returned metadata. There were no duplicate codes in those
  windows. Eleven provider failures and the small first page make this a
  partial baseline, not a coverage claim.
- FatSecret had materially better restaurant ranking in the successful subset:
  OFF's “Taco Bell Crunchy Taco” results centered packaged taco shells, and its
  “Chipotle Chicken Bowl” results were unrelated packaged bowls. FatSecret put
  Taco Bell and Panda Express menu items at rank 1. However, a Chipotle bowl is
  component-dependent and must not become an exact loggable meal without its
  selected ingredients.

### Scope limitations

- The intermittent allowlist failures prevent a valid 20-vs-20 exact-match
  comparison. They are neither no-match nor evidence that the absent foods are
  missing from FatSecret.
- Anonymous THINNR local catalog behavior was assessed from its existing
  contract rather than live patient traffic: shared USDA/THINNR reads remain
  available with private-food and usage joins excluded. External packaged
  search stays authenticated and explicit. No patient session was created for
  this benchmark.
- Measured fields are derived ratings and counts. Provider nutrition responses
  were kept transient and deleted; no copied nutrition panel, token, or secret
  is part of this report or a fixture.

## Normalization and production gates

- Preserve provider + food ID + serving ID; do not coalesce unlike products
  merely because their names match. Search summaries are discovery, not the
  authoritative nutrition panel.
- Preserve the exact printed serving description and metric quantity/unit
  together. For Brand foods, `number_of_units=1` describes **one full listed
  serving**, even if the description says two tablespoons or three cookies.
  Macro totals are multiplied only by the patient's selected serving count.
- Do not infer grams from ml or substitute standard conversions for a printed
  source weight. Missing optional nutrients remain unknown; missing calories
  or a core macro makes a product non-loggable.
- Keep USDA/generic/approved behavior and Open Food Facts barcode service
  unchanged. FatSecret must never confer a THINNR approval badge.
- A future adapter would sit only behind explicit branded/restaurant text
  intent, with server-owned OAuth, an application-wide quota, provider-specific
  IDs/deduplication, and explicit upstream-unavailable states.
- Do not reuse `catalog/selections`' OFF durable promotion path for FatSecret.
  Local catalog storage, immutable diary snapshots, favorites' hydrated food
  copies, recipes, offline account cache/queue, provider displays and exports
  each need an explicit licensing decision before receiving FatSecret content.
- AI Coach can already consume diary-derived totals: blocking raw search
  payloads alone is not sufficient. No FatSecret-derived facts or totals may
  enter recommendations until intended-use permission is established.

### Written permission questions still open

1. Does the actual Basic agreement permit THINNR's medical-weight-management
   context, factual patient logging, staff views, and separate AI coaching?
   Which uses, if any, are exceptions to §1.7(iii)?
2. May consumed-food nutrition snapshots remain immutable indefinitely,
   including copies/edits, patient exports and clinical record retention?
   Refreshing or deleting historical nutrition is not an acceptable workaround.
3. Are favorites ID-only with live re-fetch, or may they retain display/nutrition
   copies? What is permitted for recipe ingredients and saved recipe totals?
4. Is any Basic caching permitted, including device offline entries, queued
   writes, backups and server response caches? What are the exact duration,
   deletion and termination requirements?
5. What attribution and terms acceptance are required on diary/history,
   recipes, provider screens, exports, signed-out pages and store listings?
6. Which standard search/detail methods and OAuth grants are actually included
   in this application? Resolve the `premier` label contradiction in writing
   if actual Basic access fails.

## Recommendation

**No-go on the current Basic account.** Do not activate FatSecret in production
or expose it to patients.

The partial evidence supports only this narrower conclusion: when standard
search worked, FatSecret ranked several US restaurant items better than OFF and
usually surfaced the intended item in five results. It did not consistently
prove package sizes, and its current IP behavior made 9/20 benchmark searches
unavailable and caused additional detail failures. More importantly, public
Basic documentation does not authorize the immutable/offline nutrition copies
THINNR needs, while public terms restrict advice use.

The smallest future scope, **only after both blockers are resolved**, is a
server-only optional branded/restaurant text-search adapter behind explicit
packaged/restaurant intent:

1. Confirm a stable allowlisted development and production egress path; repeat
   this exact benchmark without intermittent error 21.
2. Obtain written permission covering immutable diary snapshots, favorites,
   recipes, offline writes, provider views/exports, attribution and the exact
   boundary between factual logging and AI/clinical advice.
3. Keep USDA/approved results and OFF barcode behavior unchanged. Fetch
   FatSecret details only after a user chooses a search result; reject incomplete
   core nutrition; preserve food/serving IDs and serving evidence.
4. Use an app-wide quota and circuit breaker, canonical source-scoped
   deduplication, explicit provider-unavailable responses, and no automatic
   approval badge. Do not use the OFF durable promotion/cache tables.
5. Add required attribution in every display, a signed-out location, website
   and app-store listings before release.

Premier Free may be evaluated later only as a separately approved option. This
evaluation does not recommend an upgrade, use Premier-only methods, or infer
Premier eligibility.