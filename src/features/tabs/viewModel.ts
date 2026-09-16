/**
 * タブ UI の描画パラメータ。純粋関数。
 *
 * タブのデータ自体はまだ store が持っているため、ここは「store のスナップショットから
 * 描画に要る値だけを取り出す」層になる。データを Mediator 側へ移すときも、
 * 入力の型が変わるだけで View 側は影響を受けない。
 */

/** サイドバー。 */
export interface SidebarViewModel {
  readonly groupIds: readonly string[];
  /** タブをドラッグ中か (「新規グループに追加」エリアの表示に使う)。 */
  readonly isDraggingTab: boolean;
}

/** 横タブバー。 */
export interface TabBarViewModel {
  /**
   * バーごと出すか。
   * グループが 1 つも選択されていない (= グループ自体が無い) ときは出さない。
   * App の初期化がグループを必ず 1 つ作るため、通常は起動直後の一瞬だけ。
   */
  readonly visible: boolean;
  /** 選択中グループに属するタブ。並び順そのまま。 */
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

export function selectSidebar(groupIds: readonly string[], isDraggingTab: boolean): SidebarViewModel {
  return { groupIds, isDraggingTab };
}

export function selectTabBar(
  activeGroupId: string | null,
  tabIds: readonly string[],
  activeTabId: string | null,
): TabBarViewModel {
  return { visible: activeGroupId !== null, tabIds, activeTabId };
}
