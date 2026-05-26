import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const DEV_AGENT_PORT = Number(process.env.AUGGY_ADMIN_DEV_AGENT_PORT ?? 8081);

export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5174,
    strictPort: true,
    // Forward API + action POSTs + the agent-run SSE channel to the live
    // agent so the dev SPA hits real data without rebuilding. Bearer auth
    // flows through via the browser's saved credentials for the agent origin.
    proxy: {
      "/admin/api": { target: `http://localhost:${DEV_AGENT_PORT}`, changeOrigin: false },
      "/admin/action": { target: `http://localhost:${DEV_AGENT_PORT}`, changeOrigin: false },
      "/agent/run": { target: `http://localhost:${DEV_AGENT_PORT}`, changeOrigin: false },
    },
  },
});
