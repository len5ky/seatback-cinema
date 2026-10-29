import { spafaxAdapter } from "./platforms/spafax.ts";

/** Spafax portal; bucket 15 is "All Movies". The list is empty without flightSystem=NEXT-INT. */
export const jal = spafaxAdapter({
  id: "jal", name: "Japan Airlines", portal: "https://international.entertainment.jal.com", code: "jl", bucket: 15,
  flightSystem: "NEXT-INT",
});
