import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

// no-op SW（public/sw.js）：仅为老版 Android Chrome 的 PWA 安装判定，不做离线缓存
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

createRoot(document.getElementById("root")!).render(<App />);
