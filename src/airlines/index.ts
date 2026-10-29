import type { AirlineAdapter } from "./types.ts";
import { emirates } from "./emirates.ts";
import { united } from "./united.ts";
import { klm } from "./klm.ts";
import { ba } from "./ba.ts";
import { singapore } from "./singapore.ts";

export const adapters: Record<string, AirlineAdapter> = Object.fromEntries(
  [emirates, united, klm, ba, singapore].map((a) => [a.id, a]),
);
