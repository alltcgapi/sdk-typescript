/**
 * I tipi delle risposte, scritti a mano campo per campo e nello stesso ordine
 * di `goapi/internal/catalog/render.go`, `goapi/internal/prices` e
 * `goapi/internal/meta`. Python e Go li ricopiano da qui: un campo che cambia
 * in questo file cambia negli altri due nella stessa PR.
 *
 * Un campo nullable e' `T | null`, mai opzionale: il servizio scrive sempre la
 * chiave, e `null` dice "non lo sappiamo", che e' un'informazione. Gli unici
 * opzionali sono `names` (solo nel dettaglio) e `total_count` (solo dove esiste
 * davvero un conteggio).
 */

/** Gli id di `/v1/games`: sono il valore di `game=` ovunque. */
export type GameId =
  | 'battlespirits'
  | 'cyberpunk'
  | 'digimon'
  | 'dragoborne'
  | 'dragonball-fw'
  | 'dragonball-masters'
  | 'fab'
  | 'fftcg'
  | 'fow'
  | 'gundam'
  | 'lorcana'
  | 'onepiece'
  | 'pokemon'
  | 'riftbound'
  | 'swdestiny'
  | 'swu'
  | 'vanguard'
  | 'weissschwarz'
  | 'yugioh';

/** I diciannove giochi, nell'ordine di `/v1/games`. */
export const GAME_IDS: readonly GameId[] = [
  'battlespirits',
  'cyberpunk',
  'digimon',
  'dragoborne',
  'dragonball-fw',
  'dragonball-masters',
  'fab',
  'fftcg',
  'fow',
  'gundam',
  'lorcana',
  'onepiece',
  'pokemon',
  'riftbound',
  'swdestiny',
  'swu',
  'vanguard',
  'weissschwarz',
  'yugioh',
];

/**
 * Una stringa libera resta ammessa accanto all'unione: un gioco aggiunto al
 * servizio funziona subito, prima di una release dell'SDK. `(string & {})`
 * tiene vivo l'autocompletamento dei valori noti.
 */
export type GameParam = GameId | (string & {});

/** La linea di stampa di un set: occidentale o asiatica. */
export type Region = 'WEST' | 'EAST';

/** Il denaro: importo e valuta sempre nello stesso oggetto, mai convertiti. */
export interface Money {
  readonly amount: number;
  /** ISO 4217. */
  readonly currency: string;
}

/** Gli id dei marketplace: il ponte verso l'inventario che hai gia'. */
export interface ExternalIds {
  readonly cardmarket: number | null;
  readonly tcgplayer: number | null;
}

export interface Game {
  /** Il valore da passare come `game=`. */
  readonly id: GameParam;
  readonly name: string;
  readonly sets: number;
  readonly cards: number;
  readonly sealed: number;
}

export interface CardSet {
  readonly id: string;
  readonly game: GameParam;
  readonly code: string;
  readonly slug: string | null;
  readonly name: string;
  /** Il nome per lingua (`{ ja: '…' }`). Solo nel dettaglio; `{}` se non ce ne sono. */
  readonly names?: Readonly<Record<string, string>>;
  readonly region: Region;
  /** `YYYY-MM-DD`. */
  readonly release_date: string | null;
  readonly total_cards: number | null;
  readonly printed_cards: number | null;
  readonly image_url: string | null;
  readonly languages: readonly string[];
  /** Si muove solo quando cambiano i dati dell'oggetto. */
  readonly version: number;
  readonly updated_at: string;
}

/** Il set dentro una carta. */
export interface CardSetRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface Card {
  /** Stabile: non cambia e non viene mai riusato. */
  readonly id: string;
  readonly game: GameParam;
  readonly set: CardSetRef;
  /** Il numero come e' stampato: `OP01-001`, `MAMS-EN001`. */
  readonly number: string;
  readonly name: string;
  /** Il nome per lingua. Solo nel dettaglio; `{}` se non ce ne sono. */
  readonly names?: Readonly<Record<string, string>>;
  readonly rarity: string | null;
  readonly supertype: string | null;
  /** I dati di regolamento del gioco: un oggetto solo per tutti, chiavi diverse per gioco. */
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly image_url: string | null;
  readonly languages: readonly string[];
  readonly external_ids: ExternalIds;
  readonly version: number;
  readonly updated_at: string;
}

/** Il set dentro un sigillato: il codice puo' mancare. */
export interface SealedSetRef {
  readonly id: string;
  readonly code: string | null;
}

export interface SealedProduct {
  readonly id: string;
  readonly game: GameParam | null;
  readonly set: SealedSetRef | null;
  readonly sku: string;
  /** `BOOSTER_BOX` e simili. */
  readonly kind: string;
  readonly name: string;
  readonly image_url: string | null;
  readonly release_date: string | null;
  readonly pack_count: number | null;
  readonly languages: readonly string[];
  readonly external_ids: ExternalIds;
  readonly version: number;
  readonly updated_at: string;
}

/**
 * Una serie di prezzi: una fonte, una variante, una lingua, una condizione,
 * una stampa, una regione, e l'importo nella sua valuta. E' la parte che una
 * quotazione corrente (`Quote`) e un punto dello storico (`PricePoint`) hanno
 * in comune.
 */
export interface PriceSeries {
  /** `CARDMARKET`, `TCGPLAYER`: `prices.sources()` dice quali sono servite. */
  readonly source: string;
  /** Cosa misura il numero: `LOWEST_NEAR_MINT`, `LOWEST`, `MARKET`, `TREND`, `AVG_7D`, `AVG_30D`. */
  readonly variant: string;
  readonly language: string;
  readonly condition: string | null;
  readonly printing: string | null;
  readonly region: string | null;
  /** `true` quando la fonte ha contato solo i venditori dell'Unione Europea. */
  readonly eu_only: boolean;
  readonly price: Money;
}

/**
 * Una quotazione corrente: una serie e il giorno in cui la fonte l'ha quotata
 * l'ultima volta. Una carta ne ha di solito piu' d'una: l'API le restituisce
 * tutte e non le fonde in un numero.
 */
export interface Quote extends PriceSeries {
  /** Un giorno, `YYYY-MM-DD` in UTC: non un istante. */
  readonly as_of: string;
}

/** Un punto dello storico: il prezzo di una serie in un giorno (o nella settimana o nel mese che comincia quel giorno). */
export interface PricePoint extends PriceSeries {
  /** `YYYY-MM-DD` in UTC. */
  readonly date: string;
}

export interface PriceHistoryMeta {
  readonly id: string;
  /** `card` o `sealed`. */
  readonly kind: string;
  /** La finestra servita, che puo' essere piu' corta di quella chiesta: vedi `truncated`. */
  readonly from: string;
  readonly to: string;
  readonly bucket: 'day' | 'week' | 'month' | (string & {});
  readonly count: number;
  /** `true` quando il piano ha accorciato la finestra chiesta. Il rimedio e' un piano con piu' giorni. */
  readonly truncated: boolean;
  /** `true` quando la serie era troppo lunga per una risposta. Il rimedio e' `bucket: 'week'` o una finestra piu' corta. */
  readonly capped: boolean;
  /** I giorni di storico che il piano legge; `null` = tutto lo storico. */
  readonly plan_window_days: number | null;
}

/** `prices.cardHistory` e `prices.sealedHistory`: i punti e cio' che il piano ne ha fatto. */
export interface PriceHistory {
  readonly data: readonly PricePoint[];
  readonly meta: PriceHistoryMeta;
}

/** Un articolo di `prices.current`, con le sue quotazioni correnti. */
export interface CurrentPricesItem {
  readonly id: string;
  /** `card` o `sealed`. */
  readonly kind: string;
  readonly quotes: readonly Quote[];
}

/** `prices.current`: un id che l'API non conosce manca da `data`, e `meta` dice quanti ne mancano. */
export interface CurrentPrices {
  readonly data: readonly CurrentPricesItem[];
  readonly meta: { readonly requested: number; readonly found: number };
}

export interface PriceSource {
  readonly code: string;
  readonly label: string;
  /** Di quante ore e' in ritardo cio' che l'API serve rispetto alla fonte. */
  readonly delay_hours: number;
  /** Dopo quanti giorni senza osservazioni un prezzo smette di essere servito come corrente. Lo storico lo conserva. */
  readonly max_age_days: number;
}

/** Per gioco e fonte: quanti articoli hanno una quotazione, e il giorno della piu' recente. */
export interface PriceCoverage {
  readonly game: GameParam;
  readonly source: string;
  readonly cards: number;
  readonly sealed: number;
  /** Un giorno, `YYYY-MM-DD` in UTC. */
  readonly as_of: string;
}

export interface Plan {
  readonly code: string;
  readonly label: string;
  /** `null` dove il prezzo e' a contratto o il periodo non esiste. */
  readonly price_month: Money | null;
  readonly price_year: Money | null;
  /** Crediti del periodo; `null` = illimitati. */
  readonly credits: number | null;
  /** `false` sulla prova: i suoi crediti non tornano. */
  readonly renews: boolean;
  readonly daily_cap: number | null;
  readonly rate_limit_rps: number;
  readonly rate_limit_rpm: number;
  readonly max_keys: number;
  readonly history_days: number | null;
}

export interface RefreshLane {
  readonly lane: string;
  readonly finished_at: string;
  readonly rows: number;
}

/** `/v1/status`: quanto e' fresco cio' che l'API serve. */
export interface CatalogStatus {
  readonly version: string;
  readonly refresh: readonly RefreshLane[];
}

/** `/v1/health`. Non ha l'envelope `data`: e' la risposta di un monitor. */
export interface Health {
  readonly status: 'ok' | 'degraded' | (string & {});
  readonly db: boolean;
  readonly uptime_s: number;
  readonly version: string;
}

/** `/v1/reference`: i vocabolari chiusi (`regions`, `locales`, `currencies`, `scopes`). */
export type Reference = Readonly<Record<string, readonly string[]>>;

export interface CollectionMeta {
  readonly limit: number;
  readonly count: number;
  /** Solo dove il servizio conta davvero: un COUNT(*) su ogni pagina costerebbe piu' della pagina. */
  readonly total_count?: number;
  readonly has_more: boolean;
}

export interface Collection<T> {
  readonly data: readonly T[];
  readonly meta: CollectionMeta;
  readonly links: { readonly next: string | null };
}

/** Parametri comuni delle liste. */
export interface PageParams {
  /** 1–250, default 50. Oltre 250 e' un 400 `LIMIT_EXCEEDED`, mai un troncamento. Costa 1 credito ogni 50 righe CHIESTE. */
  readonly limit?: number;
  /** Il cursore di un `links.next` precedente, tale e quale. `Page` lo segue da sola. */
  readonly cursor?: string;
}

export interface SetListParams extends PageParams {
  readonly game?: GameParam;
  readonly region?: Region;
}

export interface CardListParams extends PageParams {
  readonly game?: GameParam;
  /** Id o codice di un set. */
  readonly set?: string;
  /** Prefisso del nome. */
  readonly name?: string;
  /** Il numero esatto, come stampato. */
  readonly number?: string;
}

export interface SetCardsParams extends PageParams {
  readonly name?: string;
  readonly number?: string;
}

export interface SealedListParams extends PageParams {
  readonly game?: GameParam;
  readonly set?: string;
  readonly kind?: string;
}

export interface PriceParams {
  /** Una fonte sola. Una fonte sconosciuta e' un 400 che elenca quelle disponibili. */
  readonly source?: string;
  /** Una lingua sola: `en`, `ja`. */
  readonly language?: string;
  /** Una variante sola: `MARKET`, `TREND`, `LOWEST_NEAR_MINT`. */
  readonly variant?: string;
}

export interface PriceHistoryParams extends PriceParams {
  /** Il primo giorno, `YYYY-MM-DD` in UTC. Senza `from` e `to`: gli ultimi 90 giorni. */
  readonly from?: string;
  /** L'ultimo giorno, `YYYY-MM-DD` in UTC. */
  readonly to?: string;
  /** `day` (il default), `week` o `month`: settimane e mesi portano la mediana dei loro giorni. */
  readonly bucket?: 'day' | 'week' | 'month';
}
