import { existsSync, readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';

/**
 * Le fixture condivise: in packages/fixtures nel monorepo, in tests/fixtures
 * nel repo pubblico (le copia sync-public.sh).
 */
export function fixtureDoc(name) {
  const local = new URL(`./fixtures/${name}.json`, import.meta.url);
  const shared = new URL(`../../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(existsSync(local) ? local : shared, 'utf8'));
}

/** Una fixture come `Response`, con lo status text che un server vero manderebbe. */
export function response(name) {
  const doc = fixtureDoc(name);
  const nullBody = doc.status === 304 || doc.status === 204 || doc.body_text === '';
  const body = nullBody ? null : doc.body_text ?? JSON.stringify(doc.body);
  return new Response(body, { status: doc.status, statusText: STATUS_CODES[doc.status] ?? '', headers: doc.headers });
}

/** Un `Response` 200 con un corpo qualunque. */
export function ok(body, headers = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Un `fetch` finto che registra ogni richiesta e risponde da una coda: l'ultima
 * risposta si ripete. Una voce puo' essere un nome di fixture, un `Response` o
 * una funzione `(url, init) => Response`.
 */
export function recorder(...queue) {
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const requests = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    const url = String(input);
    const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
    requests.push({ url, headers });
    if (queue.length === 0) throw new Error(`richiesta inattesa: ${url}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'string') return response(next);
    if (typeof next === 'function') return next(url, init);
    return next.clone();
  };
  return { fetch, requests };
}

/** Il path di una richiesta registrata, con la query. */
export const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
