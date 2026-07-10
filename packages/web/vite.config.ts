import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // 局域网真机调试：手机访问 http://<LAN-IP>:5173，
    // WS 走同源 /ws 由 vite 代理到环回的 Hub（Hub 本身只监听 127.0.0.1，ADR-0003）
    host: true,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:7433",
        ws: true,
      },
    },
  },
});
