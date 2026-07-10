// WS 走同源 /ws：开发时由 vite 代理到环回 Hub，生产走隧道同样是同源形态
export const HUB_WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
