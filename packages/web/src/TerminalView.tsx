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

// VirtualKeyboard API（Chrome 94+，非标准，lib.dom 未收录）：仅作盲态探测的信号源之一。
// overlaysContent 接管路线在 #7 三/四轮试过并撤回——快捷方式窗口（无 GMS 下「安装」的
// 实际形态，display-mode 报 browser）+ 第三方输入法里接管成功但几何恒 0，拿不到键盘高度
function virtualKeyboardApi(): VirtualKeyboard | undefined {
  return navigator.virtualKeyboard;
}

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
  // 键盘盲态（呼出后视口与 VK 几何均无信号的环境，如快捷方式窗口 + 第三方输入法）：
  // 收起检测必然失灵——滚动手势开始时以 blur 保底收掉（见 onTouchMove / armKeyboardBlindProbe）
  const kbBlindRef = useRef(false);
  // 该环境是否判过盲（跨呼出记忆）：盲环境的顶起走估算，后续呼出立即应用不等探测
  const kbBlindEnvRef = useRef(false);
  // 估算顶起是否生效中：收起时要撤（visualViewport 路径的 --app-height 由 effect 自管）
  const kbEstimateAppliedRef = useRef(false);

  function updateCtrl(next: CtrlState): void {
    ctrlRef.current = next;
    setCtrl(next);
  }

  // 系统键盘弹起时应用整体收缩，键条始终贴在键盘上方：跟随 visualViewport。
  // VK overlaysContent 接管在三/四轮尝试过，真机证伪后撤回：快捷方式窗口 + 第三方
  // 输入法下接管成功（ovl=true）但几何恒 0，拿不到任何键盘高度，反而要冒覆盖
  // 浏览器本来正常的 resize 行为的风险。零信号环境的顶起走盲态估算（armKeyboardBlindProbe）
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
      // 亚行插值抹平整行滚动的格子感（#13）：触摸拖拽/惯性都按行滚，无插值时视觉逐格跳
      smoothScrollDuration: 125,
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
    // 确认渲染路径（远程调试面包屑）：正常应为 webgl，dom 表示该机静默降级。
    // dataset 供诊断浮层读取——standalone 真机没有 console
    document.documentElement.dataset["zagentRenderer"] = webgl !== null ? "webgl" : "dom";
    console.info(`[zagent] renderer: ${webgl !== null ? "webgl" : "dom"}`);
    fit.fit();
    termRef.current = term;

    // 移动端键盘显式呼出（#13）：键盘只走键条 ⌨ 键。
    // 核心防线是 inputMode=none——Android 上聚焦元素被触摸就可能唤起键盘、返回键收起
    // 键盘又不触发 blur，靠拦 click 拦不干净；none 让 textarea 即使聚焦也不唤起键盘。
    // ⌨ 呼出时才切 text；任何收起路径（blur / 返回键）都拨回 none 锁死。
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const textarea = term.textarea;
    if (coarsePointer && textarea !== undefined) {
      textarea.inputMode = "none";
    }
    function lockKeyboard(): void {
      kbBlindRef.current = false;
      clearEstimatedInset();
      setKbOpen(false);
      if (coarsePointer && textarea !== undefined) {
        textarea.inputMode = "none";
      }
    }
    const onTaBlur = (): void => lockKeyboard();
    textarea?.addEventListener("blur", onTaBlur);
    // Android 返回键收起键盘不 blur：视口高度骤增（宽度不变）判定系统收起，拨回安全态
    const vv = window.visualViewport;
    let vvHeight = vv?.height ?? 0;
    let vvWidth = vv?.width ?? 0;
    const onVvResize = (): void => {
      if (vv === null) {
        return;
      }
      const keyboardDismissed = vv.height - vvHeight > 120 && Math.abs(vv.width - vvWidth) < 1;
      vvHeight = vv.height;
      vvWidth = vv.width;
      if (keyboardDismissed) {
        lockKeyboard();
      }
    };
    vv?.addEventListener("resize", onVvResize);

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

    // 触摸滚动桥接（#11/#13）：xterm.js 不处理触摸手势。
    // 普通缓冲：竖向滑动映射为 scrollLines（内容跟手，未整行的位移累积到下一次）；
    // 全屏 TUI（alternate screen）：claude 等 Ink 应用监听的是「鼠标滚轮」，故映射为
    // 滚轮转义序列（开鼠标追踪→按其模式发 SGR/normal 滚轮事件；未开→退回 ↑/↓ 方向键，
    // 覆盖 less/man 一类）。松手按末速度惯性续滚，触摸随时打断。
    // 触摸序列一律 preventDefault 掉合成 click：触摸永不聚焦、永不弹键盘（#13）。
    const TOUCH_SLOP_PX = 8;
    const TUI_MAX_LINES_PER_STEP = 4;
    let touchY: number | null = null;
    let touchX = 0;
    let touchCarry = 0;
    let touchScrolling = false;
    let lastMoveY = 0;
    let lastMoveT = 0;
    let velocity = 0; // 像素/毫秒，正=手指上移（向内容更新方向）
    let inertiaRaf: number | null = null;
    // 手势几何缓存（#13 流畅度）：cellHeight / screen rect 一次手势内不变，
    // 但每个 touchmove 都读 clientHeight / getBoundingClientRect 会强制同步 layout
    // （144Hz 屏一秒上百次）。手势开始快照一次，move/惯性/坐标换算全用缓存值
    let geomCellHeight = 0;
    let geomRect: DOMRect | null = null;

    function refreshGeometry(): void {
      const screen = term.element?.querySelector(".xterm-screen") ?? null;
      if (screen === null || term.rows <= 0) {
        geomCellHeight = 0;
        geomRect = null;
        return;
      }
      geomRect = screen.getBoundingClientRect();
      geomCellHeight = geomRect.height / term.rows;
    }

    function stopInertia(): void {
      if (inertiaRaf !== null) {
        cancelAnimationFrame(inertiaRaf);
        inertiaRaf = null;
      }
    }

    // 滑动落点换算成终端行列（1-based），用于鼠标事件坐标（用手势缓存的 rect，不再强制 layout）
    function cellAt(clientX: number, clientY: number): { col: number; row: number } {
      if (geomRect === null || geomCellHeight <= 0 || term.cols <= 0) {
        return { col: 1, row: 1 };
      }
      const cw = geomRect.width / term.cols;
      const col = Math.min(term.cols, Math.max(1, Math.floor((clientX - geomRect.left) / cw) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((clientY - geomRect.top) / geomCellHeight) + 1));
      return { col, row };
    }

    // 一次滚轮事件的转义序列：SGR（1006）优先，否则 normal（X10）编码。button 64=上/65=下
    function wheelSeq(up: boolean, col: number, row: number): string {
      const btn = up ? 64 : 65;
      if (term.modes.mouseTrackingMode === "none") {
        return "";
      }
      // xterm 未单独暴露 SGR 标志，但 claude/Ink 默认开 1006；SGR 对坐标无 223 上限更稳妥
      const sgr = `\x1b[<${btn};${col};${row}M`;
      return sgr;
    }

    // 把「滚 N 行」翻译到当前缓冲：普通缓冲滚视口；TUI 发滚轮（或退方向键），行数截幅防灌
    function applyLines(lines: number): void {
      if (lines === 0) {
        return;
      }
      if (term.buffer.active.type !== "alternate") {
        term.scrollLines(lines);
        return;
      }
      const capped = Math.max(-TUI_MAX_LINES_PER_STEP, Math.min(TUI_MAX_LINES_PER_STEP, lines));
      const up = capped < 0; // 内容向上回看 = 滚轮上
      const n = Math.abs(capped);
      if (term.modes.mouseTrackingMode !== "none") {
        const { col, row } = cellAt(touchX, touchY ?? 0);
        const seq = wheelSeq(up, col, row);
        if (seq !== "") {
          sendInput(seq.repeat(n));
          return;
        }
      }
      const app = term.modes.applicationCursorKeysMode;
      const arrow = up ? (app ? "\x1bOA" : "\x1b[A") : app ? "\x1bOB" : "\x1b[B";
      sendInput(arrow.repeat(n));
    }

    function onTouchStart(event: TouchEvent): void {
      stopInertia();
      touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
      touchX = event.touches.length === 1 ? event.touches[0]!.clientX : 0;
      touchCarry = 0;
      touchScrolling = false;
      velocity = 0;
      refreshGeometry(); // 手势内几何快照，move/惯性不再逐事件强制 layout
      if (touchY !== null) {
        lastMoveY = touchY;
        lastMoveT = event.timeStamp;
      }
    }

    function onTouchMove(event: TouchEvent): void {
      if (touchY === null || event.touches.length !== 1) {
        return;
      }
      const y = event.touches[0]!.clientY;
      touchX = event.touches[0]!.clientX;
      if (!touchScrolling) {
        if (Math.abs(y - touchY) < TOUCH_SLOP_PX) {
          return;
        }
        touchScrolling = true;
        // 盲态保底：键盘可见性不可观测时，滚动一开始就 blur 收掉——
        // 宁可让用户重呼一次，不让滞留的聚焦+text 态在手势里反复唤起 IME
        if (kbBlindRef.current) {
          kbBlindRef.current = false;
          textarea?.blur();
        }
      }
      event.preventDefault();
      const cellHeight = geomCellHeight;
      if (cellHeight <= 0) {
        return;
      }
      const delta = touchY - y + touchCarry;
      const lines = Math.trunc(delta / cellHeight);
      touchCarry = delta - lines * cellHeight;
      // 末速度用于惯性：像素位移 / 时间间隔（指数平滑压抖动）
      const dt = event.timeStamp - lastMoveT;
      if (dt > 0) {
        velocity = velocity * 0.4 + ((lastMoveY - y) / dt) * 0.6;
        lastMoveY = y;
        lastMoveT = event.timeStamp;
      }
      touchY = y;
      applyLines(lines);
    }

    function onTouchEnd(event: TouchEvent): void {
      const wasScrolling = touchScrolling;
      touchY = null;
      touchScrolling = false;
      // 无论是否滚动，触摸都不该聚焦：阻止 click 合成，键盘保持现状（#13）
      if (event.cancelable) {
        event.preventDefault();
      }
      const cellHeight = geomCellHeight;
      if (!wasScrolling || cellHeight <= 0 || Math.abs(velocity) < 0.05) {
        return;
      }
      // 惯性：末速度按帧衰减续滚，复用整行换算与位移累积；下次触摸打断。
      // TUI 摩擦更大：方向键代打的场景灌太多键比滚太少更糟
      let v = velocity;
      let carry = touchCarry;
      let prevT = event.timeStamp;
      const friction = term.buffer.active.type === "alternate" ? 0.88 : 0.92;
      const step = (now: number): void => {
        const frame = Math.min(now - prevT, 64);
        prevT = now;
        carry += v * frame;
        const lines = Math.trunc(carry / cellHeight);
        carry -= lines * cellHeight;
        applyLines(lines);
        v *= friction;
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
      textarea?.removeEventListener("blur", onTaBlur);
      vv?.removeEventListener("resize", onVvResize);
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

  // ⌨ 键（#13）：移动端键盘唯一入口。textarea 常态 inputMode=none（被聚焦也不唤键盘），
  // 呼出时切 text 并（重）聚焦——必须在用户手势事件内同步调用；收起时先拨回 none 再 blur，
  // 双保险：Android 返回键收过键盘后焦点还在，单靠 blur 状态会漂
  // 盲态估算顶起（零信号环境唯一的招）：键盘高度无从得知，按中文输入法带候选栏的
  // 典型占屏比把应用收到上半 50%——宁高勿低，键条上方留缝好过被键盘盖住
  function applyEstimatedInset(): void {
    kbEstimateAppliedRef.current = true;
    document.documentElement.style.setProperty(
      "--app-height",
      `${Math.round(window.innerHeight * 0.5)}px`,
    );
  }

  function clearEstimatedInset(): void {
    if (kbEstimateAppliedRef.current) {
      kbEstimateAppliedRef.current = false;
      document.documentElement.style.removeProperty("--app-height");
    }
  }

  // 盲态探测：⌨ 呼出后 900ms 若「vv 没缩且 VK 几何仍为 0」（快捷方式窗口 + 第三方输入法
  // 的零信号环境，四轮真机实锤），判盲——①滚动手势以 blur 保底收键盘（onTouchMove）；
  // ②顶起走估算并记住该环境，后续呼出立即应用不等探测。信号恢复（如换输入法）自动摘帽
  function armKeyboardBlindProbe(ta: HTMLTextAreaElement): void {
    kbBlindRef.current = false;
    const base = window.visualViewport?.height ?? window.innerHeight;
    window.setTimeout(() => {
      if (document.activeElement !== ta || ta.inputMode !== "text") {
        return; // 键盘已被收起，无从判定
      }
      const now = window.visualViewport?.height ?? window.innerHeight;
      const vkHeight = virtualKeyboardApi()?.boundingRect.height ?? 0;
      if (base - now < 80 && vkHeight === 0) {
        kbBlindRef.current = true;
        kbBlindEnvRef.current = true;
        applyEstimatedInset();
      } else {
        kbBlindEnvRef.current = false;
        clearEstimatedInset();
      }
    }, 900);
  }

  function handleKeyboardTap(): void {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    const ta = term.textarea;
    if (ta === undefined) {
      return;
    }
    if (kbOpen) {
      kbBlindRef.current = false;
      clearEstimatedInset();
      ta.inputMode = "none";
      term.blur();
      setKbOpen(false);
    } else {
      ta.inputMode = "text";
      if (document.activeElement === ta) {
        // 残留聚焦时仅改 inputMode 不会唤起键盘，blur→focus 强刷一次
        ta.blur();
      }
      term.focus();
      setKbOpen(true);
      if (kbBlindEnvRef.current) {
        applyEstimatedInset();
      }
      armKeyboardBlindProbe(ta);
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
      <DebugOverlay kbBlindRef={kbBlindRef} termRef={termRef} />
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

// 诊断浮层（#7 PWA 返工三轮，临时）：standalone 真机没有 console，把判定修复方向的
// 环境事实常显在屏上，截图即反馈；pointer-events 穿透不碍操作。采数结束整体移除
//（#13 诊断浮层同款生命周期）。键盘态直接读 DOM 事实（inputMode/焦点），不镜像 React 态。
function DebugOverlay({
  kbBlindRef,
  termRef,
}: {
  kbBlindRef: { readonly current: boolean };
  termRef: { readonly current: Terminal | null };
}) {
  const [snapshot, setSnapshot] = useState("");
  useEffect(() => {
    // 帧率：rAF 帧间隔滚动窗口（~2s），平均 fps + 最差帧（卡顿尖峰）
    let frames: number[] = [];
    let prev = performance.now();
    let raf = requestAnimationFrame(function loop(now: number) {
      frames.push(now - prev);
      prev = now;
      if (frames.length > 120) {
        frames = frames.slice(-120);
      }
      raf = requestAnimationFrame(loop);
    });
    const timer = window.setInterval(() => {
      const ua = navigator.userAgent;
      const chrome = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "?";
      const android = /Android (\d+)/.exec(ua)?.[1] ?? "?";
      const mode =
        ["standalone", "minimal-ui", "fullscreen", "browser"].find((m) =>
          window.matchMedia(`(display-mode: ${m})`).matches,
        ) ?? "无";
      const vk = navigator.virtualKeyboard;
      const vkLine =
        vk === undefined
          ? "vk=无"
          : `vk=有 ovl=${String(vk.overlaysContent)} kbH=${vk.boundingRect.height.toFixed(0)}`;
      const appH = document.documentElement.style.getPropertyValue("--app-height") || "(未设)";
      const ta = termRef.current?.textarea;
      const buf = termRef.current?.buffer.active.type ?? "?";
      const avg = frames.length > 0 ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
      const worst = frames.length > 0 ? Math.max(...frames) : 0;
      setSnapshot(
        [
          `Chrome/${chrome} Android/${android} mode=${mode}`,
          `${vkLine} 盲=${kbBlindRef.current ? "Y" : "N"}`,
          `vv=${window.visualViewport?.height.toFixed(0) ?? "无"} inner=${window.innerHeight} app=${appH}`,
          `im=${ta?.inputMode ?? "?"} 焦点=${ta !== undefined && document.activeElement === ta ? "ta" : "其他"}`,
          `渲染=${document.documentElement.dataset["zagentRenderer"] ?? "?"} buf=${buf} fps=${avg > 0 ? (1000 / avg).toFixed(0) : "?"} 最差=${worst.toFixed(0)}ms`,
        ].join("\n"),
      );
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [kbBlindRef, termRef]);
  return <pre className="debug-overlay">{snapshot}</pre>;
}
