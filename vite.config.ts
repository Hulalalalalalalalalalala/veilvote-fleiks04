import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3414" } }
});
