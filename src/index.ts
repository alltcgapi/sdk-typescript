import { HttpClient, Page, segment, type ClientOptions, type ResponseInfo } from './client.js';
import type {
  Card,
  CardListParams,
  CardSet,
  CatalogStatus,
  Collection,
  CurrentPrices,
  Game,
  Health,
  Plan,
  PriceCoverage,
  PriceHistory,
  PriceHistoryParams,
  PriceParams,
  PriceSource,
  Quote,
  Reference,
  SealedListParams,
  SealedProduct,
  SetCardsParams,
  SetListParams,
} from './types.js';

export * from './errors.js';
export * from './types.js';
export { Page, DEFAULT_BASE_URL } from './client.js';
export type { ClientOptions, ResponseInfo } from './client.js';
export { VERSION } from './version.js';

/** Quanti id accetta `prices.current` in una chiamata: il tetto dell'API. */
export const MAX_CURRENT_IDS = 25;

/** Le risposte con l'envelope `data` e nient'altro. */
interface Envelope<T> {
  readonly data: T;
}

/**
 * Client di alltcgapi.com: diciannove giochi, una chiave, una forma di risposta.
 *
 * Le risorse rispecchiano i path (`client.cards.get`, `client.sets.cards`) cosi'
 * che passare dalla documentazione al codice non richieda una tabella di
 * conversione. Ogni metodo di lista torna una `Page`, che e' anche un
 * `AsyncIterable`: si itera e la paginazione sparisce. I metodi che leggono un
 * oggetto solo tolgono l'envelope `data` e restituiscono l'oggetto.
 *
 * ```ts
 * const client = new AllTcgApi({ apiKey: process.env.ALLTCG_API_KEY });
 *
 * const page = await client.cards.list({ game: 'yugioh', number: 'MAMS-EN001' });
 * console.log(page.data[0]?.name);
 *
 * for await (const card of await client.sets.cards('OP01')) {
 *   console.log(card.number, card.name);
 * }
 * ```
 */
export class AllTcgApi {
  private readonly http: HttpClient;

  readonly games: GamesResource;
  readonly sets: SetsResource;
  readonly cards: CardsResource;
  readonly sealed: SealedResource;
  readonly prices: PricesResource;
  readonly reference: ReferenceResource;

  constructor(options: ClientOptions = {}) {
    this.http = new HttpClient(options);
    this.games = new GamesResource(this.http);
    this.sets = new SetsResource(this.http);
    this.cards = new CardsResource(this.http);
    this.sealed = new SealedResource(this.http);
    this.prices = new PricesResource(this.http);
    this.reference = new ReferenceResource(this.http);
  }

  /**
   * Gli header dell'ultima risposta: crediti, quota rimasta, ritmo. Con
   * richieste concorrenti e' l'ultima arrivata: per contarle tutte si usa
   * `onResponse` nelle opzioni.
   */
  get lastResponse(): ResponseInfo | null {
    return this.http.lastResponse;
  }

  /** Il listino (`/v1/billing/plans`). Pubblica: nessuna chiave, nessun credito. */
  async plans(): Promise<readonly Plan[]> {
    return (await this.http.get<Envelope<readonly Plan[]>>('/v1/billing/plans')).data;
  }

  /** Quando e' finito l'ultimo aggiornamento, per corsia. Pubblica. */
  async status(): Promise<CatalogStatus> {
    return (await this.http.get<Envelope<CatalogStatus>>('/v1/status')).data;
  }

  /**
   * Processo vivo e database raggiungibile. Pubblica. Un servizio degradato
   * risponde 503, che qui diventa `ServerError` dopo i ritentativi.
   */
  health(): Promise<Health> {
    return this.http.get<Health>('/v1/health');
  }
}

class GamesResource {
  constructor(private readonly http: HttpClient) {}

  /** I giochi con i conteggi. L'`id` e' il valore di `game=` ovunque. 1 credito. */
  async list(): Promise<readonly Game[]> {
    return (await this.http.get<Envelope<readonly Game[]>>('/v1/games')).data;
  }
}

class SetsResource {
  constructor(private readonly http: HttpClient) {}

  /** I set, dal piu' recente. `region` distingue la linea occidentale (`WEST`) da quella asiatica (`EAST`). 1 credito. */
  async list(params: SetListParams = {}): Promise<Page<CardSet>> {
    return new Page(this.http, await this.http.get<Collection<CardSet>>('/v1/sets', params));
  }

  /** Un set per uuid o per codice (`OP01`, `YGO-MAMS`), con i nomi per lingua. 1 credito. */
  async get(idOrCode: string): Promise<CardSet> {
    return (await this.http.get<Envelope<CardSet>>(`/v1/sets/${segment(idOrCode)}`)).data;
  }

  /** Le carte di un set, in ordine di numero. 1 credito ogni 50 righe chieste. */
  async cards(idOrCode: string, params: SetCardsParams = {}): Promise<Page<Card>> {
    return new Page(this.http, await this.http.get<Collection<Card>>(`/v1/sets/${segment(idOrCode)}/cards`, params));
  }
}

class CardsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Le carte del catalogo, filtrate. `number` e' esatto, come stampato
   * (`MAMS-EN001`); `name` e' un prefisso. 1 credito ogni 50 righe chieste.
   */
  async list(params: CardListParams = {}): Promise<Page<Card>> {
    return new Page(this.http, await this.http.get<Collection<Card>>('/v1/cards', params));
  }

  /** Una carta per id, con i nomi per lingua. 1 credito. */
  async get(id: string): Promise<Card> {
    return (await this.http.get<Envelope<Card>>(`/v1/cards/${segment(id)}`)).data;
  }
}

/** Prodotti sigillati: booster box, starter deck, collezioni. */
class SealedResource {
  constructor(private readonly http: HttpClient) {}

  /** 1 credito ogni 50 righe chieste. */
  async list(params: SealedListParams = {}): Promise<Page<SealedProduct>> {
    return new Page(this.http, await this.http.get<Collection<SealedProduct>>('/v1/sealed', params));
  }

  /** 1 credito. */
  async get(id: string): Promise<SealedProduct> {
    return (await this.http.get<Envelope<SealedProduct>>(`/v1/sealed/${segment(id)}`)).data;
  }
}

/**
 * Le quotazioni correnti e il loro storico. Ogni riga dice da dove viene
 * (`source`), cosa misura (`variant`) e di che giorno e' (`as_of`, `date`);
 * importo e valuta stanno sempre insieme e non vengono convertiti.
 */
class PricesResource {
  constructor(private readonly http: HttpClient) {}

  /** Le quotazioni correnti di una carta. 2 crediti. Una carta senza prezzi e' una lista vuota, non un 404. */
  async card(id: string, params: PriceParams = {}): Promise<readonly Quote[]> {
    return (await this.http.get<Envelope<readonly Quote[]>>(`/v1/cards/${segment(id)}/prices`, params)).data;
  }

  /** Le quotazioni correnti di un sigillato. 2 crediti. */
  async sealed(id: string, params: PriceParams = {}): Promise<readonly Quote[]> {
    return (await this.http.get<Envelope<readonly Quote[]>>(`/v1/sealed/${segment(id)}/prices`, params)).data;
  }

  /**
   * Le quotazioni correnti di piu' articoli in una chiamata, carte e sigillati
   * insieme: 4 crediti qualunque sia il numero di id, fino a `MAX_CURRENT_IDS`.
   * Un id che l'API non conosce manca da `data` senza far fallire gli altri:
   * `meta.requested` e `meta.found` dicono quanti ne mancano.
   */
  async current(ids: readonly string[], params: PriceParams = {}): Promise<CurrentPrices> {
    // Senza id non c'e' niente da chiedere: l'API risponderebbe 400.
    if (ids.length === 0) return { data: [], meta: { requested: 0, found: 0 } };
    if (ids.length > MAX_CURRENT_IDS) {
      throw new RangeError(`prices.current() accepts at most ${MAX_CURRENT_IDS} ids, received ${ids.length}. Chunk the list.`);
    }
    return this.http.get<CurrentPrices>('/v1/prices/current', { ids: ids.join(','), ...params });
  }

  /**
   * Lo storico di una carta: un punto per serie per giorno, o per settimana o
   * mese con `bucket`. 5 crediti. Senza date sono gli ultimi 90 giorni. Oltre
   * i giorni che il piano legge la risposta non e' un errore: arriva piu'
   * corta, e `meta.truncated` lo dice.
   */
  cardHistory(id: string, params: PriceHistoryParams = {}): Promise<PriceHistory> {
    return this.http.get<PriceHistory>(`/v1/cards/${segment(id)}/prices/history`, params);
  }

  /** Lo storico di un sigillato, con le stesse regole di `cardHistory`. 5 crediti. */
  sealedHistory(id: string, params: PriceHistoryParams = {}): Promise<PriceHistory> {
    return this.http.get<PriceHistory>(`/v1/sealed/${segment(id)}/prices/history`, params);
  }

  /** Le fonti che l'API serve, col ritardo di ciascuna. Pubblica. */
  async sources(): Promise<readonly PriceSource[]> {
    return (await this.http.get<Envelope<readonly PriceSource[]>>('/v1/prices/sources')).data;
  }

  /** Per gioco e fonte, quanti articoli hanno una quotazione. Pubblica. */
  async coverage(): Promise<readonly PriceCoverage[]> {
    return (await this.http.get<Envelope<readonly PriceCoverage[]>>('/v1/prices/coverage')).data;
  }
}

/**
 * I vocabolari chiusi, per popolare i filtri di una UI senza indovinare le
 * stringhe. Una sola richiesta per istanza del client, qualunque metodo si
 * chiami e quante volte: la risposta e' la stessa per tutti.
 */
class ReferenceResource {
  constructor(private readonly http: HttpClient) {}

  private pending: Promise<Reference> | null = null;

  /** Tutti i vocabolari in una volta. Pubblica. */
  all(): Promise<Reference> {
    // La promise, non il valore: due chiamate ravvicinate condividono una
    // richiesta sola. Un errore la libera, cosi' la chiamata dopo riprova.
    this.pending ??= this.http.get<Envelope<Reference>>('/v1/reference').then(
      (body) => body.data,
      (error: unknown) => {
        this.pending = null;
        throw error;
      },
    );
    return this.pending;
  }

  /** Un vocabolario per nome; uno sconosciuto e' una lista vuota. */
  async values(key: string): Promise<readonly string[]> {
    return (await this.all())[key] ?? [];
  }

  regions(): Promise<readonly string[]> {
    return this.values('regions');
  }

  locales(): Promise<readonly string[]> {
    return this.values('locales');
  }

  currencies(): Promise<readonly string[]> {
    return this.values('currencies');
  }
}

export default AllTcgApi;
