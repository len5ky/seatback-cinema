import { airtimeAdapter } from "./platforms/geemedia.ts";

// entertainment.klm.com; the Movies section id may change between cycles (see AirtimeConfig.sectionId)
export const klm = airtimeAdapter({ id: "klm", name: "KLM", hostId: "43d8142f-3fee-4896-9c2d-6e2eca1f583f", sectionId: "23300252" });
