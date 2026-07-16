// VirtualKeyboard API（Chrome 94+，非标准草案，lib.dom 未收录）：
// standalone PWA 下键盘视口适配的信号源（TerminalView 键盘态机）
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRect;
  show(): void;
  hide(): void;
}

interface Navigator {
  readonly virtualKeyboard?: VirtualKeyboard;
}
