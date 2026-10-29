import { spafaxAdapter } from "./platforms/spafax.ts";

/** Spafax portal; bucket 46 is "All" (A-Z), ~400 movies, one page. */
export const lufthansa = spafaxAdapter({
  id: "lufthansa", name: "Lufthansa", portal: "https://www.lufthansa-inflightentertainment.com", code: "lh", bucket: 46,
});
