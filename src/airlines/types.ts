// src/airlines/types.ts
export interface CatalogueFilm {
  sourceId: string;          // airline's own id (trackList / id / mid / movie_airline_content_id)
  title: string;
  year?: number;
  runtime?: number;          // minutes
  directors: string[];
  cast: string[];
  genres: string[];
  rating?: string;           // airline's classification, e.g. PG13
  languages: string[];       // audio
  subtitles: string[];
  synopsis?: string;
  imdbId?: string;           // only AA has it
  poster?: string;
  categories: string[];      // airline shelves/sections the film sits in
  partial?: boolean;         // true when the source lists only highlights (Delta, Turkish)
}
export interface AirlineAdapter {
  id: string;                // 'emirates' | 'united' | 'klm' | 'ba' | 'singapore' | 'lufthansa' | 'jal' | 'cathay' | 'qantas' | 'ana' | 'american' | 'qatar' | 'delta'
  name: string;
  /** Fetch the raw payload(s) for a month (YYYY-MM); cache every HTTP response under cacheDir/<id>/<month>/ and reuse unless refresh. */
  fetchMonth(month: string, opts: { cacheDir: string; refresh?: boolean }): Promise<unknown>;
  /** Pure: raw payload -> deduped films. Unit-tested on the saved sample. */
  parse(raw: unknown): CatalogueFilm[];
}
