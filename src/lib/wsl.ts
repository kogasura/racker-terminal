import { invoke } from "@tauri-apps/api/core";

/**
 * インストール済 WSL distro 一覧を取得する。
 * - WSL 未インストール / 実行失敗時は空配列を返す (エラーにならない)
 * - `docker-desktop*` は Rust 側でフィルタ済
 *
 * @since Phase 4 P-K で追加
 */
export async function listWslDistros(): Promise<string[]> {
  try {
    return await invoke<string[]>("list_wsl_distros");
  } catch (e) {
    console.warn('[wsl] list_wsl_distros failed:', e);
    return [];
  }
}
