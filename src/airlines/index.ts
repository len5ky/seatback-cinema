import type { AirlineAdapter } from "./types.ts";
import { emirates } from "./emirates.ts";

export const adapters: Record<string, AirlineAdapter> = Object.fromEntries(
  [emirates].map((a) => [a.id, a]),
);
