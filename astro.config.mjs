import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  output: "server",
  session: false,

  adapter: cloudflare({
    imageService: "passthrough",
  }),

  vite: {
    plugins: [tailwindcss()],
  },
});
