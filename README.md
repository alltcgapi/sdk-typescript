# @alltcgapi/sdk

TypeScript client for [alltcgapi](https://alltcgapi.com/?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript), the trading card game API: nineteen games, one key, one response shape. Cards, sets, sealed products, current prices with their source and their history, for Pokémon, Yu-Gi-Oh!, One Piece, Lorcana, Digimon, Flesh and Blood, Star Wars: Unlimited and more.

- No runtime dependencies: it uses the platform `fetch` (Node 20+, Deno, Bun, browsers, edge runtimes).
- Typed responses, typed errors with `code` and `requestId`.
- Pagination that follows `links.next` for you.
- Retries with `Retry-After` on rate limits and 5xx, never on quota or an expired trial.

```sh
npm install @alltcgapi/sdk
```

## Quick start

Get a key from the [free API key page](https://alltcgapi.com/free-api-key?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript) and put it in `ALLTCG_API_KEY`.

```ts
import { AllTcgApi } from '@alltcgapi/sdk';

const client = new AllTcgApi(); // reads ALLTCG_API_KEY

// Find a Yu-Gi-Oh! card by the number printed on it.
const page = await client.cards.list({ game: 'yugioh', number: 'MAMS-EN001' });
const card = page.data[0];
console.log(card.name); // Blue-Eyes White Dragon, the White Phantom Beast
console.log(card.set.code, card.rarity); // YGO-MAMS Ultra Rare

// Its current quotes: one row per source, variant and language, never blended or converted.
for (const quote of await client.prices.card(card.id)) {
  console.log(quote.source, quote.variant, quote.price.amount, quote.price.currency, quote.as_of);
}
```

## Prices over time

`as_of` and `date` are days in UTC (`YYYY-MM-DD`), not instants. `prices.sources()` says how many hours each source is delayed.

```ts
// One point per series per day; week and month buckets carry the median of their days.
const history = await client.prices.cardHistory(card.id, { from: '2026-08-01', bucket: 'week', source: 'TCGPLAYER' });
for (const point of history.data) {
  console.log(point.date, point.variant, point.price.amount, point.price.currency);
}
if (history.meta.truncated) {
  // The plan reads back plan_window_days days: the answer is shorter, not an error.
  console.log(`history starts at ${history.meta.from}`);
}

// Up to 25 cards and sealed products in one request, for a flat 4 credits.
const current = await client.prices.current([card.id, boxId]);
console.log(current.meta.found, 'of', current.meta.requested);
```

Without `from` and `to` the history covers the last 90 days. `meta.capped` is `true` when a series was too long for one response: ask for `bucket: 'week'` or a shorter window.

## Walk a set

List methods return a `Page`. Iterate it and the SDK requests each `links.next` URL exactly as the API returned it, so you never build a cursor by hand.

```ts
const cards = await client.sets.cards('OP01', { limit: 250 });
for await (const card of cards) {
  console.log(card.number, card.name); // OP01-001 Roronoa Zoro, ...
}

// Or one card, with its names in every language.
const zoro = await client.cards.get(cards.data[0].id);
console.log(zoro.names); // { ja: 'ロロノア・ゾロ' }
```

`page.toArray({ max })` materialises a list and requires a ceiling: every page costs credits.

## Errors

Every API error is an `AllTcgApiError` with `status`, `code`, `message`, `details` and `requestId`. Quote the `requestId` in a support request. Three of them look alike and need opposite handling:

```ts
import { QuotaExceededError, RateLimitedError, TrialExpiredError } from '@alltcgapi/sdk';

try {
  await client.prices.card(id);
} catch (error) {
  if (error instanceof TrialExpiredError) {
    // 403 TRIAL_EXPIRED: the trial credits do not come back. See client.plans().
  } else if (error instanceof QuotaExceededError) {
    // 429 QUOTA_EXCEEDED: the daily cap or the period is used up. Not retried.
  } else if (error instanceof RateLimitedError) {
    // 429 RATE_LIMITED or CONCURRENCY_LIMIT, after the automatic retries ran out.
  }
}
```

| Class | When |
| --- | --- |
| `AuthenticationError` | 401: missing, malformed, revoked or expired key |
| `PermissionDeniedError` | 403: the key may not do this |
| `TrialExpiredError` | 403 `TRIAL_EXPIRED` (a `PermissionDeniedError`) |
| `NotFoundError` | 404, or any `*_NOT_FOUND` code |
| `InvalidRequestError` | 400: unknown or repeated parameter, value outside its vocabulary. `error.param` names it |
| `RateLimitedError` | 429 `RATE_LIMITED`, `CONCURRENCY_LIMIT`; `retryAfter` in seconds |
| `QuotaExceededError` | 429 `QUOTA_EXCEEDED` |
| `ServerError` | 5xx, including 503 `METER_UNAVAILABLE` |
| `ApiConnectionError`, `ApiTimeoutError` | no answer, or no answer within `timeout` |

## Credits and quota

Every response carries what the call cost and what is left. Read the last one, or count them all:

```ts
const client = new AllTcgApi({
  onResponse: (info) => console.log(info.creditsCost, info.quotaRemaining, info.rateLimitRemaining),
});
await client.games.list();
console.log(client.lastResponse?.quotaLimit);
```

With `cache: 'etag'` the client sends `If-None-Match` and serves a `304` from memory: a 304 costs no credits.

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `process.env.ALLTCG_API_KEY` | sent as `X-Api-Key` |
| `baseUrl` | `https://api.alltcgapi.com` | |
| `timeout` | `30000` | milliseconds per attempt |
| `maxRetries` | `2` | repeated attempts after the first; `0` disables |
| `cache` | `'none'` | `'etag'` for conditional requests |
| `userAgent` | `@alltcgapi/sdk/<version>` | |
| `fetch` | `globalThis.fetch` | to inject a transport |
| `onResponse` | | called for every response, errors included |

## Methods

| Method | Route |
| --- | --- |
| `games.list()` | `GET /v1/games` |
| `sets.list({ game, region, limit, cursor })` | `GET /v1/sets` |
| `sets.get(idOrCode)` | `GET /v1/sets/{id}` |
| `sets.cards(idOrCode, { name, number, limit, cursor })` | `GET /v1/sets/{id}/cards` |
| `cards.list({ game, set, name, number, limit, cursor })` | `GET /v1/cards` |
| `cards.get(id)` | `GET /v1/cards/{id}` |
| `sealed.list({ game, set, kind, limit, cursor })` | `GET /v1/sealed` |
| `sealed.get(id)` | `GET /v1/sealed/{id}` |
| `prices.card(id, { source, language, variant })` | `GET /v1/cards/{id}/prices` |
| `prices.sealed(id, { source, language, variant })` | `GET /v1/sealed/{id}/prices` |
| `prices.current(ids, { source, language, variant })` | `GET /v1/prices/current` |
| `prices.cardHistory(id, { from, to, bucket, source, language, variant })` | `GET /v1/cards/{id}/prices/history` |
| `prices.sealedHistory(id, { from, to, bucket, source, language, variant })` | `GET /v1/sealed/{id}/prices/history` |
| `prices.sources()` | `GET /v1/prices/sources` |
| `prices.coverage()` | `GET /v1/prices/coverage` |
| `reference.all()`, `.regions()`, `.locales()`, `.currencies()` | `GET /v1/reference` (one request per client) |
| `plans()` | `GET /v1/billing/plans` |
| `status()` | `GET /v1/status` |
| `health()` | `GET /v1/health` |

The game ids are `pokemon`, `yugioh`, `onepiece`, `lorcana`, `digimon`, `dragonball-fw`, `dragonball-masters`, `fab`, `swu`, `swdestiny`, `weissschwarz`, `vanguard`, `riftbound`, `gundam`, `fftcg`, `fow`, `battlespirits`, `cyberpunk` and `dragoborne` (`GAME_IDS`).

## Links

- [Documentation](https://alltcgapi.com/docs?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript)
- [API reference](https://alltcgapi.com/docs/api?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript)
- [Pricing](https://alltcgapi.com/pricing?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript)
- [Status](https://alltcgapi.com/status?utm_source=npm&utm_medium=readme&utm_campaign=sdk_typescript)

Game names, card names and card images belong to their owners. alltcgapi is independent and is not endorsed by any game publisher or marketplace.

## License

MIT
