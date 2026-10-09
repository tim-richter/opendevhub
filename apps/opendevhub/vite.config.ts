import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: { emptyOutDir: true, outDir: "../../dist/web" },
  plugins: [devtools(), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src/web", import.meta.url)) },
  },
  root: "src/web",
  server: {
    proxy: {
      // "/api/" rather than "/api", so the source file /api.ts is still served by Vite.
      "/api/": {
        changeOrigin: true,
        headers: { origin: "http://localhost:7777" },
        target: "http://localhost:7777",
        ws: true,
      },
    },
  },
});
