import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 日用 Hub 常驻 7433：开发/冒烟起第二个 Hub 时用 ZAGENT_HUB_PORT 指过去，互不打扰
const hubPort = process.env["ZAGENT_HUB_PORT"] ?? "7433";

export default defineConfig({
  plugins: [react()],
  server: {
    // 局域网真机调试：手机访问 http://<LAN-IP>:5173，
    // WS 走同源 /ws 由 vite 代理到环回的 Hub（Hub 本身只监听 127.0.0.1，ADR-0003）
    host: true,
    proxy: {
      "/ws": {
        target: `ws://127.0.0.1:${hubPort}`,
        ws: true,
      },
      "/auth": {
        target: `http://127.0.0.1:${hubPort}`,
      },
    },
  },
});
