import tailwind from "@astrojs/tailwind";
import htmx from "astro-htmx";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [tailwind(), htmx()],
});
