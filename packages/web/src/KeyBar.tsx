import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// 键定义与转义序列 —— 键条的领域知识集中在这一个模块里
// ---------------------------------------------------------------------------

export type CtrlState = "off" | "once" | "lock";

export type KeyId =
  | "esc"
  | "tab"
  | "shift-tab"
  | "up"
  | "down"
  | "left"
  | "right";

/** Ctrl 合成：可合成的字符返回控制字节，不可合成返回 null（调用方原样发送并保持粘滞）。 */
export function composeCtrl(ch: string): string | null {
  if (ch.length !== 1) {
    return null;
  }
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return String.fromCharCode(code - 96);
  }
  const specials: Record<string, string> = {
    "@": "\x00",
    " ": "\x00",
    "[": "\x1b",
    "\\": "\x1c",
    "]": "\x1d",
    "^": "\x1e",
    _: "\x1f",
    "?": "\x7f",
  };
  return specials[ch] ?? null;
}

const ARROW_LETTER = { up: "A", down: "B", right: "C", left: "D" } as const;

/** 键 id → 发往 PTY 的字节序列。方向键跟随终端的 application cursor 模式。 */
export function keySequence(
  id: KeyId,
  opts: { ctrl: boolean; applicationCursor: boolean },
): string {
  switch (id) {
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "shift-tab":
      return "\x1b[Z";
    case "up":
    case "down":
    case "left":
    case "right": {
      const letter = ARROW_LETTER[id];
      if (opts.ctrl) {
        return `\x1b[1;5${letter}`;
      }
      return opts.applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
    }
  }
}

// ---------------------------------------------------------------------------
// 键帽
// ---------------------------------------------------------------------------

const REPEAT_DELAY_MS = 400;
const REPEAT_START_MS = 140;
const REPEAT_MIN_MS = 60;
const REPEAT_STEP_MS = 8;

function vibrate(): void {
  try {
    navigator.vibrate?.(10);
  } catch {
    // iOS Safari 等不支持时静默降级
  }
}

interface KeyCapProps {
  label: string;
  ariaLabel: string;
  className?: string;
  repeat?: boolean;
  disabled: boolean;
  onTrigger: () => void;
}

function KeyCap({ label, ariaLabel, className, repeat = false, disabled, onTrigger }: KeyCapProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const holdRef = useRef<number | null>(null);

  function clearHold(): void {
    if (holdRef.current !== null) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  }

  useEffect(() => clearHold, []);

  function handleDown(event: React.PointerEvent): void {
    // 不抢 xterm 隐藏 textarea 的焦点，系统键盘保持弹出
    event.preventDefault();
    buttonRef.current?.setAttribute("data-pressed", "");
    vibrate();
    onTrigger();
    if (repeat) {
      let interval = REPEAT_START_MS;
      const fire = (): void => {
        onTrigger();
        interval = Math.max(REPEAT_MIN_MS, interval - REPEAT_STEP_MS);
        holdRef.current = window.setTimeout(fire, interval);
      };
      holdRef.current = window.setTimeout(fire, REPEAT_DELAY_MS);
    }
  }

  function handleUp(): void {
    buttonRef.current?.removeAttribute("data-pressed");
    clearHold();
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={-1}
      className={className === undefined ? "key-cap" : `key-cap ${className}`}
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onPointerLeave={handleUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 键条
// ---------------------------------------------------------------------------

const MOD_KEYS: ReadonlyArray<{ id: KeyId; label: string; aria: string }> = [
  { id: "esc", label: "Esc", aria: "Esc 键" },
  { id: "tab", label: "Tab", aria: "Tab 键" },
  { id: "shift-tab", label: "⇧Tab", aria: "Shift Tab 键" },
];

const ARROW_KEYS: ReadonlyArray<{ id: KeyId; label: string; aria: string }> = [
  { id: "up", label: "↑", aria: "上方向键，长按连发" },
  { id: "down", label: "↓", aria: "下方向键，长按连发" },
  { id: "left", label: "←", aria: "左方向键，长按连发" },
  { id: "right", label: "→", aria: "右方向键，长按连发" },
];

const CTRL_ARIA: Record<CtrlState, string> = {
  off: "Ctrl 修饰键",
  once: "Ctrl 修饰键，已粘滞，下一个键合成 Ctrl 组合",
  lock: "Ctrl 修饰键，已常锁",
};

export interface KeyBarProps {
  ctrl: CtrlState;
  disabled: boolean;
  onCtrlTap: () => void;
  onKey: (id: KeyId) => void;
}

export function KeyBar({ ctrl, disabled, onCtrlTap, onKey }: KeyBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // 横滑到头/未到头时切换两端渐隐，提示还有键在画面外
  useEffect(() => {
    const bar = barRef.current;
    const row = rowRef.current;
    if (bar === null || row === null) {
      return;
    }
    const update = (): void => {
      const atStart = row.scrollLeft <= 1;
      const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
      bar.toggleAttribute("data-fade-start", !atStart);
      bar.toggleAttribute("data-fade-end", !atEnd);
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={barRef} className="key-bar" role="toolbar" aria-label="终端辅助键">
      <div ref={rowRef} className="key-bar-row">
        <div className="key-group">
          {MOD_KEYS.map((key) => (
            <KeyCap
              key={key.id}
              label={key.label}
              ariaLabel={key.aria}
              disabled={disabled}
              onTrigger={() => onKey(key.id)}
            />
          ))}
          <button
            type="button"
            tabIndex={-1}
            className="key-cap key-cap--ctrl"
            data-state={ctrl}
            aria-label={CTRL_ARIA[ctrl]}
            aria-pressed={ctrl !== "off"}
            disabled={disabled}
            onPointerDown={(event) => {
              event.preventDefault();
              vibrate();
              onCtrlTap();
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            Ctrl
          </button>
        </div>
        <div className="key-group">
          {ARROW_KEYS.map((key) => (
            <KeyCap
              key={key.id}
              label={key.label}
              ariaLabel={key.aria}
              className="key-cap--arrow"
              repeat
              disabled={disabled}
              onTrigger={() => onKey(key.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
