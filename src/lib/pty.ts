import { invoke, Channel } from "@tauri-apps/api/core";

// Rust 側の PtyEvent と一致する tagged union 型（serde camelCase 前提）
export type PtyEvent =
  | { type: "data"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface SpawnOptions {
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface PtyHandle {
  id: string;
  dispose: () => Promise<void>;
}

export async function spawnPty(
  opts: SpawnOptions,
  onEvent: (e: PtyEvent) => void,
): Promise<PtyHandle> {
  // Channel は Rust 側 session の drop で自動的に送信が止まる
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;

  // opts.shell / opts.cwd が undefined の場合は引数から除外して Rust 側に None を渡す
  const args: Record<string, unknown> = {
    cols: opts.cols,
    rows: opts.rows,
    onEvent: channel,
  };
  if (opts.shell !== undefined) args.shell = opts.shell;
  if (opts.cwd !== undefined) args.cwd = opts.cwd;
  if (opts.env !== undefined) args.env = opts.env;

  const id = await invoke<string>("pty_spawn", args);

  return {
    id,
    dispose: () => killPty(id),
  };
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke<void>("pty_write", { id, data });
}

export async function resizePty(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke<void>("pty_resize", { id, cols, rows });
}

export async function killPty(id: string): Promise<void> {
  await invoke<void>("pty_kill", { id });
}
