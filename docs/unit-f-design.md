# Unit F 設計書 — D&D (タブ並び替え + グループ間移動)

## 1. 概要・スコープ

Phase 2 Unit F では `@dnd-kit/core` + `@dnd-kit/sortable` を導入し、サイドバーのタブを D&D で並び替え可能にする。

### Phase 2 対象
- 同一グループ内のタブ並び替え
- タブをドラッグして別グループの末尾へ移動
- DragOverlay (幽霊タブの Portal 描画)
- D&D 開始時の `stopEditing()` 呼び出し (InlineEdit との競合回避)
- PointerSensor + activationConstraint: { distance: 8 }

### Phase 2.5 / 3 送り
- グループ自体の D&D 並び替え (store の `moveGroup` は Unit B で先回り実装済み)
- タブを新規グループとしてドロップ
- ドラッグ中のグループ跨ぎリアルタイムプレビュー
- Favorites の D&D
- キーボード D&D (sortableKeyboardCoordinates)
- グループ間 index 指定 drop (タブとタブの間への挿入)

---

## 2. dnd-kit 構造図

```
<DndContext sensors collisionDetection onDragStart onDragEnd>
  <Sidebar>
    <GroupSection groupId="g1">
      <GroupBody [useDroppable id="group-g1"]>
        <SortableContext items={tabIds} strategy={verticalListSortingStrategy}>
          <TabItem [useSortable id="t1" data={{ groupId }}]>
          <TabItem [useSortable id="t2" data={{ groupId }}]>
        </SortableContext>
        <button>+ Add Tab</button>
      </GroupBody>
    </GroupSection>
    <GroupSection groupId="g2">
      <GroupBody [useDroppable id="group-g2"]>
        <SortableContext items={tabIds}>
          <TabItem [useSortable id="t3" data={{ groupId }}]>
        </SortableContext>
      </GroupBody>
    </GroupSection>
  </Sidebar>

  {/* body Portal */}
  <DragOverlay>
    <TabItemPreview tab={activeDragTab} />
  </DragOverlay>
</DndContext>
```

---

## 3. onDragStart / onDragEnd フロー

### onDragStart
1. `setActiveDragId(event.active.id)` — DragOverlay 描画用
2. `useAppStore.getState().stopEditing()` — InlineEdit を確定/キャンセルして D&D を優先

### onDragEnd
```
setActiveDragId(null)

if (!over || active.id === over.id) return  // drop なし or 同位置

activeTabId = active.id
fromGroupId = active.data.current?.groupId

if (over.id.startsWith('group-')):
  // GroupBody への drop = 末尾追加
  toGroupId = over.id.replace('group-', '')
  toIndex = groups[toGroupId].tabIds.length

else:
  // タブへの drop = そのタブの位置に挿入
  overTab = tabs[over.id]
  toGroupId = overTab.groupId
  toIndex = groups[toGroupId].tabIds.indexOf(over.id)

moveTab(activeTabId, toGroupId, toIndex)
```

---

## 4. collisionDetection 選定理由

`closestCorners` を選択。

| 検討 | 評価 |
|---|---|
| `closestCenter` (dnd-kit デフォルト) | 縦リストで中心同士の距離を比較するため、グループ跨ぎでの境界判定が曖昧になりやすい |
| **`closestCorners`** | 要素の四隅で判定するため縦リストにおける drop ターゲット切替が安定する |
| `rectIntersection` | 重なり面積で判定するため、タブが半分以上重なるまで切替が起きず操作感が重い |

---

## 5. DragOverlay 仕様

- `createPortal(<DragOverlay>, document.body)` で body 直下に描画
- サイドバーの `overflow:hidden` に影響されない
- `activeDragTab` が null の間は `<DragOverlay>` の中身は空（自動的に非表示）
- `TabItemPreview` は status dot + title の最小構成

### z-index 規約
```
.tab-item--drag-overlay: z-index 10000
.context-menu__content:  z-index 9999   (既存)
```

DragOverlay がコンテキストメニューより前面に出る。

---

## 6. moveTab API

```ts
moveTab(tabId: string, toGroupId: string, toIndex: number): void
```

- fromGroup の tabIds から `tabId` を除去
- toGroup の tabIds の `toIndex` 位置に挿入
- `toIndex` は `[0, toGroup.tabIds.length (除去後)]` にクランプ
- 同一グループ内移動: from 除去後の配列に対してクランプ・挿入
- 不正な `tabId` / `toGroupId`: no-op
- 別グループへの移動時: `tab.groupId` フィールドも更新

---

## 7. 検証シナリオ

| ID | シナリオ | 期待結果 |
|---|---|---|
| VF01 | タブをドラッグして同グループ内で並び替え | tabIds 順序が変わる |
| VF02 | タブをドラッグして別グループへ | 末尾に追加される |
| VF03 | 編集中のタブをドラッグ | drag 開始しない (disabled) |
| VF04 | ドラッグ中に DragOverlay (幽霊タブ) が表示される | body に Portal 描画、サイドバー外でも見える |
| VF05 | ドラッグ中に右クリック | ContextMenu は通常通り起動 (独立イベント) |
| VF06 | 8px 未満のクリック | ドラッグ起動しない (誤発火防止) |
| VF07 | 空グループにタブをドロップ | そのグループに追加される |
| VF08 | 高速ドラッグ&ドロップを繰り返す | store が壊れない |
| VF09 | 大量タブ (50+) でもスムーズに動作する | fps が落ちない |

---

## 8. 後続ユニット送り

- **Unit H**: StrictMode + HMR 確認 (D&D 状態がリロード後にリセットされることの確認)
- **Phase 2.5**: グループ自体の D&D 並び替え (`moveGroup` は Unit B で先回り実装済み)
- **Phase 3**: Favorites の D&D、キーボード D&D、グループ間 index 指定 drop
