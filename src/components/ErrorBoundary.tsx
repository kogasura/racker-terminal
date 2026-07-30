import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * 描画中の例外を受け止めて内容を画面に出す。
 *
 * これが無いと React はツリーごとアンマウントするため、アプリは白画面になる。
 * Tauri の release ビルドでは DevTools を開けないので、白画面のままでは
 * 何が起きたのか手元で調べる術がない。原因調査の足がかりを残すために置いている。
 *
 * 想定は「開発者に見せる」用途で、ユーザー向けの体裁は整えていない。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // DevTools を開ける環境（dev ビルド）では console にも残す
    console.error('[ErrorBoundary] 描画中に例外が発生しました:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleCopy = () => {
    const { error, componentStack } = this.state;
    const text = [
      `message: ${error?.message ?? '(なし)'}`,
      '',
      'stack:',
      error?.stack ?? '(なし)',
      '',
      'component stack:',
      componentStack ?? '(なし)',
    ].join('\n');
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  override render() {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h1 className="error-boundary__title">アプリの描画に失敗しました</h1>
        <p className="error-boundary__lead">
          下の内容を添えて報告してください。「コピー」で全文をクリップボードに取れます。
        </p>

        <div className="error-boundary__actions">
          <button type="button" onClick={this.handleCopy}>
            コピー
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>

        <h2 className="error-boundary__section">エラー</h2>
        <pre className="error-boundary__pre">{error.message}</pre>

        <h2 className="error-boundary__section">スタック</h2>
        <pre className="error-boundary__pre">{error.stack ?? '(なし)'}</pre>

        <h2 className="error-boundary__section">コンポーネント</h2>
        <pre className="error-boundary__pre">{componentStack ?? '(なし)'}</pre>
      </div>
    );
  }
}
