// PWA 可安装性兼容（#7 真机实测返工）：2024 年中之前的 Android Chrome（约 <126）
// 要求「已注册 SW 且带 fetch handler」才判定站点可安装；国内环境 Chrome 更新滞后，
// 这台主设备手机正卡在该判定上。此 SW 只为过安装检查——不做离线缓存（离线终端
// 无意义，#7 决策不变）：fetch handler 不调 respondWith，请求走浏览器默认网络路径，
// WebSocket 不经过 SW。浏览器对 SW 脚本默认绕过 HTTP 缓存，部署新版即时生效。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
