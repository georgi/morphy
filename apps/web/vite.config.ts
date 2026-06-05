import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // forward API calls to NestJS (global prefix "api", port 3001)
      "/api": "http://localhost:3001",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
});
