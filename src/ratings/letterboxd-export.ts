import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { findCandidates, pickMatch, type Candidate, type Confidence, type MatchResult } from "../match.ts";
import { normalizeTitle } from "../text.ts";

/** Minimal zip reader (stored + deflate), enough for a Letterboxd export. Returns entry name -> UTF-8 text. */
export function readZip(buf: Uint8Array): Map<string, string> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, dec.decode(data));
    else if (method === 8) out.set(name, dec.decode(inflateRawSync(data)));
    else throw new Error(`${name}: unsupported zip compression method ${method}`);
  }
  return out;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF, leading BOM. Returns raw rows, header first, blank lines dropped. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** CSV as header-keyed records (see parseCsvRows). */
export function parseCsv(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsvRows(text);
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export interface ExportFilm { name: string; year: number | null; uri: string | null; rating: number | null; watched: boolean; watchlist: boolean }

/** Merge ratings.csv, watched.csv and watchlist.csv by name+year. Ratings move to a 10-point scale; a rating implies watched. */
export function parseExport(files: Map<string, string>): ExportFilm[] {
  const get = (base: string) => [...files.entries()].find(([k]) => k === base || k.endsWith(`/${base}`))?.[1];
  const films = new Map<string, ExportFilm>();
  const add = (file: string, apply: (f: ExportFilm, r: Record<string, string>) => void) => {
    const text = get(file);
    if (!text) return;
    for (const r of parseCsv(text)) {
      const name = r.Name?.trim();
      if (!name) continue;
      const year = Number(r.Year) || null;
      const key = `${normalizeTitle(name)}|${year ?? ""}`;
      const f = films.get(key) ?? { name, year, uri: r["Letterboxd URI"] || null, rating: null, watched: false, watchlist: false };
      apply(f, r);
      films.set(key, f);
    }
  };
  add("watched.csv", (f) => { f.watched = true; });
  add("ratings.csv", (f, r) => {
    const stars = Number(r.Rating);
    if (r.Rating && stars > 0 && stars <= 5) { f.rating = stars * 2; f.watched = true; }
  });
  add("watchlist.csv", (f) => { f.watchlist = true; });
  if (!films.size && !get("watched.csv") && !get("ratings.csv")) throw new Error("no ratings.csv / watched.csv / watchlist.csv found: is this a Letterboxd export?");
  return [...films.values()];
}

export const LETTERBOXD_DIR = "data/letterboxd";

/** The newest zip in data/letterboxd/, else the folder itself when it holds unzipped csvs. */
export function findLetterboxdExport(): string | undefined {
  const entries = existsSync(LETTERBOXD_DIR) ? readdirSync(LETTERBOXD_DIR).map((n) => `${LETTERBOXD_DIR}/${n}`) : [];
  const zips = entries.filter((e) => e.endsWith(".zip")).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return zips[0] ?? (entries.some((e) => e.endsWith(".csv")) ? LETTERBOXD_DIR : undefined);
}

/** Read an export zip or an unzipped export folder. With no path, the newest zip (or folder) in data/letterboxd/. */
export async function loadExport(path?: string): Promise<{ path: string; files: Map<string, string> }> {
  const p = path ?? findLetterboxdExport();
  if (!p) throw new Error(`no Letterboxd export found: drop the zip (Settings > Data > Export your data) into ${LETTERBOXD_DIR}/`);
  if (!existsSync(p)) throw new Error(`${p} not found`);
  if (statSync(p).isDirectory()) {
    const files = new Map<string, string>();
    for (const n of readdirSync(p).filter((n) => n.endsWith(".csv"))) files.set(n, await Bun.file(`${p}/${n}`).text());
    return { path: p, files };
  }
  return { path: p, files: readZip(new Uint8Array(await Bun.file(p).arrayBuffer())) };
}

/**
 * Name+year through the catalogue matcher. A personal log almost always means the well-known film, so when the matcher
 * calls two same-year namesakes ambiguous, the one with 20x the votes wins at medium ("Aftersun" 2022: 134k vs 43 votes).
 */
export function matchUserFilm(name: string, year: number | null, candidates: Candidate[], viaVariant: boolean): MatchResult {
  const m = pickMatch({ cleanTitle: name, year, duration: null, director: null }, candidates, undefined, viaVariant);
  if (m.confidence !== "low" || !year || viaVariant) return m;
  const sameYear = candidates.filter((c) => c.startYear !== null && Math.abs(c.startYear - year) <= 1).sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
  const [top, next] = sameYear;
  if (top && (!next || (top.votes ?? 0) >= 20 * Math.max(next.votes ?? 0, 1)))
    return { tconst: top.tconst, confidence: "medium", score: m.score, reasons: [`year ${top.startYear}`, `most-voted namesake (${top.votes} votes)`] };
  return m;
}

export interface ImportResult { films: number; rated: number; watched: number; watchlist: number; matched: Record<Confidence, number>; unmatched: string[] }

/** Replace the Letterboxd rows of user_films. Matches name+year with the catalogue matcher; only high/medium matches get a tconst. */
export function importExport(db: Database, films: ExportFilm[], now = new Date().toISOString()): ImportResult {
  const r: ImportResult = { films: films.length, rated: 0, watched: 0, watchlist: 0, matched: { high: 0, medium: 0, low: 0, none: 0 }, unmatched: [] };
  const ins = db.prepare("INSERT INTO user_films VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    db.run("DELETE FROM user_films WHERE source = 'letterboxd'");
    for (const f of films) {
      const { candidates, viaVariant } = findCandidates(db, f.name, { year: f.year });
      const m = matchUserFilm(f.name, f.year, candidates, viaVariant);
      const ok = m.confidence === "high" || m.confidence === "medium";
      r.matched[m.confidence]++;
      if (!ok) r.unmatched.push(`${f.name} (${f.year ?? "?"})`);
      if (f.rating !== null) r.rated++;
      if (f.watched) r.watched++;
      if (f.watchlist) r.watchlist++;
      ins.run(ok ? m.tconst : null, f.name, f.year, f.rating, f.watched ? 1 : 0, f.watchlist ? 1 : 0, "letterboxd", now);
    }
  })();
  return r;
}
