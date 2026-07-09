import { describe, expect, it } from "vitest";

import {
  CONTROL_CHANNEL,
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64,
  isSessionChannel,
  parseClientMessage,
  parseEnvelope,
  parseHubMessage,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
} from "./index.js";

describe("base64 编解码", () => {
  it("字节数组往返无损（覆盖各种 padding 长度）", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 255, 256, 1000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) % 256);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it("与 Node Buffer 的 base64 结果一致", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("UTF-8 文本往返无损（含中文与 emoji）", () => {
    for (const text of ["", "ls -la\r", "中文输入", "🚀 vim", "\x1b[2J\x1b[H"]) {
      expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
    }
  });

  it("拒绝非法 base64 输入", () => {
    expect(() => base64ToBytes("not!!valid")).toThrow();
    expect(() => base64ToBytes("abc")).toThrow(); // 长度非 4 的倍数
  });
});

describe("信封 serialize / parse", () => {
  it("serialize 后 parse 还原信封", () => {
    const env = {
      channel: sessionChannel("main"),
      type: "input",
      payload: { data: utf8ToBase64("ls\r") },
    };
    expect(parseEnvelope(serializeEnvelope(env))).toEqual(env);
  });

  it("拒绝非 JSON、非对象、缺字段的输入", () => {
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("[1,2]")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope('{"type":"input","payload":{}}')).toBeNull(); // 缺 channel
    expect(parseEnvelope('{"channel":"control","payload":{}}')).toBeNull(); // 缺 type
    expect(parseEnvelope('{"channel":"control","type":"x"}')).toBeNull(); // 缺 payload
    expect(parseEnvelope('{"channel":1,"type":"x","payload":{}}')).toBeNull(); // channel 非字符串
  });
});

describe("通道", () => {
  it("sessionChannel 生成 session:<id> 路由键", () => {
    expect(sessionChannel("main")).toBe("session:main");
  });

  it("isSessionChannel 区分 control 与 session 通道", () => {
    expect(isSessionChannel("session:main")).toBe(true);
    expect(isSessionChannel(CONTROL_CHANNEL)).toBe(false);
    expect(isSessionChannel("session:")).toBe(false); // 空 id 不合法
  });
});

describe("parseClientMessage（Hub 入站消息校验）", () => {
  it("接受合法 input 消息", () => {
    const raw = serializeEnvelope({
      channel: "session:main",
      type: "input",
      payload: { data: utf8ToBase64("echo hi\r") },
    });
    const msg = parseClientMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("input");
  });

  it("接受合法 resize 消息（control 通道，带 sessionId）", () => {
    const raw = serializeEnvelope({
      channel: CONTROL_CHANNEL,
      type: "resize",
      payload: { sessionId: "main", cols: 120, rows: 40 },
    });
    expect(parseClientMessage(raw)?.type).toBe("resize");
  });

  it("拒绝错误通道 / 未知类型 / 坏 payload", () => {
    const bad = [
      { channel: "control", type: "input", payload: { data: "aGk=" } },
      { channel: "session:main", type: "resize", payload: { sessionId: "main", cols: 80, rows: 24 } },
      { channel: "session:main", type: "unknown", payload: {} },
      { channel: "session:main", type: "input", payload: { data: 42 } },
      { channel: "session:main", type: "input", payload: {} },
      { channel: "control", type: "resize", payload: { cols: 80, rows: 24 } },
      { channel: "control", type: "resize", payload: { sessionId: "main", cols: 0, rows: 40 } },
      { channel: "control", type: "resize", payload: { sessionId: "main", cols: 1.5, rows: 40 } },
      { channel: "control", type: "resize", payload: { sessionId: "main", cols: "80", rows: 40 } },
    ];
    for (const env of bad) {
      expect(parseClientMessage(JSON.stringify(env))).toBeNull();
    }
  });
});

describe("parseHubMessage（客户端入站消息校验）", () => {
  it("接受合法 attached / output / exit 消息", () => {
    const good = [
      { channel: "control", type: "attached", payload: { sessionId: "main", sessionType: "pty" } },
      { channel: "session:main", type: "output", payload: { data: utf8ToBase64("hi") } },
      { channel: "session:main", type: "exit", payload: { exitCode: 0 } },
    ];
    for (const env of good) {
      expect(parseHubMessage(JSON.stringify(env))?.type).toBe(env.type);
    }
  });

  it("拒绝错误通道或坏 payload", () => {
    const bad = [
      { channel: "session:main", type: "attached", payload: { sessionId: "main", sessionType: "pty" } },
      { channel: "control", type: "attached", payload: { sessionId: "main" } },
      { channel: "control", type: "output", payload: { data: "aGk=" } },
      { channel: "session:main", type: "output", payload: { data: 1 } },
      { channel: "session:main", type: "exit", payload: {} },
    ];
    for (const env of bad) {
      expect(parseHubMessage(JSON.stringify(env))).toBeNull();
    }
  });
});
