// PTY 会话：node-pty spawn 的被控进程包装（一期 type 仅 pty）。

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import pty from "node-pty";

import type { SessionType } from "@zagent/protocol";

export interface PtySessionOptions {
  id: string;
  shell: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

export class PtySession {
  readonly id: string;
  readonly type: SessionType = "pty";
  exited = false;

  private readonly pty: pty.IPty;

  constructor(options: PtySessionOptions) {
    this.id = options.id;
    this.pty = pty.spawn(resolveExecutable(options.shell), [], {
      name: "xterm-256color",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: process.env as Record<string, string>,
    });
    this.pty.onExit(() => {
      this.exited = true;
    });
  }

  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.pty.onExit(({ exitCode }) => listener(exitCode));
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(): void {
    if (!this.exited) {
      this.pty.kill();
    }
  }
}

// Windows 上 node-pty 需要可执行文件的完整路径（裸命令名会报 File not found），
// 因此手动沿 PATH + PATHEXT 解析；类 Unix 平台交给系统解析即可。
function resolveExecutable(command: string): string {
  if (process.platform !== "win32" || isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return command;
  }
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter);
  const extensions = command.includes(".")
    ? [""]
    : (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";");
  for (const dir of pathDirs) {
    if (dir === "") {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}
