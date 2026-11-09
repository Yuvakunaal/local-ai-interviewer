/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server: Vite on 3000 proxying /api to the FastAPI backend on 8000 (see ./start.sh --dev).
// Production: `vite build` output is served by FastAPI itself on 127.0.0.1:3000.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/__tests__/setup.ts"] },
});
