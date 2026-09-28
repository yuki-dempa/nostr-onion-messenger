import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      // 開発時はバックエンド (npm run server, :8787) へAPIとWSを中継
      "/api": "http://localhost:8787",
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
    watch: {
      ignored: ["**/server/**", "**/vendor/**", "**/data/**"],
    },
  },
}));
