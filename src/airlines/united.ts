import { airtimeAdapter } from "./platforms/geemedia.ts";

// unitedprivatescreening.com; host-id is the public guest value from the site's front end
export const united = airtimeAdapter({ id: "united", name: "United Airlines", hostId: "21f9eb1f-1701-49ae-80bb-6d11b3c13b10", sectionId: "22523841" });
