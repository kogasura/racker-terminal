import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

/** 描画時に必ず投げるコンポーネント。 */
function Boom(): never {
  throw new Error('描画に失敗するテスト用の例外');
}

/** 無限再レンダーを模した「更新深度超過」。React はこれも例外として投げる。 */
function ThrowsUpdateDepth(): never {
  throw new Error('Maximum update depth exceeded');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React が投げるエラーを console に出すのでテスト出力を汚さないよう抑制する
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('例外が無ければ子をそのまま描画する', () => {
    const { container } = render(
      <ErrorBoundary>
        <div>正常な中身</div>
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('正常な中身');
  });

  it('描画時の例外を受け止めてメッセージを表示する（白画面にしない）', () => {
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('アプリの描画に失敗しました');
    expect(container.textContent).toContain('描画に失敗するテスト用の例外');
  });

  it('スタックとコンポーネント情報も出す', () => {
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('スタック');
    expect(container.textContent).toContain('コンポーネント');
    // Boom がスタックに現れること（どこで落ちたか分かること）
    expect(container.textContent).toContain('Boom');
  });

  it('無限再レンダー（更新深度超過）も受け止める', () => {
    const { container } = render(
      <ErrorBoundary>
        <ThrowsUpdateDepth />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('Maximum update depth exceeded');
  });

  it('再読み込みボタンとコピーボタンを出す', () => {
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('コピー');
    expect(labels).toContain('再読み込み');
  });
});
