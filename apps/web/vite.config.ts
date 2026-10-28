import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const serverPort = Number(process.env.FME_SERVER_PORT ?? 3738);

export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: {
    alias: { "~": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: Number(process.env.PORT ?? 5738),
    strictPort: true,
    // Single origin in dev: the client always talks to /ws on the page's own host.
    proxy: {
      "/ws": { target: `http://127.0.0.1:${serverPort}`, ws: true },
      "/api": { target: `http://127.0.0.1:${serverPort}` },
    },
  },
});
