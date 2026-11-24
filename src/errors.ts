/**
 * Gerarchia degli errori.
 *
 * Sottoclassi e non un solo tipo con un campo `code`, per una ragione pratica:
 * chi integra scrive `catch (e) { if (e instanceof RateLimitedError) ... }`, e
 * con un tipo solo dovrebbe confrontare stringhe, cioe' riscrivere a mano la
 * tassonomia che noi conosciamo gia', sbagliando i nomi.
 *
 * Tre errori sembrano lo stesso e si trattano in modo opposto:
 *
 * - `RateLimitedError` (429 `RATE_LIMITED`, `CONCURRENCY_LIMIT`) passa
 *   aspettando `Retry-After`: il client riprova da solo.
 * - `QuotaExceededError` (429 `QUOTA_EXCEEDED`) non passa aspettando qualche
 *   secondo: il `Retry-After` che lo accompagna e' fino a mezzanotte UTC o al
 *   rinnovo. Il client non riprova mai.
 * - `TrialExpiredError` (403 `TRIAL_EXPIRED`) non passa mai: i crediti della
 *   prova non tornano, serve un piano. Il client non riprova mai.
 */

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly request_id?: string;
}

export class AllTcgApiError extends Error {
  /** Codice stabile della tassonomia, es. `CARD_NOT_FOUND`. Si fa switch su questo, non sul messaggio. */
  readonly code: string;
  readonly status: number;
  /**
   * Sempre valorizzato quando la risposta e' passata dall'API: e' l'unica cosa
   * che il supporto puo' cercare nei log. Va incluso in ogni segnalazione.
   */
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = new.target.name;
    this.code = body.code;
    this.status = status;
    this.requestId = body.request_id;
    this.details = body.details;
  }

  /** `details.param`: il parametro che l'API ha rifiutato, quando lo nomina. */
  get param(): string | undefined {
    const value = this.details?.['param'];
    return typeof value === 'string' ? value : undefined;
  }
}

/** 401 — chiave assente, malformata, revocata o scaduta. */
export class AuthenticationError extends AllTcgApiError {}

/** 403 — la chiave e' valida ma non puo' fare questa cosa (`INSUFFICIENT_SCOPE`). */
export class PermissionDeniedError extends AllTcgApiError {}

/**
 * 403 `TRIAL_EXPIRED` — gli 800 crediti della prova sono finiti e non si
 * rinnovano. Non passa aspettando ne' riprovando: serve un piano
 * (`client.plans()`, o `details.plans`).
 */
export class TrialExpiredError extends PermissionDeniedError {}

/** 404, o un codice che finisce in `_NOT_FOUND`. Non e' un errore di rete: non si riprova. */
export class NotFoundError extends AllTcgApiError {}

/** 400 — la richiesta e' sbagliata: un parametro sconosciuto, ripetuto, fuori vocabolario. */
export class InvalidRequestError extends AllTcgApiError {}

/** 429 `RATE_LIMITED` o `CONCURRENCY_LIMIT`: passa aspettando. */
export class RateLimitedError extends AllTcgApiError {
  /** Secondi da aspettare, dall'header `Retry-After`, se c'era. */
  readonly retryAfter: number | undefined;

  constructor(status: number, body: ApiErrorBody, retryAfter?: number) {
    super(status, body);
    this.retryAfter = retryAfter;
  }
}

/** 429 `QUOTA_EXCEEDED`: tetto giornaliero o crediti del periodo finiti. Non si riprova. */
export class QuotaExceededError extends AllTcgApiError {}

/** 5xx, compreso 503 `METER_UNAVAILABLE`, che e' transitorio e si riprova. */
export class ServerError extends AllTcgApiError {}

/** La richiesta non ha avuto risposta: DNS, TLS, socket. */
export class ApiConnectionError extends Error {
  /** `override` perche' Error dichiara gia' `cause` da ES2022. */
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ApiConnectionError';
    this.cause = cause;
  }
}

/** La richiesta e' stata abbandonata da noi dopo `timeout`. */
export class ApiTimeoutError extends ApiConnectionError {
  constructor(timeoutMs: number, cause: unknown) {
    super(`Request timed out after ${timeoutMs}ms`, cause);
    this.name = 'ApiTimeoutError';
  }
}

/**
 * Dal corpo dell'errore alla classe giusta.
 *
 * Si guarda PRIMA il `code` e poi lo status: lo status dice la famiglia, il
 * code dice il caso, e il caso che conta di piu' (ritmo contro quota)
 * condivide lo stesso status.
 */
export function toApiError(status: number, body: ApiErrorBody, retryAfter?: number): AllTcgApiError {
  const code = body.code;

  if (code === 'QUOTA_EXCEEDED') return new QuotaExceededError(status, body);
  if (code === 'TRIAL_EXPIRED') return new TrialExpiredError(status, body);
  if (status === 429) return new RateLimitedError(status, body, retryAfter);
  if (status === 401) return new AuthenticationError(status, body);
  if (status === 403) return new PermissionDeniedError(status, body);
  if (status === 404 || code.endsWith('_NOT_FOUND')) return new NotFoundError(status, body);
  if (status >= 500) return new ServerError(status, body);
  if (status >= 400) return new InvalidRequestError(status, body);

  return new AllTcgApiError(status, body);
}
