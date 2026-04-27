import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';

interface InlineEditProps {
  /** 編集対象の ID（tabId または groupId） */
  id: string;
  /** 現在のタイトル */
  title: string;
  /** 確定時に呼ばれるコールバック。新タイトルを渡す（空文字列の場合は元タイトル維持） */
  onCommit: (newTitle: string) => void;
  /** className は span（表示モード）に適用する */
  className?: string;
}

/**
 * サイドバー内インライン編集コンポーネント。
 *
 * - editingId === id のとき input を表示（編集モード）
 * - それ以外は span を表示（表示モード）
 * - IME 対応: onCompositionStart/End で isComposing を管理し、IME 中の Enter を無視
 * - onKeyDown で stopPropagation を呼ぶ（Sidebar の Enter/Space ヘッダ操作との競合防止）
 * - 確定: Enter / blur / 外クリック → onCommit(value) + stopEditing
 * - キャンセル: Escape → stopEditing のみ（元タイトル維持）
 */
export function InlineEdit({ id, title, onCommit, className }: InlineEditProps) {
  const editingId = useAppStore((s) => s.editingId);
  const stopEditing = useAppStore((s) => s.stopEditing);

  const isEditing = editingId === id;
  const [value, setValue] = useState(title);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 編集モードに入った瞬間に value を現在の title に同期し、input にフォーカスを当てる
  useEffect(() => {
    if (isEditing) {
      setValue(title);
      // rAF で DOM が確定してからフォーカスを当てる
      const rafId = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(rafId);
    }
  // title は編集開始時の初期値として参照するため、isEditing が true になった瞬間のみ適用する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  function commit() {
    onCommit(value);
    stopEditing();
  }

  function cancel() {
    stopEditing();
  }

  if (!isEditing) {
    return (
      <span className={className} title={title}>
        {title}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className="inline-edit__input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={() => { isComposingRef.current = false; }}
      onKeyDown={(e) => {
        // Sidebar の Enter/Space ヘッダ操作との競合を防ぐ
        e.stopPropagation();

        if (e.key === 'Enter') {
          // IME 確定中の Enter は無視（日本語変換の確定だけ行う）
          if (isComposingRef.current) return;
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          // IME 中の Escape も stopEditing で OK（IME キャンセル同等）
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      // クリックイベントを親（タブ/グループ）に伝播させない
      onClick={(e) => e.stopPropagation()}
    />
  );
}
