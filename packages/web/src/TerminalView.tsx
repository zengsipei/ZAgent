import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import {
  CONTROL_CHANNEL,
  base64ToBytes,
  parseHubMessage,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
  type ClientMessage,
} from "@zagent/protocol";

import { KeyBar, composeCtrl, keySequence, type CtrlState, type KeyId } from "./KeyBar.js";
import { HUB_WS_URL } from "./hubUrl.js";

const TERMINAL_FONT =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace';

// xterm 的 theme 只认 CSS 颜色字符串，这里是 styles.css 里 OKLCH token 的 sRGB 近似
const TERMINAL_THEME = {
  background: "#0d1517",
  foreground: "#e4ebeb",
  cursor: "#4fd0c4",
  cursorAccent: "#0d1517",
  selectionBackground: "#4fd0c455",
};

type StatusTone = "info" | "ok" | "error";

export function TerminalView({
  token,
  sessionId,
  onBack,
}: {
  token: string;
  sessionId: string;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [statusLine, setStatusLine] = useState<{ text: string; tone: StatusTone }>({
    text: "连接中…",
    tone: "info",
  });
  const [attached, setAttached] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [ctrl, setCtrl] = useState<CtrlState>("off");
  const ctrlRef = useRef<CtrlState>("off");
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);

  function updateCtrl(next: CtrlState): void {
    ctrlRef.current = next;
    setCtrl(next);
  }

  // 系统键盘弹起时 visualViewport 变矮：让 .app 跟着收缩，键条始终贴在键盘上方
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return;
    }
    const update = (): void => {
      document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      // iOS 聚焦输入框时会把页面往上顶，钉回去
      if (viewport.offsetTop > 0) {
        window.scrollTo(0, 0);
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: TERMINAL_FONT,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // 渲染走 WebGL（#13）：DOM 渲染器滚动时全视口重绘，移动端卡顿的主体。
    // 上下文创建失败或运行中丢失都降级回 DOM 渲染，行为不受影响
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }
    fit.fit();
    termRef.current = term;

    // 移动端键盘显式呼出（#13）：触摸永不聚焦，聚焦只走键条 ⌨ 键
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    // 键盘态跟随 xterm 隐藏 textarea 的焦点：⌨ 键点亮 = 系统键盘弹出
    const textarea = term.textarea;
    const onTaFocus = (): void => setKbOpen(true);
    const onTaBlur = (): void => setKbOpen(false);
    textarea?.addEventListener("focus", onTaFocus);
    textarea?.addEventListener("blur", onTaBlur);

    // 断线自动重连（ADR-0005：连接只是观察者，断开重连即恢复）。
    // disposed = 组件卸载；sessionExited = 会话已退出，二者都不再重连。
    let ws: WebSocket | null = null;
    let disposed = false;
    let sessionExited = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function sendMessage(message: ClientMessage): void {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(serializeEnvelope(message));
      }
    }

    function sendInput(data: string): void {
      sendMessage({
        channel: sessionChannel(sessionId),
        type: "input",
        payload: { data: utf8ToBase64(data) },
      });
    }
    sendInputRef.current = sendInput;

    // 容量上报（#10）：fit 计算出的本端最大 cols/rows 只上报给 Hub，
    // 不直接设置 xterm 网格——网格一律跟随 Hub 下发的会话尺寸（attached / resized）
    function reportCapacity(): void {
      const dims = fit.proposeDimensions();
      if (dims === undefined || !Number.isInteger(dims.cols) || !Number.isInteger(dims.rows)) {
        return;
      }
      if (dims.cols <= 0 || dims.rows <= 0) {
        return;
      }
      sendMessage({
        channel: CONTROL_CHANNEL,
        type: "resize",
        payload: { sessionId, cols: dims.cols, rows: dims.rows },
      });
    }

    function scheduleReconnect(): void {
      if (disposed || sessionExited || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      setStatusLine({ text: `连接断开，${Math.round(delay / 1000)} 秒后重连…`, tone: "error" });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed) {
        return;
      }
      setStatusLine({
        text: reconnectAttempt === 0 ? "连接中…" : `重连中…（第 ${reconnectAttempt} 次）`,
        tone: "info",
      });
      const socket = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
      ws = socket;

      socket.onopen = () => {
        sendMessage({ channel: CONTROL_CHANNEL, type: "attach", payload: { sessionId } });
      };
      socket.onmessage = (event) => {
        const message = parseHubMessage(String(event.data));
        if (message === null) {
          return;
        }
        if (message.type === "attached" && message.payload.sessionId === sessionId) {
          // 重连恢复：清掉旧画面再吃 ring buffer 重放，避免内容叠加；
          // 随后服务端 resize 抖动逼全屏 TUI 整屏重绘收敛。
          // 网格先切到会话当前尺寸，重放字节流才按正确坐标解释（#10）
          term.reset();
          term.resize(message.payload.cols, message.payload.rows);
          reconnectAttempt = 0;
          setStatusLine({ text: `已附加会话 ${sessionId}`, tone: "ok" });
          setAttached(true);
          reportCapacity();
          // 桌面点击聚焦无代价，attach 即聚焦；移动端聚焦=弹键盘，只走键条 ⌨ 键（#13）
          if (!coarsePointer) {
            term.focus();
          }
          return;
        }
        if (message.type === "error") {
          setStatusLine({ text: message.payload.message, tone: "error" });
          setAttached(false);
          return;
        }
        if (message.channel === sessionChannel(sessionId)) {
          if (message.type === "output") {
            term.write(base64ToBytes(message.payload.data));
          } else if (message.type === "resized") {
            // 会话有效尺寸变化（各端容量 min 重算）：跟随重建网格，
            // 小于本端容量时画面贴左上、余下留白
            term.resize(message.payload.cols, message.payload.rows);
          } else if (message.type === "exit") {
            sessionExited = true;
            setStatusLine({
              text: `会话已退出（exit ${message.payload.exitCode}），返回列表重开`,
              tone: "error",
            });
            setAttached(false);
          }
        }
      };
      socket.onclose = () => {
        if (disposed || sessionExited) {
          return;
        }
        setAttached(false);
        scheduleReconnect();
      };
    }

    connect();

    // 回前台/网络恢复时不等退避定时器：锁屏期间浏览器节流定时器且退避可能已攀升，
    // 直接清零重连。若 ws 自认 OPEN 但实际已死，onclose 稍后到达，用清零后的退避快速重试
    function reconnectNow(): void {
      if (disposed || sessionExited) {
        return;
      }
      reconnectAttempt = 0;
      if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        reconnectNow();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", reconnectNow);

    const dataListener = term.onData((data) => {
      let out = data;
      // Ctrl 粘滞时把系统键盘敲进来的字符合成为控制字节
      if (ctrlRef.current !== "off") {
        const composed = composeCtrl(data);
        if (composed !== null) {
          out = composed;
          if (ctrlRef.current === "once") {
            ctrlRef.current = "off";
            setCtrl("off");
          }
        }
      }
      sendInput(out);
    });
    // 窗口变化（转屏、键盘弹起收缩 --app-height）→ 重新上报本端容量；
    // 网格是否变化由 Hub 的 min 重算决定，不在本端直接 fit
    const observer = new ResizeObserver(() => reportCapacity());
    observer.observe(container);

    // 触摸滚动桥接（#11/#13）：xterm.js 不处理触摸手势，把竖向滑动映射为 scrollLines
    // （内容跟随手指：下拉看历史，上推回底部；未到整行的位移累积到下一次）。
    // 松手按末速度惯性续滚（#13）；全屏 TUI（alternate screen）无 scrollback 不滚动。
    // 关键（#13）：触摸序列一律 preventDefault 掉浏览器合成的 click，使触摸永不聚焦、
    // 永不弹系统键盘——键盘只由键条 ⌨ 键显式呼出。位移超过 TOUCH_SLOP 才算滚动手势。
    const TOUCH_SLOP_PX = 8;
    let touchY: number | null = null;
    let touchCarry = 0;
    let touchScrolling = false;
    let lastMoveY = 0;
    let lastMoveT = 0;
    let velocity = 0; // 像素/毫秒，正=手指上移（内容向历史滚）
    let inertiaRaf: number | null = null;

    function cellHeightPx(): number {
      const screen = term.element?.querySelector(".xterm-screen") ?? null;
      return screen !== null && term.rows > 0 ? screen.clientHeight / term.rows : 0;
    }

    function stopInertia(): void {
      if (inertiaRaf !== null) {
        cancelAnimationFrame(inertiaRaf);
        inertiaRaf = null;
      }
    }

    function isAltScreen(): boolean {
      return term.buffer.active.type === "alternate";
    }

    function onTouchStart(event: TouchEvent): void {
      stopInertia();
      touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
      touchCarry = 0;
      touchScrolling = false;
      velocity = 0;
      if (touchY !== null) {
        lastMoveY = touchY;
        lastMoveT = event.timeStamp;
      }
    }

    function onTouchMove(event: TouchEvent): void {
      if (touchY === null || event.touches.length !== 1) {
        return;
      }
      if (isAltScreen()) {
        // TUI 不滚动，但仍吞掉手势：不 preventDefault 会被合成 click 弹键盘（#13）
        event.preventDefault();
        return;
      }
      const y = event.touches[0]!.clientY;
      if (!touchScrolling) {
        if (Math.abs(y - touchY) < TOUCH_SLOP_PX) {
          return;
        }
        touchScrolling = true;
      }
      const cellHeight = cellHeightPx();
      if (cellHeight <= 0) {
        return;
      }
      const delta = touchY - y + touchCarry;
      const lines = Math.trunc(delta / cellHeight);
      touchCarry = delta - lines * cellHeight;
      // 末速度用于惯性：像素位移 / 时间间隔（指数平滑压抖动）
      const dt = event.timeStamp - lastMoveT;
      if (dt > 0) {
        const v = (lastMoveY - y) / dt;
        velocity = velocity * 0.4 + v * 0.6;
        lastMoveY = y;
        lastMoveT = event.timeStamp;
      }
      touchY = y;
      if (lines !== 0) {
        term.scrollLines(lines);
      }
      event.preventDefault();
    }

    function onTouchEnd(event: TouchEvent): void {
      const wasScrolling = touchScrolling;
      touchY = null;
      touchScrolling = false;
      // 无论是否滚动，触摸都不该聚焦：阻止 click 合成，键盘保持现状（#13）
      if (event.cancelable) {
        event.preventDefault();
      }
      if (!wasScrolling || isAltScreen()) {
        return;
      }
      const cellHeight = cellHeightPx();
      if (cellHeight <= 0 || Math.abs(velocity) < 0.05) {
        return;
      }
      // 惯性：末速度按帧衰减续滚，复用整行换算与位移累积；下次触摸打断
      let v = velocity; // 像素/毫秒
      let carry = touchCarry;
      let prevT = event.timeStamp;
      const step = (now: number): void => {
        const frame = now - prevT;
        prevT = now;
        carry += v * frame;
        const lines = Math.trunc(carry / cellHeight);
        carry -= lines * cellHeight;
        if (lines !== 0) {
          term.scrollLines(lines);
        }
        v *= 0.92; // 每帧衰减，约 0.3s 收敛
        if (Math.abs(v) > 0.01) {
          inertiaRaf = requestAnimationFrame(step);
        } else {
          inertiaRaf = null;
        }
      };
      inertiaRaf = requestAnimationFrame(step);
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: false });
    container.addEventListener("touchcancel", onTouchEnd, { passive: false });

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      stopInertia();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", reconnectNow);
      observer.disconnect();
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      textarea?.removeEventListener("focus", onTaFocus);
      textarea?.removeEventListener("blur", onTaBlur);
      dataListener.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      sendInputRef.current = null;
    };
  }, [token, sessionId]);

  function handleKey(id: KeyId): void {
    const send = sendInputRef.current;
    if (send === null) {
      return;
    }
    const seq = keySequence(id, {
      ctrl: ctrlRef.current !== "off",
      applicationCursor: termRef.current?.modes.applicationCursorKeysMode ?? false,
    });
    if (ctrlRef.current === "once") {
      updateCtrl("off");
    }
    send(seq);
  }

  function handleCtrlTap(): void {
    updateCtrl(ctrl === "off" ? "once" : ctrl === "once" ? "lock" : "off");
  }

  // ⌨ 键（#13）：移动端键盘唯一入口。focus 弹出系统键盘、blur 收起；
  // 必须在用户手势事件内同步调用，iOS 才允许程序化弹出
  function handleKeyboardTap(): void {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    if (kbOpen) {
      term.blur();
    } else {
      term.focus();
    }
  }

  return (
    <div className="app">
      <div className="status-bar" data-tone={statusLine.tone}>
        <button type="button" className="status-back" onClick={onBack} aria-label="返回会话列表">
          ‹ 列表
        </button>
        <span className="status-dot" aria-hidden="true" />
        {statusLine.text}
      </div>
      <div className="terminal-container" ref={containerRef} />
      <KeyBar
        ctrl={ctrl}
        disabled={!attached}
        keyboard={kbOpen}
        onCtrlTap={handleCtrlTap}
        onKey={handleKey}
        onKeyboardTap={handleKeyboardTap}
      />
    </div>
  );
}
