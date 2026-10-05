import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      // "/api/" rather than "/api", so the source file /api.ts is still served by Vite.
      "/api/": { target: "http://localhost:7777", changeOrigin: true, headers: { origin: "http://localhost:7777" } },
    },
  },
});
