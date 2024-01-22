import tailwind from "@astrojs/tailwind";
import htmx from "astro-htmx";
import { defineConfig } from "astro/config";

import vercel from "@astrojs/vercel/serverless";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [tailwind(), htmx()],
  adapter: vercel()
});