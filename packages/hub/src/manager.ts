// 会话管理器：Hub 的领域模型（ADR-0004）。多会话并存，每个会话是 {id, type, 命令模板, cwd}。
// 只管理 Hub 自己 spawn 的会话，不接管外部已有终端（ADR-0001）。

import { existsSync, statSync } from "node:fs";

import type { CreatePayload, SessionInfo, SessionTemplate } from "@zagent/protocol";

import { PtySession } from "./session.js";

export interface ManagedSession {
  session: PtySession;
  info: SessionInfo;
}

/** 命令模板：三种模板走同一条 PTY spawn 路径（PTY 模式天然命令无关）。 */
export function buildTemplates(shell: string): SessionTemplate[] {
  return [
    { id: "claude", name: "Claude Code", command: "claude", args: [] },
    { id: "codex", name: "Codex", command: "codex", args: [] },
    { id: "bash", name: "Shell", command: shell, args: [] },
  ];
}

export class SessionManager {
  private readonly templates: Map<string, SessionTemplate>;
  private readonly sessions = new Map<string, ManagedSession>();
  private counter = 0;

  constructor(templates: SessionTemplate[]) {
    this.templates = new Map(templates.map((t) => [t.id, t]));
  }

  /**
   * 模板不存在或 cwd 不是目录时抛错（node-pty 在 Windows 上对坏 cwd 不同步抛错，
   * 会静默给出一个立即退出的死终端，所以这里前置校验）；由调用方转成 error 信封。
   */
  create(options: CreatePayload): ManagedSession {
    const template = this.templates.get(options.template);
    if (template === undefined) {
      throw new Error(`未知的命令模板：${options.template}`);
    }
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw new Error(`工作目录不存在：${options.cwd}`);
    }
    const args = options.args ?? template.args;
    const id = `s${++this.counter}`;
    const session = new PtySession({ id, command: template.command, args, cwd: options.cwd });
    const info: SessionInfo = {
      id,
      type: session.type,
      template: template.id,
      command: [template.command, ...args].join(" "),
      cwd: options.cwd,
      status: "running",
      createdAt: Date.now(),
    };
    const managed: ManagedSession = { session, info };
    this.sessions.set(id, managed);
    session.onExit((exitCode) => {
      info.status = "exited";
      info.exitCode = exitCode;
    });
    return managed;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => m.info);
  }

  /**
   * kill 运行中的会话终止进程；对已退出的会话则把条目从列表移除（同一入口兼作清理）。
   * 返回 false 表示会话不存在。
   */
  kill(id: string): boolean {
    const managed = this.sessions.get(id);
    if (managed === undefined) {
      return false;
    }
    if (managed.session.exited) {
      this.sessions.delete(id);
    } else {
      managed.session.kill();
    }
    return true;
  }

  killAll(): void {
    for (const managed of this.sessions.values()) {
      managed.session.kill();
    }
  }
}
