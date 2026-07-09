import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // node-pty 的原生绑定在 worker_threads 中不可用，测试进程必须用子进程池
    pool: "forks",
  },
});
