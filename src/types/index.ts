/**
 * タブの状態。
 * - 'spawning': PTY spawn 中（Rust 側の pty_spawn 呼び出し中）
 * - 'live': PTY が起動済みで通常動作中。このとき ptyId が設定される
 * - 'crashed': PTY が異常終了、または spawn に失敗した状態
 *
 * 'sleeping' は Phase 3 で追加予定（スクロールバック消失 UX の検討後）
 */
export type TabStatus = 'spawning' | 'live' | 'crashed';

export interface Tab {
  id: string;
  groupId: string;
  title: string;
  /** 未指定の場合は Rust 側のデフォルトシェル（nu）を使用 */
  shell?: string;
  /** 未指定の場合は Rust 側の home_dir を使用 */
  cwd?: string;
  env?: Record<string, string>;
  status: TabStatus;
  /**
   * Rust 側 PtyManager の session key。
   * status が 'live' の場合のみ設定される。
   * Tab ID（Frontend 発行）とは意図的に別物にしている。
   * Phase 3 の sleep/wake でタブ ID を保ちつつ PTY だけ付け替えるための設計。
   */
  ptyId?: string;
}

export interface Group {
  id: string;
  title: string;
  collapsed: boolean;
  /** タブの表示順序を管理する配列。順序は tabIds 配列で保持 */
  tabIds: string[];
}

export interface Favorite {
  id: string;
  title: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** spawn されるタブのデフォルト名テンプレート */
  defaultTabTitle?: string;
}

/**
 * アプリケーション設定。
 * Phase 2 ではハードコードした初期値を持つのみ。
 * Phase 3 で設定 UI と永続化（%APPDATA%/racker-terminal/state.json）を追加予定。
 */
export interface Settings {
  shell?: string;
  /** 現時点は 'tokyo-night' 固定。Phase 3 でテーマ切替 UI を追加予定 */
  theme: 'tokyo-night';
  fontFamily: string;
  fontSize: number;
  scrollback: number;
}

/**
 * アプリケーション全体の状態型（Zustand store の型）。
 * アクション（createTab / removeTab / setActiveTab 等）は Unit A1 / D+E で追加予定。
 * 本 Unit では型のみを定義する。
 *
 * Phase 3 永続化時の partialize 方針（memo）:
 * - Persist OFF（ランタイム状態）: activeTabId, editingId, tabs[*].status, tabs[*].ptyId
 * - Persist ON（復元対象）: groups, tabs[*].{id, groupId, title, shell, cwd, env}, favorites, settings
 */
export interface AppState {
  /** グループの表示順序を保持する配列 */
  groups: Group[];
  tabs: Record<string, Tab>;
  favorites: Favorite[];
  activeTabId: string | null;
  /**
   * 現在インライン編集中の ID（tabId または groupId）。
   * 右クリック「リネーム」と InlineEdit のダブルクリックで共有される。
   * 同時に複数の編集を許可しないために単一の ID で管理する。
   */
  editingId: string | null;
  settings: Settings;
}
