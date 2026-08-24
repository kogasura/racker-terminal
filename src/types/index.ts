// Rust から受け取る形をそのまま状態に載せるため、定義元 (lib/claudeMeta.ts) から借りる。
// `import type` なのでランタイムの依存は生まれず、循環にもならない
// (claudeMeta.ts は types を参照しない)。
import type { ClaudeTranscriptMeta, ClaudeUsageLimits } from '../lib/claudeMeta';

/**
 * タブの状態。
 * - 'spawning': PTY spawn 中（Rust 側の pty_spawn 呼び出し中）
 * - 'live': PTY が起動済みで通常動作中。このとき ptyId が設定される
 * - 'crashed': PTY が異常終了、または spawn に失敗した状態
 *
 * 'sleeping' は Phase 3 で追加予定（スクロールバック消失 UX の検討後）
 */
export type TabStatus = 'spawning' | 'live' | 'crashed';

/**
 * Claude タブで動作しているエージェントの意味的な状態。
 * TabStatus（PTY のライフサイクル）とは独立した軸で、launchClaude=true のタブにのみ設定される。
 *
 * - 'idle':    入力待ち。エージェントは何もしていない
 * - 'working': 実行中（画面に "esc to interrupt" が出ている、または出力が継続中）
 * - 'blocked': 権限確認 / 質問プロンプトでユーザーの応答を待っている（最優先で通知すべき状態）
 * - 'done':    処理が完了して BEL が鳴った。ユーザーがタブを見るまで保持される
 *
 * 判定は src/lib/agentState.ts の classifyAgentState が単独で担う（"one status authority"）。
 * ランタイム状態のため persist 対象外。
 */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done';

/**
 * サイドバー表示で「どの状態を優先して見せるか」の序列。数値が大きいほど優先。
 * グループヘッダに配下タブの代表状態を出すときや、同時成立時の勝敗判定に使う。
 * blocked（ユーザーの応答待ち = 止まっている）を最優先に置く。
 */
export const AGENT_STATE_PRIORITY: Record<AgentState, number> = {
  blocked: 3,
  working: 2,
  done: 1,
  idle: 0,
};

/** ステータスドットの tooltip / aria-label に使う表示名。 */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  blocked: '応答待ち',
  working: '実行中',
  done: '完了',
  idle: '待機中',
};

/**
 * 「まだ見ていない完了」(`done`) を作るための状態遷移ルール。
 *
 * Claude が申告する状態には `done` が存在しない（処理が終わると `idle` に戻るだけ）。
 * そこで **working から idle への遷移**を完了とみなして `done` に読み替える。
 *
 * - idle 以外はそのまま通す
 * - idle に落ちたとき:
 *   - アクティブタブなら idle（見えているので通知の意味がない）
 *   - 直前が working なら **done**（処理が完了した）
 *   - すでに done ならそのまま **done を維持**（見るまで消さない）
 *   - それ以外は idle
 *
 * blocked からの idle 遷移を done にしないのは、ダイアログのキャンセル等で
 * 「何も完了していないのに完了と表示される」ことを避けるため。
 *
 * セッションファイル経由 (claudeSessions.ts) と OSC 経由 (tabStatusOsc.ts) の
 * どちらの入力に対しても同じ規則を適用するため、ここに集約している。
 */
export function applyIdleTransition(
  prev: AgentState | undefined,
  next: AgentState,
  isActive: boolean,
): AgentState {
  if (next !== 'idle') return next;
  if (isActive) return 'idle';
  if (prev === 'done') return 'done';
  if (prev === 'working') return 'done';
  return 'idle';
}

/**
 * タブ集合の代表となるエージェント状態を返す（優先度が最も高いもの）。
 * グループヘッダに配下タブの状態をまとめて出すために使う。
 *
 * 該当する状態がひとつもない（全タブが未検出）場合は undefined を返す。
 * 'idle' しかない場合は 'idle' を返すので、呼び出し側で表示要否を判断すること。
 */
export function dominantAgentState(states: (AgentState | undefined)[]): AgentState | undefined {
  let best: AgentState | undefined;
  for (const s of states) {
    if (!s) continue;
    if (best === undefined || AGENT_STATE_PRIORITY[s] > AGENT_STATE_PRIORITY[best]) {
      best = s;
    }
  }
  return best;
}

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
  /**
   * Claude タブのエージェント状態。launchClaude=true のタブにのみ設定される。
   * ランタイム状態のため persist 対象外（再起動直後は undefined = 未検出）。
   *
   * アクティブタブには 'blocked' / 'done' を設定しない（即見えているため）。
   * 'done' はタブをアクティブ化した時点でクリアされる。
   */
  agentState?: AgentState;
  /**
   * agentState が Claude Code のセッションファイル由来かどうか。
   *
   * true のあいだは、画面出力のパターン判定 (agentState.ts) による更新を無視する。
   * Claude 自身が申告した status のほうが確実なので、推測で上書きさせない。
   * セッションが見つからなくなったら false に戻り、画面判定へフォールバックする。
   *
   * ランタイム状態のため persist 対象外。
   */
  agentStateFromSession?: boolean;
  /**
   * Claude が応答待ち (status = 'waiting') のときの理由。
   * 'input needed' / 'dialog open' / 'sandbox request' 等。tooltip に出す。
   * ランタイム状態のため persist 対象外。
   */
  waitingFor?: string;
  /**
   * 直近に観測した Claude の生の status ('busy' | 'shell' | 'idle' | 'waiting')。
   * working に統合した 'shell' を tooltip で区別するために保持する。
   * ランタイム状態のため persist 対象外。
   */
  claudeStatus?: string;
  /**
   * 作業ディレクトリのブランチに対応する GitHub PR の情報。
   *
   * 「Claude に作らせた PR がマージされたか」をタブを見るだけで分かるようにする。
   * `git` / `gh` が使えない環境や WSL タブでは設定されない。
   * ランタイム状態のため persist 対象外（起動のたびに引き直す）。
   */
  prNumber?: number;
  /** 'OPEN' | 'MERGED' | 'CLOSED' */
  prState?: string;
  prUrl?: string;
  prIsDraft?: boolean;
  /** PR を引いたときのブランチ名。tooltip に出す */
  prBranch?: string;
  /**
   * true のとき、このタブは spawn 時に Claude Code を自動起動する「Claude タブ」。
   * お気に入りの launchClaude フラグから createTab/spawnFavorite 経由で引き継ぐ。永続化対象。
   */
  launchClaude?: boolean;
  /**
   * Claude タブが管理する claude セッションの UUID。
   * 初回 spawn 時に crypto.randomUUID() で発番して `claude --session-id <id>` で起動し、
   * 以降（再起動復元・PTY recycle）は `claude --resume <id>` で同一セッションを再開する。
   * launchClaude=true のタブにのみ設定される。永続化対象。
   */
  claudeSessionId?: string;
  /**
   * true のとき、Claude 自動起動コマンドに `--dangerously-skip-permissions` を付与し、
   * 権限プロンプトをバイパスして起動する。launchClaude=true のタブにのみ意味を持つ。永続化対象。
   * セキュリティ上の影響が大きいため、お気に入りごとの明示 opt-in (既定 false)。
   */
  bypassPermissions?: boolean;
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

/**
 * D&D でドラッグしている対象の種別。
 *
 * dndResolve.ts が re-export しているため、利用側は従来どおり
 * `from '../lib/dndResolve'` で参照できる。ここに定義があるのは、
 * AppState がドラッグ中の種別を保持する必要があるため
 * (types → lib への import は循環になる)。
 */
export const DRAG_KIND = {
  TAB: 'tab',
  GROUP: 'group',
  FAVORITE: 'favorite',
} as const;

export type DragKind = typeof DRAG_KIND[keyof typeof DRAG_KIND];

export interface Group {
  id: string;
  title: string;
  /**
   * 折りたたみ状態。
   *
   * 横タブバー導入によりサイドバーはグループ 1 行のみを描画するようになり、
   * UI からは参照されなくなった。永続化データとの互換のためフィールドは残す
   * (将来グループを入れ子にする場合に再び使う想定)。
   */
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
  /**
   * true のとき、このお気に入りから開いたタブを「Claude タブ」にする。
   * タブ spawn 時に Claude Code を自動起動し、再起動復元時は前回セッションを resume する。
   */
  launchClaude?: boolean;
  /**
   * true のとき、Claude 自動起動に `--dangerously-skip-permissions` を付ける（権限バイパス）。
   * launchClaude=true のときのみ有効。既定 false。
   */
  bypassPermissions?: boolean;
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
  /**
   * Claude タブが応答待ち / 完了になったときにデスクトップ通知を出すか。
   *
   * 未設定 (undefined) は **有効**として扱う。サイドバーの表示は racker の
   * ウィンドウを見ていないと気付けないため、既定では通知する。
   * 通知は侵襲的なので、明示的に false にして切れるようにしている。
   */
  notificationsEnabled?: boolean;
  /**
   * 画面下部のステータスバー（Claude のモデル / effort / コンテキスト量 / 利用量）を出すか。
   *
   * 未設定 (undefined) は **有効**として扱う。1 行ぶんの高さしか使わず、
   * Claude タブ以外では利用量だけの控えめな表示になるため、既定で出す。
   */
  statusBarEnabled?: boolean;
}

/**
 * 自動更新機能の状態フェーズ (Chrome 風バックグラウンド DL フロー)。
 * idle: 未チェック / 更新なし / リセット後
 * checking: check() 実行中
 * downloading: バックグラウンド DL 中（UI には出ない）
 * ready: DL 完了、再起動待ち（バッジ表示対象）
 * installing: 再起動 + インストール中
 * error: エラー発生 (リトライ可能)
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

/**
 * 自動更新で取得した新バージョン情報。
 * Update ハンドル (_handle) は state には含まず、モジュールスコープに保持する。
 */
export interface UpdateInfo {
  version: string;        // 新バージョン
  currentVersion: string; // 現在のバージョン
  notes: string;          // リリースノート (空文字列の可能性あり)
  date?: string;          // RFC3339 (manifest の pub_date)
}

/**
 * 更新の適用を試みたのに、バージョンが変わらないまま起動してきたときの情報。
 *
 * Windows ではインストーラの起動失敗がアプリ側に一切返らないため、
 * 「適用したつもりが何も起きていない」状態を検知する唯一の手段になる
 * (lib/updater.ts の takeFailedUpdateAttempt を参照)。
 */
export interface UpdateInstallFailure {
  /** 適用しようとしたバージョン */
  version: string;
  /** 実際に起動しているバージョン */
  currentVersion: string;
}

/**
 * 閉じたタブの復元用情報。
 * id / status / ptyId / oscTitle は復元時に新規生成・初期化されるため保存しない。
 */
export interface ClosedTab {
  groupId: string;
  userTitle?: string;
  shell?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Claude タブ属性を復元するため保存する。 */
  launchClaude?: boolean;
  /** 閉じる前の claude セッション ID。再オープン時に同一セッションを resume するため保存する。 */
  claudeSessionId?: string;
  /** 権限バイパス (--dangerously-skip-permissions) フラグを復元するため保存する。 */
  bypassPermissions?: boolean;
}

/**
 * アプリケーション全体の状態型（Zustand store の型）。
 * アクション（createTab / removeTab / setActiveTab 等）は Unit A1 / D+E で追加予定。
 * 本 Unit では型のみを定義する。
 *
 * Phase 4 A1 永続化 partialize 方針:
 * - Persist OFF（ランタイム状態）: activeTabId, lastActiveTabByGroup, dragId, dragKind, editingId, contextMenuOpen, tabs[*].status, tabs[*].ptyId, tabs[*].oscTitle, tabs[*].agentState, wslDistros
 * - Persist ON（復元対象）: groups, tabs[*].{id, groupId, userTitle, shell, cwd, args, env, launchClaude, claudeSessionId, bypassPermissions}, favorites, settings, activeGroupId
 */
export interface AppState {
  /** グループの表示順序を保持する配列 */
  groups: Group[];
  tabs: Record<string, Tab>;
  favorites: Favorite[];
  activeTabId: string | null;
  /**
   * サイドバーで選択中のグループ。横タブバーはこのグループのタブを並べる。
   *
   * activeTabId から導出せず独立して持つ理由: タブが 1 つもないグループを
   * 選択している状態を表現する必要があるため (新規グループ作成直後など)。
   * activeTabId が変わるときは常にこちらも同期する (syncGroupSelection)。
   *
   * 新規タブの行き先もこの値で決まる (resolveTabGroup)。再起動で選択が
   * 別のグループへ移ると、そのまま Ctrl+T したときに意図しないグループへ
   * タブが入るため、これだけは persist 対象にしている。
   */
  activeGroupId: string | null;
  /**
   * グループごとに「最後にアクティブだったタブ」を覚えておく辞書。
   * グループを切り替えて戻ってきたとき、先頭タブではなく直前に見ていた
   * タブへ復帰させるために使う。
   *
   * 削除済みタブの ID が残ることがあるため、参照側で存在を確認すること
   * (掃除しないのは、タブ削除のたびに全グループを走査する方が高コストなため)。
   * ランタイム状態のため persist 対象外。
   */
  lastActiveTabByGroup: Record<string, string>;
  /**
   * D&D でドラッグ中の要素 ID と種別。ドラッグしていないときは null。
   *
   * DndContext は App 直下に置かれ、Sidebar と TabBar の両方を包む。
   * 両者が「いまタブをドラッグ中か」を知る必要があるため、React context ではなく
   * store に置いて購読できるようにしている。ランタイム状態のため persist 対象外。
   */
  dragId: string | null;
  dragKind: DragKind | null;
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
  /** インストール済 WSL distro 一覧。App 起動時に Rust 側から取得し、persist 対象外。
   *  Phase 4 P-K で追加。 */
  wslDistros: string[];

  // --- Claude の実行情報スライス (persist 対象外) ---
  /**
   * アクティブタブで動いている Claude のモデル / effort / コンテキスト量。
   *
   * **アクティブタブぶんしか持たない。** 会話ログは 50MB を超えることがあり、
   * 全タブぶんを数秒ごとに読むのは割に合わない。tabId を併せて持つのは、
   * タブを切り替えた直後に前のタブの値を出さないため。
   *
   * ランタイム状態のため persist 対象外（起動のたびに読み直す）。
   */
  claudeMeta: { tabId: string; meta: ClaudeTranscriptMeta } | null;
  /**
   * プラン利用量 (5 時間ウィンドウ / 週次)。タブに依らずアカウント単位。
   * 取得できない環境（未ログイン・オフライン）では null のまま。
   */
  claudeUsage: ClaudeUsageLimits | null;

  // --- closedTabs スタック (persist 対象外) ---
  /**
   * 閉じたタブの復元用スタック。最大 10 個。再起動でクリアされる。
   * Ctrl+Shift+T で最新の閉じたタブを復元する。
   */
  closedTabs: ClosedTab[];

  // --- updater スライス (persist 対象外) ---
  /** 自動更新の新バージョン情報。利用可能な更新がない場合は null。 */
  updateInfo: UpdateInfo | null;
  /** 自動更新フェーズ。 */
  updatePhase: UpdatePhase;
  /** ダウンロード進捗 (0..1)。不明時は -1。 */
  updateProgress: number;
  /** 更新処理中のエラーメッセージ。エラーがない場合は null。 */
  updateError: string | null;
  /** 更新ダイアログの表示状態。 */
  updateDialogOpen: boolean;
  /**
   * 前回の更新が反映されないまま起動したときに立つ。通知したら null に戻す。
   * updatePhase とは独立しており、通常の更新フローを妨げない。
   */
  updateInstallFailure: UpdateInstallFailure | null;
}
