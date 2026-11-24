// Un test per voce di packages/CONFORMANCE.md, col nome della voce in testa.
// Python (tests/test_conformance.py) e Go (conformance_test.go) hanno gli stessi.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import {
  AllTcgApi,
  AllTcgApiError,
  ApiConnectionError,
  ApiTimeoutError,
  AuthenticationError,
  DEFAULT_BASE_URL,
  GAME_IDS,
  InvalidRequestError,
  MAX_CURRENT_IDS,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitedError,
  ServerError,
  TrialExpiredError,
  VERSION,
  toApiError,
} from '../dist/index.js';
import { backoffMs, serializeParams, timers } from '../dist/client.js';
import { fixtureDoc, ok, pathOf, recorder, response } from './helpers.mjs';

/** @param {ReturnType<typeof recorder>} rec */
const client = (rec, options = {}) => new AllTcgApi({ apiKey: 'test', maxRetries: 0, fetch: rec.fetch, ...options });

/** @type {number[]} */
let waits = [];
const realSleep = timers.sleep;
beforeEach(() => {
  waits = [];
  timers.sleep = async (ms) => {
    waits.push(ms);
  };
});
afterEach(() => {
  timers.sleep = realSleep;
});

test('params-encoding: scalars only, empty values dropped, path segments escaped', async () => {
  assert.equal(serializeParams({ game: 'yugioh', limit: 25, name: '', set: undefined, number: null }).toString(), 'game=yugioh&limit=25');
  assert.equal(serializeParams(undefined).toString(), '');

  const rec = recorder(() => ok({ data: {} }));
  await client(rec).cards.get('a/b c?d');
  await client(rec).cards.list({ game: 'yugioh', number: 'MAMS-EN001', name: '' });
  await client(rec).cards.list({ name: 'Blue-Eyes White' });
  assert.deepEqual(rec.requests.map((r) => pathOf(r.url)), [
    '/v1/cards/a%2Fb%20c%3Fd',
    '/v1/cards?game=yugioh&number=MAMS-EN001',
    '/v1/cards?name=Blue-Eyes+White',
  ]);
});

test('env-key-fallback: ALLTCG_API_KEY when no key is passed, nothing when neither', async () => {
  const saved = process.env.ALLTCG_API_KEY;
  try {
    const rec = recorder(() => ok({ data: [] }));
    process.env.ALLTCG_API_KEY = 'from-env';
    await new AllTcgApi({ fetch: rec.fetch }).games.list();
    delete process.env.ALLTCG_API_KEY;
    await new AllTcgApi({ fetch: rec.fetch }).games.list();
    await new AllTcgApi({ apiKey: 'explicit', fetch: rec.fetch }).games.list();
    assert.equal(rec.requests[0]?.headers['x-api-key'], 'from-env');
    assert.equal(rec.requests[1]?.headers['x-api-key'], undefined);
    assert.equal(rec.requests[2]?.headers['x-api-key'], 'explicit');
  } finally {
    if (saved === undefined) delete process.env.ALLTCG_API_KEY;
    else process.env.ALLTCG_API_KEY = saved;
  }
});

test('headers-sent: accept, x-api-key and a versioned user-agent', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);

  const rec = recorder(() => ok({ data: [] }));
  await client(rec).games.list();
  await client(rec, { userAgent: 'my-bot/1.0' }).games.list();
  assert.equal(rec.requests[0]?.headers['accept'], 'application/json');
  assert.equal(rec.requests[0]?.headers['x-api-key'], 'test');
  assert.equal(rec.requests[0]?.headers['user-agent'], `@alltcgapi/sdk/${VERSION}`);
  assert.equal(rec.requests[1]?.headers['user-agent'], 'my-bot/1.0');
  assert.equal(new URL(rec.requests[0]?.url ?? '').origin, DEFAULT_BASE_URL);
});

test('response-info: credits, quota and rate limit read from the headers', async () => {
  const rec = recorder('games', () => ok({ data: [] }, { 'x-credits-cost': 'abc', 'x-quota-reset': '2026-12-01T00:00:00Z' }));
  const api = client(rec);
  await api.games.list();
  assert.deepEqual(api.lastResponse, {
    url: `${DEFAULT_BASE_URL}/v1/games`,
    status: 200,
    requestId: '00000000000000000000000000000001',
    errorCode: null,
    creditsCost: 1,
    quotaLimit: 800,
    quotaRemaining: 799,
    quotaReset: null,
    rateLimitLimit: 5,
    rateLimitRemaining: 4,
  });
  await api.games.list();
  assert.equal(api.lastResponse?.creditsCost, null);
  assert.equal(api.lastResponse?.quotaReset, '2026-12-01T00:00:00Z');
  assert.equal(api.lastResponse?.requestId, null);
});

test('on-response-called-on-errors: the callback sees the error response before the throw', async () => {
  /** @type {import('../dist/index.js').ResponseInfo[]} */
  const seen = [];
  const rec = recorder('404-card-not-found');
  const api = client(rec, { onResponse: (info) => seen.push(info) });
  await assert.rejects(api.cards.get('00000000-0000-4000-8000-000000000000'), NotFoundError);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.status, 404);
  assert.equal(seen[0]?.errorCode, 'CARD_NOT_FOUND');
  assert.equal(api.lastResponse?.errorCode, 'CARD_NOT_FOUND');
});

test('error-mapping-table: the code first, then the status', async () => {
  /** @type {[string, Function, string][]} */
  const cases = [
    ['429-quota-exceeded', QuotaExceededError, 'QUOTA_EXCEEDED'],
    ['403-trial-expired', TrialExpiredError, 'TRIAL_EXPIRED'],
    ['429-rate-limited', RateLimitedError, 'RATE_LIMITED'],
    ['429-concurrency-limit', RateLimitedError, 'CONCURRENCY_LIMIT'],
    ['401-missing-key', AuthenticationError, 'MISSING_API_KEY'],
    ['404-card-not-found', NotFoundError, 'CARD_NOT_FOUND'],
    ['400-invalid-parameter', InvalidRequestError, 'INVALID_PARAMETER'],
    ['400-limit-exceeded', InvalidRequestError, 'LIMIT_EXCEEDED'],
    ['503-meter-unavailable', ServerError, 'METER_UNAVAILABLE'],
  ];
  for (const [name, cls, code] of cases) {
    const doc = fixtureDoc(name);
    await assert.rejects(client(recorder(name)).games.list(), (error) => {
      assert.ok(error instanceof cls, `${name} -> ${error?.constructor?.name}`);
      assert.ok(error instanceof AllTcgApiError);
      assert.equal(error.code, code);
      assert.equal(error.status, doc.status);
      assert.equal(error.requestId, doc.body.error.request_id);
      assert.equal(error.message, `${code}: ${doc.body.error.message}`);
      return true;
    });
  }
  assert.ok(toApiError(403, { code: 'TRIAL_EXPIRED', message: 'x' }) instanceof PermissionDeniedError);
  assert.ok(toApiError(403, { code: 'INSUFFICIENT_SCOPE', message: 'x' }) instanceof PermissionDeniedError);
  assert.ok(!(toApiError(403, { code: 'INSUFFICIENT_SCOPE', message: 'x' }) instanceof TrialExpiredError));
  assert.ok(toApiError(400, { code: 'SET_NOT_FOUND', message: 'x' }) instanceof NotFoundError);
  assert.equal(/** @type {RateLimitedError} */ (toApiError(429, { code: 'RATE_LIMITED', message: 'x' }, 7)).retryAfter, 7);
  assert.equal(toApiError(302, { code: 'HTTP_302', message: 'x' }).constructor, AllTcgApiError);
});

test('error-body-fallback: an HTML 502 from a proxy still maps by status', async () => {
  await assert.rejects(client(recorder('502-html')).games.list(), (error) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.code, 'HTTP_502');
    assert.equal(error.status, 502);
    assert.equal(error.message, 'HTTP_502: Bad Gateway');
    assert.equal(error.requestId, undefined);
    return true;
  });
});

test('param-accessor: details.param names the refused parameter', async () => {
  await assert.rejects(client(recorder('400-invalid-parameter')).sets.list({ game: 'one-piece' }), (error) => {
    assert.ok(error instanceof InvalidRequestError);
    assert.equal(error.param, 'game');
    assert.deepEqual(error.details?.['allowed'], [...GAME_IDS]);
    return true;
  });
  assert.equal(toApiError(400, { code: 'LIMIT_EXCEEDED', message: 'x', details: { max: 250 } }).param, undefined);
  assert.equal(toApiError(400, { code: 'INVALID_PARAMETER', message: 'x', details: { param: 7 } }).param, undefined);
});

test('retry-policy: GET retried on rate limit, 5xx, network and 408; never on quota or other 4xx', async () => {
  // 429 con Retry-After, poi 200: un'attesa di esattamente Retry-After secondi.
  let rec = recorder('429-rate-limited', 'games');
  assert.equal((await client(rec, { maxRetries: 2 }).games.list()).length, GAME_IDS.length);
  assert.equal(rec.requests.length, 2);
  assert.deepEqual(waits, [1000]);

  rec = recorder('429-concurrency-limit', 'games');
  await client(rec, { maxRetries: 2 }).games.list();
  assert.equal(rec.requests.length, 2);

  // Un 5xx ogni volta: max_retries + 1 tentativi, poi l'errore.
  rec = recorder('502-html');
  await assert.rejects(client(rec, { maxRetries: 2 }).games.list(), ServerError);
  assert.equal(rec.requests.length, 3);

  rec = recorder('503-meter-unavailable', 'games');
  await client(rec, { maxRetries: 2 }).games.list();
  assert.equal(rec.requests.length, 2);

  // La quota e' un 429 con un Retry-After di ore: mai ritentata.
  waits = [];
  rec = recorder('429-quota-exceeded');
  await assert.rejects(client(rec, { maxRetries: 2 }).games.list(), QuotaExceededError);
  assert.equal(rec.requests.length, 1);
  assert.deepEqual(waits, []);

  // Gli altri 4xx neppure.
  for (const name of ['404-card-not-found', '400-invalid-parameter', '401-missing-key']) {
    rec = recorder(name);
    await assert.rejects(client(rec, { maxRetries: 2 }).games.list(), AllTcgApiError);
    assert.equal(rec.requests.length, 1, name);
  }

  // Rete e 408 si'.
  let calls = 0;
  rec = recorder(() => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return new Response(JSON.stringify({ error: { code: 'REQUEST_TIMEOUT', message: 'slow' } }), { status: 408 });
    return ok({ data: [] });
  });
  await client(rec, { maxRetries: 2 }).games.list();
  assert.equal(calls, 3);

  // maxRetries 0: un tentativo solo.
  rec = recorder('429-rate-limited');
  await assert.rejects(client(rec, { maxRetries: 0 }).games.list(), RateLimitedError);
  assert.equal(rec.requests.length, 1);

  // Il backoff: Retry-After con tetto a 60 s, altrimenti jitter pieno fino a 8 s.
  assert.equal(backoffMs(0, 5), 5000);
  assert.equal(backoffMs(3, 3600), 60_000);
  assert.equal(backoffMs(0, undefined, () => 1), 500);
  assert.equal(backoffMs(1, undefined, () => 1), 1000);
  assert.equal(backoffMs(4, undefined, () => 1), 8000);
  assert.equal(backoffMs(9, undefined, () => 1), 8000);
  assert.equal(backoffMs(2, undefined, () => 0), 0);
});

test('trial-expired-not-retried: 403 TRIAL_EXPIRED surfaces after one attempt, with its details', async () => {
  const rec = recorder('403-trial-expired');
  const api = client(rec, { maxRetries: 5 });
  await assert.rejects(api.prices.card('7a3d9e2b-5c1f-4b8a-9e6d-3f2a1c8b7e94'), (error) => {
    assert.ok(error instanceof TrialExpiredError);
    assert.ok(error instanceof PermissionDeniedError);
    assert.equal(error.code, 'TRIAL_EXPIRED');
    assert.equal(error.requestId, '00000000000000000000000000000017');
    assert.equal(error.details?.['plans'], '/v1/billing/plans');
    return true;
  });
  assert.equal(rec.requests.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(api.lastResponse?.quotaRemaining, 0);
});

test('pagination-follows-links-next: next page is the exact links.next URL, null ends the walk', async () => {
  const first = fixtureDoc('sets-page-1');
  const rec = recorder('sets-page-1', 'sets-page-2');
  const page = await client(rec).sets.list({ game: 'onepiece', limit: 2 });
  assert.equal(page.hasMore, true);
  assert.equal(page.nextUrl, first.body.links.next);
  assert.deepEqual(page.meta, { limit: 2, count: 2, has_more: true });

  const second = await page.nextPage();
  assert.equal(rec.requests[1]?.url, first.body.links.next);
  assert.equal(second?.hasMore, false);
  assert.equal(second?.nextUrl, null);
  assert.equal(await second?.nextPage(), null);
  assert.equal(rec.requests.length, 2);

  // Iterare cammina tutte le pagine, in ordine.
  const walk = recorder('set-cards-page-1', 'set-cards-page-2');
  const numbers = [];
  for await (const card of await client(walk).sets.cards('OP01', { limit: 2 })) numbers.push(card.number);
  assert.deepEqual(numbers, ['OP01-001', 'OP01-002', 'OP01-003']);
  assert.deepEqual(walk.requests.map((r) => r.url), [
    `${DEFAULT_BASE_URL}/v1/sets/OP01/cards?limit=2`,
    fixtureDoc('set-cards-page-1').body.links.next,
  ]);
});

test('to-list-max: materialising needs a ceiling and stops at it', async () => {
  let rec = recorder('set-cards-page-1', 'set-cards-page-2');
  const two = await (await client(rec).sets.cards('OP01', { limit: 2 })).toArray({ max: 2 });
  assert.deepEqual(two.map((c) => c.number), ['OP01-001', 'OP01-002']);
  assert.equal(rec.requests.length, 1);

  rec = recorder('set-cards-page-1', 'set-cards-page-2');
  const all = await (await client(rec).sets.cards('OP01', { limit: 2 })).toArray({ max: 100 });
  assert.equal(all.length, 3);
  assert.equal(rec.requests.length, 2);
});

test('etag-304: If-None-Match with the stored ETag, the cached body on 304, nothing when off', async () => {
  let rec = recorder('sets-page-1', '304', 'sets-page-1');
  let api = client(rec, { cache: 'etag' });
  const one = await api.sets.list({ game: 'onepiece', limit: 2 });
  const two = await api.sets.list({ game: 'onepiece', limit: 2 });
  assert.equal(rec.requests[0]?.headers['if-none-match'], undefined);
  assert.equal(rec.requests[1]?.headers['if-none-match'], '"s3ts-1"');
  assert.deepEqual(two.data, one.data);
  assert.equal(api.lastResponse?.status, 304);
  await api.sets.list({ game: 'onepiece', limit: 3 });
  assert.equal(rec.requests[2]?.headers['if-none-match'], undefined);

  rec = recorder('sets-page-1');
  api = client(rec);
  await api.sets.list();
  await api.sets.list();
  assert.ok(rec.requests.every((r) => r.headers['if-none-match'] === undefined));
});

test('reference-single-request: one request per client, unknown key is an empty list', async () => {
  const rec = recorder('reference');
  const api = client(rec);
  const [all, regions] = await Promise.all([api.reference.all(), api.reference.regions()]);
  assert.deepEqual(regions, ['WEST', 'EAST']);
  assert.deepEqual(await api.reference.locales(), ['en', 'it', 'es', 'fr', 'de', 'ja', 'zh', 'ko']);
  assert.deepEqual(await api.reference.currencies(), ['EUR', 'USD', 'GBP', 'JPY', 'CHF']);
  assert.deepEqual(await api.reference.values('nope'), []);
  assert.deepEqual(Object.keys(all), ['regions', 'locales', 'currencies', 'scopes']);
  assert.equal(rec.requests.length, 1);

  // Un errore non resta in memoria: la chiamata dopo riprova.
  const flaky = recorder('502-html', 'reference');
  const api2 = client(flaky);
  await assert.rejects(api2.reference.all(), ServerError);
  assert.deepEqual(await api2.reference.regions(), ['WEST', 'EAST']);
  assert.equal(flaky.requests.length, 2);
});

test('envelope-unwrap: one object or one array comes back without data, lists as a Page', async () => {
  const api = (name) => client(recorder(name));

  const games = await api('games').games.list();
  assert.deepEqual(games.map((g) => g.id), [...GAME_IDS]);
  assert.equal(games.find((g) => g.id === 'pokemon')?.name, 'Pokémon TCG');

  const set = await api('set-op01').sets.get('OP01');
  assert.equal(set.code, 'OP01');
  assert.equal(set.region, 'WEST');
  assert.deepEqual(set.names, { en: 'Romance Dawn', ja: 'ROMANCE DAWN' });

  const card = await api('card-mams-en001').cards.get('9e1c4a27-3b5d-4e8f-a6c1-2d7b9f0e3c58');
  assert.equal(card.number, 'MAMS-EN001');
  assert.equal(card.name, 'Blue-Eyes White Dragon, the White Phantom Beast');
  assert.equal(card.set.code, 'YGO-MAMS');
  assert.deepEqual(card.names, {});
  assert.equal(card.attributes?.['attack'], 3000);
  assert.deepEqual(card.external_ids, { cardmarket: null, tcgplayer: 662107 });

  const found = await api('cards-yugioh-mams-en001').cards.list({ game: 'yugioh', number: 'MAMS-EN001' });
  assert.equal(found.data[0]?.names, undefined);
  assert.equal(found.hasMore, false);

  const zoro = await api('card-op01-001').cards.get('7a3d9e2b-5c1f-4b8a-9e6d-3f2a1c8b7e94');
  assert.equal(zoro.name, 'Roronoa Zoro');
  assert.deepEqual(zoro.names, { ja: 'ロロノア・ゾロ' });

  const sealed = await api('sealed-op01-booster-box').sealed.get('c4e1a9f3-2d7b-4c5e-8a1f-9b3d6e2c7a15');
  assert.equal(sealed.kind, 'BOOSTER_BOX');
  assert.deepEqual(sealed.set, { id: '2c8e5f1a-7b3d-4a9e-8f2c-6d1b4e7a9c03', code: 'OP01' });
  const boxes = await api('sealed-page').sealed.list({ game: 'onepiece', limit: 1 });
  assert.equal(boxes.data[0]?.pack_count, 24);

  const quotes = await api('prices-card').prices.card('7a3d9e2b-5c1f-4b8a-9e6d-3f2a1c8b7e94');
  assert.deepEqual(quotes.map((q) => [q.source, q.variant, q.price.currency]), [
    ['CARDMARKET', 'LOWEST_NEAR_MINT', 'EUR'],
    ['CARDMARKET', 'TREND', 'EUR'],
    ['TCGPLAYER', 'MARKET', 'USD'],
  ]);
  assert.equal(quotes[0]?.price.amount, 0.35);
  assert.equal(quotes[0]?.eu_only, false);
  assert.equal(quotes[0]?.as_of, '2026-11-18');
  const boxQuotes = await api('prices-sealed').prices.sealed('c4e1a9f3-2d7b-4c5e-8a1f-9b3d6e2c7a15');
  assert.equal(boxQuotes[0]?.condition, null);

  const sources = await api('prices-sources').prices.sources();
  assert.deepEqual(sources.map((s) => s.code), ['CARDMARKET', 'TCGPLAYER']);
  assert.deepEqual([sources[0]?.delay_hours, sources[0]?.max_age_days], [24, 90]);
  const coverage = await api('prices-coverage').prices.coverage();
  assert.deepEqual([coverage[0]?.game, coverage[0]?.as_of], ['lorcana', '2026-11-18']);

  const plans = await api('plans').plans();
  assert.deepEqual(plans.map((p) => p.code), ['FREE', 'DEVELOPER', 'GROWTH', 'PROFESSIONAL', 'ENTERPRISE']);
  assert.deepEqual(plans[0]?.price_month, { amount: 0, currency: 'EUR' });
  assert.equal(plans[0]?.renews, false);
  assert.equal(plans[4]?.credits, null);

  const status = await api('status').status();
  assert.deepEqual(status.refresh.map((lane) => lane.lane), ['catalog', 'prices']);
  const health = await api('health').health();
  assert.deepEqual(health, { status: 'ok', db: true, uptime_s: 86400, version: 'v0.1.0' });
});

test('prices-current-batch: ids joined in one key, data and meta as sent, guards before the request', async () => {
  const ZORO = '7a3d9e2b-5c1f-4b8a-9e6d-3f2a1c8b7e94';
  const BOX = 'c4e1a9f3-2d7b-4c5e-8a1f-9b3d6e2c7a15';
  const MISSING = '00000000-0000-4000-8000-000000000000';

  const rec = recorder('prices-current');
  const result = await client(rec).prices.current([ZORO, BOX, MISSING], { source: 'CARDMARKET' });
  assert.deepEqual(rec.requests.map((r) => pathOf(r.url)), [
    `/v1/prices/current?ids=${ZORO}%2C${BOX}%2C${MISSING}&source=CARDMARKET`,
  ]);
  assert.deepEqual(result.meta, { requested: 3, found: 2 });
  assert.deepEqual(result.data.map((item) => [item.id, item.kind, item.quotes.length]), [
    [ZORO, 'card', 2],
    [BOX, 'sealed', 1],
  ]);
  assert.equal(result.data[0]?.quotes[1]?.price.currency, 'USD');

  const idle = recorder();
  assert.deepEqual(await client(idle).prices.current([]), { data: [], meta: { requested: 0, found: 0 } });
  const tooMany = Array.from({ length: MAX_CURRENT_IDS + 1 }, () => ZORO);
  await assert.rejects(client(idle).prices.current(tooMany), RangeError);
  assert.equal(idle.requests.length, 0);
});

test('prices-history: the window and the bucket go out as given, data and meta come back whole', async () => {
  const ZORO = '7a3d9e2b-5c1f-4b8a-9e6d-3f2a1c8b7e94';
  const BOX = 'c4e1a9f3-2d7b-4c5e-8a1f-9b3d6e2c7a15';

  const rec = recorder('prices-history-card', 'prices-history-sealed');
  const api = client(rec);
  const card = await api.prices.cardHistory(ZORO);
  const box = await api.prices.sealedHistory(BOX, { from: '2026-09-01', to: '2026-11-19', bucket: 'month', variant: 'LOWEST' });
  assert.deepEqual(rec.requests.map((r) => pathOf(r.url)), [
    `/v1/cards/${ZORO}/prices/history`,
    `/v1/sealed/${BOX}/prices/history?from=2026-09-01&to=2026-11-19&bucket=month&variant=LOWEST`,
  ]);

  // La chiave di prova ha chiesto 90 giorni e ne legge 7: la risposta e' piu'
  // corta e lo dice, non e' un errore.
  assert.deepEqual(card.meta, {
    id: ZORO, kind: 'card', from: '2026-11-12', to: '2026-11-19', bucket: 'day', count: 5,
    truncated: true, capped: false, plan_window_days: 7,
  });
  assert.equal(card.data.length, 5);
  assert.deepEqual(
    [card.data[0]?.date, card.data[0]?.source, card.data[0]?.variant, card.data[0]?.price.amount, card.data[0]?.eu_only],
    ['2026-11-16', 'CARDMARKET', 'TREND', 0.5, false],
  );

  assert.equal(box.meta.plan_window_days, null);
  assert.deepEqual([box.meta.bucket, box.meta.truncated, box.meta.capped], ['month', false, false]);
  assert.deepEqual(box.data.map((p) => p.date), ['2026-09-01', '2026-10-01', '2026-11-01']);
});

test('route-table: every method hits one route of routes.json, and every route has a method', async () => {
  const ID = 'ID';
  const rec = recorder(() => ok({ data: [], meta: { limit: 50, count: 0, has_more: false }, links: { next: null } }));
  const api = client(rec);
  await api.health();
  await api.status();
  await api.reference.all();
  await api.plans();
  await api.prices.sources();
  await api.prices.coverage();
  await api.games.list();
  await api.sets.list();
  await api.sets.get(ID);
  await api.sets.cards(ID);
  await api.cards.list();
  await api.cards.get(ID);
  await api.sealed.list();
  await api.sealed.get(ID);
  await api.prices.card(ID);
  await api.prices.sealed(ID);
  await api.prices.current([ID]);
  await api.prices.cardHistory(ID);
  await api.prices.sealedHistory(ID);
  const hit = rec.requests.map((r) => `GET ${new URL(r.url).pathname.split('/').map((s) => (s === ID ? '{id}' : s)).join('/')}`);
  assert.deepEqual([...hit].sort(), [...fixtureDoc('routes')].sort());
  assert.equal(new Set(hit).size, hit.length);
});

test('timeout-maps-to-timeout-error: a per-attempt timeout is an ApiTimeoutError', async () => {
  /** @type {typeof globalThis.fetch} */
  const hang = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  let attempts = 0;
  const api = new AllTcgApi({ apiKey: 'test', timeout: 5, maxRetries: 1, fetch: (input, init) => ((attempts += 1), hang(input, init)) });
  await assert.rejects(api.games.list(), (error) => {
    assert.ok(error instanceof ApiTimeoutError);
    assert.ok(error instanceof ApiConnectionError);
    return true;
  });
  assert.equal(attempts, 2);
});

test('fixtures: the shared copy is readable', () => {
  assert.equal(response('games').status, 200);
});
