// Worker entry: the bundle is built by `bun src/cli.ts export --worker` and inlined by wrangler at deploy time.
import catalogue from "../generated/catalogue.json";
import type { Bundle } from "../../src/bundle.ts";
import { createApp } from "./app.ts";

export default createApp(catalogue as unknown as Bundle);
