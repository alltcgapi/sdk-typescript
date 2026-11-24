import {
  AllTcgApiError,
  ApiConnectionError,
  ApiTimeoutError,
  QuotaExceededError,
  RateLimitedError,
  ServerError,
  toApiError,
  type ApiErrorBody,
} from './errors.js';
import type { Collection, CollectionMeta } from './types.js';
import { VERSION } from './version.js';

/**
 * Il trasporto.
 *
 * Nessuna dipendenza a runtime: `fetch` globale, che c'e' su Node 20+, Bun,
 * Deno, i Workers e i browser. Un client HTTP portato dentro il pacchetto
 * costerebbe piu' della funzione che sostituisce, e ogni sua CVE diventerebbe
 * nostra.
 */

export interface ClientOptions {
  /** Se assente si legge `ALLTCG_API_KEY` dall'ambiente, dove esiste. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Millisecondi per singolo tentativo, non per l'operazione intera. */
  readonly timeout?: number;
  /** Tentativi RIPETUTI, oltre al primo. 0 disattiva. */
  readonly maxRetries?: number;
  /** Iniettabile per i test e per gli ambienti che avvolgono fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Ricorda gli ETag e rispedisce `If-None-Match`.
   *
   * Vale la pena accenderlo: un 304 non ha corpo e non costa crediti, quindi
   * un mirror che risincronizza spesso paga solo le pagine cambiate. La cache
   * e' in memoria e per istanza: non sopravvive al processo, di proposito.
   */
  readonly cache?: 'none' | 'etag';
  readonly userAgent?: string;
  /** Chiamata a ogni risposta ricevuta, errori compresi: il posto per un contatore di crediti. */
  readonly onResponse?: (info: ResponseInfo) => void;
}

/** Cio' che la risposta dice negli header e che il corpo non porta. */
export interface ResponseInfo {
  readonly url: string;
  readonly status: number;
  readonly requestId: string | null;
  /** Uguale a error.code negli errori API; assente sulle risposte riuscite. */
  readonly errorCode: string | null;
  /**
   * `X-Credits-Cost`: il prezzo della rotta, scritto PRIMA dell'handler. Su un
   * errore o un 304 la chiamata viene rimborsata ma l'header resta: cio' che
   * e' stato scalato davvero lo dice `quotaRemaining` della risposta dopo.
   */
  readonly creditsCost: number | null;
  readonly quotaLimit: number | null;
  readonly quotaRemaining: number | null;
  /** Quando si rinnova un periodo pagato. Assente sulla prova, che non si rinnova. */
  readonly quotaReset: string | null;
  readonly rateLimitLimit: number | null;
  readonly rateLimitRemaining: number | null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toResponseInfo(url: string, response: Response): ResponseInfo {
  const h = response.headers;
  return {
    url,
    status: response.status,
    requestId: h.get('x-request-id'),
    errorCode: h.get('x-error-code'),
    creditsCost: headerNumber(h, 'x-credits-cost'),
    quotaLimit: headerNumber(h, 'x-quota-limit'),
    quotaRemaining: headerNumber(h, 'x-quota-remaining'),
    quotaReset: h.get('x-quota-reset'),
    rateLimitLimit: headerNumber(h, 'ratelimit-limit'),
    rateLimitRemaining: headerNumber(h, 'ratelimit-remaining'),
  };
}

export const DEFAULT_BASE_URL = 'https://api.alltcgapi.com';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const USER_AGENT = `@alltcgapi/sdk/${VERSION}`;

/** Errore di rete, 5xx, 408 o 429 di ritmo: e' l'unico insieme su cui riprovare ha senso. */
function isRetryable(error: unknown): boolean {
  if (error instanceof QuotaExceededError) return false;
  if (error instanceof RateLimitedError) return true;
  if (error instanceof ServerError) return true;
  if (error instanceof ApiConnectionError) return true;
  if (error instanceof AllTcgApiError) return error.status === 408;
  return false;
}

/**
 * Backoff esponenziale con jitter pieno.
 *
 * Il jitter non e' un dettaglio: senza, mille client che prendono lo stesso 429
 * riprovano tutti nello stesso millisecondo e ricostruiscono la coda che
 * stavano cercando di far smaltire.
 */
export function backoffMs(attempt: number, retryAfter: number | undefined, random: () => number = Math.random): number {
  if (retryAfter !== undefined) return Math.min(retryAfter * 1000, 60_000);
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return random() * ceiling;
}

function readEnv(name: string): string | undefined {
  // `process` non esiste nei browser ne' nei Workers: si guarda senza assumerlo.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === '' ? undefined : value;
}

/**
 * I parametri come li vuole l'API: `undefined`, `null` e stringhe vuote
 * restano fuori. Nessun parametro di questa API e' una chiave ripetuta (e' un
 * 400): si scrive una chiave sola, e l'unica lista, gli id di
 * `prices.current`, arriva qui gia' unita da virgole.
 */
export function serializeParams(params: object | undefined): URLSearchParams {
  const search = new URLSearchParams();
  if (!params) return search;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search;
}

/** Un segmento di path con l'id dentro: `/`, `?` e `#` in un id non devono cambiare rotta. */
export function segment(id: string): string {
  return encodeURIComponent(id);
}

/** Lo `sleep` passa da qui perche' i test possano sostituirlo senza aspettare davvero. */
export const timers = {
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly etags: Map<string, { etag: string; body: unknown }> | null;
  private readonly onResponse: ((info: ResponseInfo) => void) | undefined;

  /** Gli header dell'ultima risposta ricevuta da questa istanza. */
  lastResponse: ResponseInfo | null = null;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? readEnv('ALLTCG_API_KEY');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.etags = options.cache === 'etag' ? new Map() : null;
    this.onResponse = options.onResponse;
  }

  /** URL assoluto da un path applicativo piu' i parametri. */
  url(path: string, params?: object): string {
    const search = serializeParams(params).toString();
    return `${this.baseUrl}${path}${search === '' ? '' : `?${search}`}`;
  }

  get<T>(path: string, params?: object): Promise<T> {
    return this.request<T>(this.url(path, params));
  }

  /**
   * Segue un URL gia' costruito dall'API (`links.next`), byte per byte.
   *
   * Il cursore e' legato all'ordinamento della lista che l'ha emesso: rifarlo a
   * mano, o riusarlo su un'altra lista, e' cio' che l'API rifiuta con
   * `INVALID_CURSOR`.
   */
  follow<T>(absoluteUrl: string): Promise<T> {
    return this.request<T>(absoluteUrl);
  }

  private async request<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attempt<T>(url);
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryable(error)) throw error;
        const retryAfter = error instanceof RateLimitedError ? error.retryAfter : undefined;
        await timers.sleep(backoffMs(attempt, retryAfter));
      }
    }
  }

  private async attempt<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.apiKey !== undefined) headers['x-api-key'] = this.apiKey;

    const cached = this.etags?.get(url);
    if (cached !== undefined) headers['if-none-match'] = cached.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await this.doFetch(url, { method: 'GET', headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiTimeoutError(this.timeout, error);
      throw new ApiConnectionError(`Request to ${url} failed`, error);
    } finally {
      clearTimeout(timer);
    }

    this.lastResponse = toResponseInfo(url, response);
    this.onResponse?.(this.lastResponse);

    // 304: il corpo e' vuoto per definizione, la risposta e' quella in cache.
    if (response.status === 304 && cached !== undefined) return cached.body as T;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10);
      const body = await readErrorBody(response);
      throw toApiError(response.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }

    const body = (await response.json()) as T;

    const etag = response.headers.get('etag');
    if (this.etags !== null && etag !== null) this.etags.set(url, { etag, body });

    return body;
  }
}

/**
 * Un 5xx puo' arrivare da un proxy davanti all'API, quindi in HTML: se il
 * corpo non e' il nostro envelope si costruisce un errore comunque, invece di
 * far esplodere il parser e nascondere lo status vero.
 */
async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const parsed = (await response.json()) as { error?: ApiErrorBody };
    if (parsed.error !== undefined && typeof parsed.error.code === 'string') return parsed.error;
  } catch {
    /* cade sotto */
  }
  return {
    code: `HTTP_${response.status}`,
    message: response.statusText === '' ? `HTTP ${response.status}` : response.statusText,
  };
}

/**
 * Una pagina che e' anche un iteratore.
 *
 * `for await (const card of await client.cards.list(...))` cammina l'intera
 * collezione seguendo `links.next`, senza che il chiamante veda mai un cursore.
 * E' il motivo per cui vale la pena usare l'SDK invece di `fetch`: la
 * paginazione a cursore e' corretta ma noiosa, ed e' il punto in cui le
 * integrazioni scritte a mano perdono righe.
 */
export class Page<T> implements AsyncIterable<T> {
  readonly data: readonly T[];
  readonly meta: CollectionMeta;
  /** `links.next` com'e' arrivato, o `null` sull'ultima pagina. */
  readonly nextUrl: string | null;
  private readonly http: HttpClient;

  constructor(http: HttpClient, body: Collection<T>) {
    this.http = http;
    this.data = body.data;
    this.meta = body.meta;
    const next = body.links?.next;
    this.nextUrl = typeof next === 'string' && next !== '' ? next : null;
  }

  get hasMore(): boolean {
    return this.nextUrl !== null;
  }

  /** La pagina dopo, o `null` dopo l'ultima. Chiede esattamente l'URL che l'API ha restituito. */
  async nextPage(): Promise<Page<T> | null> {
    if (this.nextUrl === null) return null;
    const body = await this.http.follow<Collection<T>>(this.nextUrl);
    return new Page(this.http, body);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: Page<T> | null = this;
    while (page !== null) {
      for (const item of page.data) yield item;
      page = await page.nextPage();
    }
  }

  /**
   * Materializza in un array. `max` e' OBBLIGATORIO: il catalogo ha centinaia
   * di migliaia di carte, ogni pagina costa crediti, e un `toArray()` senza
   * tetto e' il modo piu' rapido di spenderli tutti per sbaglio.
   */
  async toArray({ max }: { max: number }): Promise<T[]> {
    const out: T[] = [];
    if (max <= 0) return out;
    for await (const item of this) {
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  }
}
