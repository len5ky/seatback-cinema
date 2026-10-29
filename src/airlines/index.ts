import type { AirlineAdapter } from "./types.ts";
import { emirates } from "./emirates.ts";
import { united } from "./united.ts";
import { klm } from "./klm.ts";

export const adapters: Record<string, AirlineAdapter> = Object.fromEntries(
  [emirates, united, klm].map((a) => [a.id, a]),
);
