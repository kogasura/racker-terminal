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
  /**
   * ユーザーが手動編集したタイトル。優先表示。
   * Phase 4 P-A で title を userTitle / oscTitle に分離。
   * undefined の場合は oscTitle → デフォルト値 ('Terminal') の順にフォールバックする。
   */
  userTitle?: string;
  /**
   * shell が OSC タイトルシーケンスで送ってきたタイトル。
   * userTitle が undefined のときに表示される。永続化対象外 (起動時に再取得)。
   */
  oscTitle?: string;
  /** 未指定の場合は Rust 側のデフォルトシェル（nu）を使用 */
  shell?: string;
  /** 未指定の場合は Rust 側の home_dir を使用 */
  cwd?: string;
  /**
   * shell 起動時の引数配列。空配列 / undefined は引数なし。
   * Rust 側 CommandBuilder.arg() で argv に追加される（シェル injection なし、プロセス API レベル）。
   */
  args?: string[];
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

/**
 * タブの表示タイトルを返すヘルパー。
 * userTitle → oscTitle → defaultTitle の順にフォールバックする。
 *
 * @param tab - 表示対象の Tab
 * @param defaultTitle - userTitle も oscTitle も未設定のときのデフォルト値
 */
export function getTabDisplayTitle(tab: Tab, defaultTitle = 'Terminal'): string {
  return tab.userTitle ?? tab.oscTitle ?? defaultTitle;
}

export interface Group {
  id: string;
  title: string;
  collapsed: boolean;
  /**
   * このグループに属するタブ ID の配列（順序保持）。
   * 不変条件: 同一 tabId は複数 Group.tabIds に含まれない。
   * moveTabToGroup / removeTab 実装時は、移動元グループから tabIds を
   * 除去することを忘れないこと。
   */
  tabIds: string[];
}

export interface Favorite {
  id: string;
  title: string;
  shell?: string;
  cwd?: string;
  /**
   * shell 起動時の引数配列。空配列 / undefined は引数なし。
   * Rust 側 CommandBuilder.arg() で argv に追加される（シェル injection なし、プロセス API レベル）。
   */
  args?: string[];
  env?: Record<string, string>;
  /** spawn されるタブのデフォルト名テンプレート */
  defaultTabTitle?: string;
}

/**
 * アプリケーション設定。
 * Phase 2 ではハードコードした初期値を持つのみ。
 * Phase 4 P-B-2 で Settings UI と透明度設定を追加。
 */
export interface Settings {
  shell?: string;
  /** 現時点は 'tokyo-night' 固定。Phase 3 でテーマ切替 UI を追加予定 */
  theme: 'tokyo-night';
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  /**
   * 背景透明度 (0.7 〜 1.0)。frameless window 時のみ有効。
   * Phase 4 P-B-2 で追加。
   */
  transparency?: number;  // default: 1.0 (不透明)
  /**
   * 既定として使うお気に入り ID。+ ボタン / Ctrl+T で spawn される。
   * 未設定 or 該当 favorite が存在しない場合は plain Terminal タブを spawn。
   * Phase 4 P-H で追加。
   */
  defaultFavoriteId?: string;
}

/**
 * アプリケーション全体の状態型（Zustand store の型）。
 * アクション（createTab / removeTab / setActiveTab 等）は Unit A1 / D+E で追加予定。
 * 本 Unit では型のみを定義する。
 *
 * Phase 4 A1 永続化 partialize 方針:
 * - Persist OFF（ランタイム状態）: activeTabId, editingId, contextMenuOpen, tabs[*].status, tabs[*].ptyId, tabs[*].oscTitle
 * - Persist ON（復元対象）: groups, tabs[*].{id, groupId, userTitle, shell, cwd, args, env}, favorites, settings
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
  /**
   * 右クリックコンテキストメニューが開いているとき true。
   * TerminalPane の attachCustomKeyEventHandler でキーバインドを suspend するために使用する。
   */
  contextMenuOpen: boolean;
  settings: Settings;
}
