// ZAgent 信封协议 —— 前后端共享的唯一一份类型与编解码源（ADR-0004）。
// 运行环境同时覆盖 Node 与浏览器，因此不依赖 Buffer / atob 等单端 API。

// ---------------------------------------------------------------------------
// 通道
// ---------------------------------------------------------------------------

export const CONTROL_CHANNEL = "control";

export type SessionChannel = `session:${string}`;

export function sessionChannel(sessionId: string): SessionChannel {
  return `session:${sessionId}`;
}

export function isSessionChannel(channel: string): channel is SessionChannel {
  return channel.startsWith("session:") && channel.length > "session:".length;
}

/** sessionChannel 的反解：从会话通道名取回 sessionId。 */
export function sessionIdOf(channel: SessionChannel): string {
  return channel.slice("session:".length);
}

// ---------------------------------------------------------------------------
// 信封与消息类型
// ---------------------------------------------------------------------------

export interface Envelope {
  channel: string;
  type: string;
  payload: unknown;
}

/** 会话类型（ADR-0004：一期仅 pty，二期新增 headless）。 */
export type SessionType = "pty";

/** 命令模板：新建会话时的可选起点（claude / codex / bash 等），由 Hub 下发。 */
export interface SessionTemplate {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export type SessionStatus = "running" | "exited";

/** 会话元数据：Hub 领域模型「会话管理器」中的一条记录（ADR-0004）。 */
export interface SessionInfo {
  id: string;
  type: SessionType;
  /** 创建时使用的模板 id。 */
  template: string;
  /** 实际 spawn 的命令行（含参数），供列表展示。 */
  command: string;
  cwd: string;
  status: SessionStatus;
  exitCode?: number;
  createdAt: number;
}

/** data 为 base64 编码的 PTY 输入字节。 */
export interface InputPayload {
  data: string;
}

export interface ResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

/** data 为 base64 编码的 PTY 输出字节。 */
export interface OutputPayload {
  data: string;
}

export interface ExitPayload {
  exitCode: number;
}

export interface AttachedPayload {
  sessionId: string;
  sessionType: SessionType;
}

export interface CreatePayload {
  template: string;
  cwd: string;
  /** 覆盖模板默认参数（“可自定义”）；缺省用模板自带 args。 */
  args?: string[];
}

export interface SessionRefPayload {
  sessionId: string;
}

/** 连接建立后 Hub 主动下发：模板、cwd 预设与当前会话快照。 */
export interface HelloPayload {
  templates: SessionTemplate[];
  cwds: string[];
  sessions: SessionInfo[];
}

export interface SessionsPayload {
  sessions: SessionInfo[];
}

export interface CreatedPayload {
  session: SessionInfo;
}

export interface ErrorPayload {
  message: string;
}

/** 客户端 → Hub。会话管理全部走 control 通道信封，不新增 REST 端点（ADR-0004）。 */
export type ClientMessage =
  | { channel: SessionChannel; type: "input"; payload: InputPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "resize"; payload: ResizePayload }
  | { channel: typeof CONTROL_CHANNEL; type: "list"; payload: Record<string, never> }
  | { channel: typeof CONTROL_CHANNEL; type: "create"; payload: CreatePayload }
  | { channel: typeof CONTROL_CHANNEL; type: "kill"; payload: SessionRefPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "attach"; payload: SessionRefPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "detach"; payload: SessionRefPayload };

/** Hub → 客户端。 */
export type HubMessage =
  | { channel: typeof CONTROL_CHANNEL; type: "hello"; payload: HelloPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "sessions"; payload: SessionsPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "created"; payload: CreatedPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "attached"; payload: AttachedPayload }
  | { channel: typeof CONTROL_CHANNEL; type: "error"; payload: ErrorPayload }
  | { channel: SessionChannel; type: "output"; payload: OutputPayload }
  | { channel: SessionChannel; type: "exit"; payload: ExitPayload };

// ---------------------------------------------------------------------------
// serialize / parse
// ---------------------------------------------------------------------------

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/** 校验最外层信封结构；不合法返回 null。 */
export function parseEnvelope(raw: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { channel, type } = value as Record<string, unknown>;
  if (typeof channel !== "string" || typeof type !== "string") {
    return null;
  }
  if (!("payload" in value)) {
    return null;
  }
  return value as unknown as Envelope;
}

/** 校验并收窄客户端入站消息（含 payload 形状）；不合法返回 null。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  const envelope = parseEnvelope(raw);
  if (envelope === null) {
    return null;
  }
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  if (envelope.type === "input" && isSessionChannel(envelope.channel)) {
    const { data } = payload as Record<string, unknown>;
    if (typeof data !== "string") {
      return null;
    }
    return { channel: envelope.channel, type: "input", payload: { data } };
  }
  if (envelope.type === "resize" && envelope.channel === CONTROL_CHANNEL) {
    const { sessionId, cols, rows } = payload as Record<string, unknown>;
    if (typeof sessionId !== "string" || !isPositiveInt(cols) || !isPositiveInt(rows)) {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "resize", payload: { sessionId, cols, rows } };
  }
  if (envelope.channel === CONTROL_CHANNEL && envelope.type === "list") {
    return { channel: CONTROL_CHANNEL, type: "list", payload: {} };
  }
  if (envelope.channel === CONTROL_CHANNEL && envelope.type === "create") {
    const { template, cwd, args } = payload as Record<string, unknown>;
    if (typeof template !== "string" || typeof cwd !== "string") {
      return null;
    }
    if (args !== undefined && !isStringArray(args)) {
      return null;
    }
    return {
      channel: CONTROL_CHANNEL,
      type: "create",
      payload: args === undefined ? { template, cwd } : { template, cwd, args },
    };
  }
  if (
    envelope.channel === CONTROL_CHANNEL &&
    (envelope.type === "kill" || envelope.type === "attach" || envelope.type === "detach")
  ) {
    const { sessionId } = payload as Record<string, unknown>;
    if (typeof sessionId !== "string") {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: envelope.type, payload: { sessionId } };
  }
  return null;
}

/** 校验并收窄 Hub 出站消息（客户端用）；不合法返回 null。 */
export function parseHubMessage(raw: string): HubMessage | null {
  const envelope = parseEnvelope(raw);
  if (envelope === null) {
    return null;
  }
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  if (envelope.type === "attached" && envelope.channel === CONTROL_CHANNEL) {
    const { sessionId, sessionType } = payload as Record<string, unknown>;
    if (typeof sessionId !== "string" || sessionType !== "pty") {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "attached", payload: { sessionId, sessionType } };
  }
  if (envelope.type === "hello" && envelope.channel === CONTROL_CHANNEL) {
    const { templates, cwds, sessions } = payload as Record<string, unknown>;
    if (
      !Array.isArray(templates) ||
      !templates.every(isSessionTemplate) ||
      !isStringArray(cwds) ||
      !Array.isArray(sessions) ||
      !sessions.every(isSessionInfo)
    ) {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "hello", payload: { templates, cwds, sessions } };
  }
  if (envelope.type === "sessions" && envelope.channel === CONTROL_CHANNEL) {
    const { sessions } = payload as Record<string, unknown>;
    if (!Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "sessions", payload: { sessions } };
  }
  if (envelope.type === "created" && envelope.channel === CONTROL_CHANNEL) {
    const { session } = payload as Record<string, unknown>;
    if (!isSessionInfo(session)) {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "created", payload: { session } };
  }
  if (envelope.type === "error" && envelope.channel === CONTROL_CHANNEL) {
    const { message } = payload as Record<string, unknown>;
    if (typeof message !== "string") {
      return null;
    }
    return { channel: CONTROL_CHANNEL, type: "error", payload: { message } };
  }
  if (envelope.type === "output" && isSessionChannel(envelope.channel)) {
    const { data } = payload as Record<string, unknown>;
    if (typeof data !== "string") {
      return null;
    }
    return { channel: envelope.channel, type: "output", payload: { data } };
  }
  if (envelope.type === "exit" && isSessionChannel(envelope.channel)) {
    const { exitCode } = payload as Record<string, unknown>;
    if (typeof exitCode !== "number") {
      return null;
    }
    return { channel: envelope.channel, type: "exit", payload: { exitCode } };
  }
  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSessionTemplate(value: unknown): value is SessionTemplate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, name, command, args } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof name === "string" &&
    typeof command === "string" &&
    isStringArray(args)
  );
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, type, template, command, cwd, status, exitCode, createdAt } = value as Record<
    string,
    unknown
  >;
  return (
    typeof id === "string" &&
    type === "pty" &&
    typeof template === "string" &&
    typeof command === "string" &&
    typeof cwd === "string" &&
    (status === "running" || status === "exited") &&
    (exitCode === undefined || typeof exitCode === "number") &&
    typeof createdAt === "number"
  );
}

// ---------------------------------------------------------------------------
// base64（纯实现，Node 与浏览器行为一致）
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length % 4 !== 0) {
    throw new Error("invalid base64: length must be a multiple of 4");
  }
  let padding = 0;
  if (b64.endsWith("==")) {
    padding = 2;
  } else if (b64.endsWith("=")) {
    padding = 1;
  }
  const charCount = b64.length - padding;
  const bytes = new Uint8Array((b64.length / 4) * 3 - padding);
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < charCount; i++) {
    const code = b64.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code]! : -1;
    if (value < 0) {
      throw new Error(`invalid base64 character at index ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToBase64(text: string): string {
  return bytesToBase64(textEncoder.encode(text));
}

export function base64ToUtf8(b64: string): string {
  return textDecoder.decode(base64ToBytes(b64));
}
