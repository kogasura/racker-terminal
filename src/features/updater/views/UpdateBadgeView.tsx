/**
 * タイトルバーの更新バッジの Passive View。
 *
 * 出すかどうか (`visible`)、何色か (`variant`)、何と読ませるか (`description`) は
 * すべて View モデル側で決まっている。ここはクリックを上へ流すだけ。
 */

import { useEmit } from '../../../architecture/chain';
import type { UpdaterEvent } from '../events';
import type { BadgeViewModel } from '../viewModel';

export interface UpdateBadgeViewProps {
  readonly vm: BadgeViewModel;
}

export function UpdateBadgeView({ vm }: UpdateBadgeViewProps) {
  const emit = useEmit<UpdaterEvent>();

  if (!vm.visible) return null;

  return (
    <button
      type="button"
      className="title-bar__update-badge"
      data-variant={vm.variant}
      onClick={() => emit({ type: 'updater/badge-clicked' })}
      aria-label={vm.description}
      title={vm.description}
    >
      {vm.label}
    </button>
  );
}
