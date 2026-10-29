import type { AirlineAdapter } from "./types.ts";
import { emirates } from "./emirates.ts";
import { united } from "./united.ts";
import { klm } from "./klm.ts";
import { ba } from "./ba.ts";
import { singapore } from "./singapore.ts";
import { lufthansa } from "./lufthansa.ts";
import { jal } from "./jal.ts";
import { cathay } from "./cathay.ts";
import { qantas } from "./qantas.ts";
import { ana } from "./ana.ts";

export const adapters: Record<string, AirlineAdapter> = Object.fromEntries(
  [emirates, united, klm, ba, singapore, lufthansa, jal, cathay, qantas, ana].map((a) => [a.id, a]),
);
