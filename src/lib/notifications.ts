import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';
import type { AgentState } from '../types';

/**
 * Claude タブの状態変化をデスクトップ通知として知らせる。
 *
 * サイドバーのステータスドットは racker のウィンドウを見ていないと意味がない。
 * 複数プロジェクトを並行で回していると、別のアプリで作業している間に
 * Claude が応答待ちのまま止まっていることに気付けない。
 * この経路だけが「見ていなくても届く」通知になる。
 */

/** 通知の種類。 */
export type NotificationKind = 'blocked' | 'done';

/**
 * 状態遷移が通知に値するかを判定する純関数。
 *
 * 通知するのは **状態が変わった瞬間だけ**。ポーリングのたびに同じ状態が
 * 報告され続けても鳴らさない（blocked のまま放置すると鳴り続けてしまう）。
 *
 * アクティブタブは通知しない。画面に出ているものをわざわざ通知する必要がなく、
 * むしろ自分が見ている作業の邪魔になる。
 *
 * @param prev - 直前の状態
 * @param next - 新しい状態
 * @param isActive - そのタブが現在アクティブか
 * @returns 通知の種類。通知不要なら null
 */
export function shouldNotify(
  prev: AgentState | undefined,
  next: AgentState | undefined,
  isActive: boolean,
): NotificationKind | null {
  if (isActive) return null;
  if (prev === next) return null;
  if (next === 'blocked') return 'blocked';
  if (next === 'done') return 'done';
  return null;
}

/**
 * 通知の本文を組み立てる純関数。
 *
 * 応答待ちのときは理由 (`waitingFor`) があれば添える。
 * どのタブの話かが分からないと通知の意味がないので、タイトルは必ず入れる。
 */
export function notificationBody(
  kind: NotificationKind,
  tabTitle: string,
  waitingFor?: string,
): string {
  if (kind === 'blocked') {
    return waitingFor !== undefined
      ? `${tabTitle} が応答を待っています（${waitingFor}）`
      : `${tabTitle} が応答を待っています`;
  }
  return `${tabTitle} の処理が完了しました`;
}

/** 通知のタイトル（Windows のトーストで太字になる行）。 */
export function notificationTitle(kind: NotificationKind): string {
  return kind === 'blocked' ? 'Claude が応答待ちです' : 'Claude の処理が完了しました';
}

/**
 * 通知権限の状態をキャッシュする。
 *
 * `isPermissionGranted` / `requestPermission` は毎回 IPC を伴うため、
 * 状態が変わるたびに問い合わせると通知のたびに往復が発生する。
 * 一度許可されたら以降は省略する。
 */
let permissionGranted: boolean | null = null;

/**
 * 通知権限を確認し、未許可ならユーザーに要求する。
 *
 * 拒否された場合は false を返し、以降は要求を繰り返さない
 * （起動のたびに許可ダイアログを出すと鬱陶しいため）。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    permissionGranted = granted;
    return granted;
  } catch (e) {
    // 通知が使えない環境でもアプリ本体は動き続けるべきなので握り潰す
    console.warn('[notifications] permission check failed:', e);
    permissionGranted = false;
    return false;
  }
}

/**
 * デスクトップ通知を送る。失敗しても例外は投げない。
 *
 * 通知は「あると嬉しい」機能であり、ここでの失敗がターミナルの動作に
 * 影響してはいけないため、すべて握り潰す。
 */
export async function notifyAgentState(
  kind: NotificationKind,
  tabTitle: string,
  waitingFor?: string,
): Promise<void> {
  if (!(await ensureNotificationPermission())) return;
  try {
    sendNotification({
      title: notificationTitle(kind),
      body: notificationBody(kind, tabTitle, waitingFor),
    });
  } catch (e) {
    console.warn('[notifications] sendNotification failed:', e);
  }
}

/** テスト用に権限キャッシュを初期化する。 */
export function resetPermissionCacheForTest(): void {
  permissionGranted = null;
}
