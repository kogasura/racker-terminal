import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act } from 'react';
import { render as rtlRender, cleanup } from '@testing-library/react';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useAppStore } from '../store/appStore';
import { TabItem } from './TabItem';
import { GroupSection } from './GroupSection';
import { FavoriteDialog } from './FavoriteDialog';
import { SettingsDialog } from './SettingsDialog';
import { UpdaterRoot } from '../features/updater/UpdaterRoot';
import { TabsRoot } from '../features/tabs/TabsRoot';
import { ClaudeStatusRoot } from '../features/claudeStatus/ClaudeStatusRoot';
import type { ClaudeStatusEvent } from '../features/claudeStatus/events';
import { useEmit } from '../architecture/chain';
import { StatusBar } from './StatusBar';

// Tauri の invoke / plugin はテスト環境に存在しないのでスタブする。
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn().mockResolvedValue('0.0.0-test') }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

/**
 * コンポーネントのレンダリング・スモークテスト。
 *
 * 目的は「描画時に例外を投げないこと」の担保。ユニットテストは純粋関数に
 * 寄っており、コンポーネントが実際に描画できるかは誰も見ていなかった。
 * 描画時の例外はアプリ全体が落ちる形で表面化するため、最低限ここで止める。
 */
/**
 * 機能 Root を敷いたうえで描画する。
 *
 * コンポーネントは View モデルを Root から受け取り、操作をチェーンへ流すため、
 * 単体で描画するには Root が要る。updater は ready={false} で初回チェックを止める
 * (スモークテストで通信させない)。
 */
function AppRoots({ children }: { children: ReactNode }) {
  return (
    <UpdaterRoot ready={false}>
      <TabsRoot>
        {/* fetchUsage={null} でプラン利用量のポーリングを止める（テストで通信させない） */}
        <ClaudeStatusRoot fetchUsage={null}>{children}</ClaudeStatusRoot>
      </TabsRoot>
    </UpdaterRoot>
  );
}

function render(ui: ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: AppRoots, ...options });
}

function renderSettings(onClose: () => void = () => {}) {
  return render(<SettingsDialog onClose={onClose} />);
}

/**
 * Mediator に状態を流し込むためのテスト用コンポーネント。
 *
 * ステータスバーの状態は store ではなく Mediator が持つので、
 * 実際の経路（チェーン → Mediator → View モデル）で注入する。
 */
function EmitOnMount({ events }: { events: readonly ClaudeStatusEvent[] }) {
  const emit = useEmit<ClaudeStatusEvent>();
  useEffect(() => {
    for (const e of events) emit(e);
    // events はテストごとに固定なので初回だけでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** ステータスバーを、与えた状態で描画する。 */
function renderStatusBar(events: readonly ClaudeStatusEvent[]) {
  return render(
    <>
      <EmitOnMount events={events} />
      <StatusBar />
    </>,
  );
}

describe('コンポーネントのレンダリング', () => {
  beforeEach(() => {
    // 各テストで store を既知の状態に戻す
    useAppStore.setState({
      groups: [{ id: 'g1', title: 'Default', collapsed: false, tabIds: ['t1'] }],
      tabs: {
        t1: { id: 't1', groupId: 'g1', status: 'live', userTitle: 'タブ1' },
      },
      activeTabId: 't1',
      activeGroupId: 'g1',
      favorites: [],
      editingId: null,
      wslDistros: [],
      // ステータスバーの表示設定はテスト間で持ち越さない（既定 = 有効に戻す）
      settings: { ...useAppStore.getState().settings, statusBarEnabled: undefined },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('TabItem が描画できる', () => {
    expect(() => render(<TabItem tabId="t1" isActive />)).not.toThrow();
  });

  it('TabItem が PR 情報つきでも描画できる', () => {
    useAppStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        t1: {
          ...s.tabs.t1,
          prNumber: 42,
          prState: 'OPEN',
          prBranch: 'feature/x',
          prUrl: 'https://example.com/pr/42',
        },
      },
    }));
    const { container } = render(<TabItem tabId="t1" isActive />);
    expect(container.textContent).toContain('#42');
  });

  it('TabItem は PR が無ければバッジを出さない', () => {
    const { container } = render(<TabItem tabId="t1" isActive />);
    expect(container.querySelector('.tab-item__pr')).toBeNull();
  });

  it('存在しない tabId でも TabItem は落ちない', () => {
    expect(() => render(<TabItem tabId="missing" isActive={false} />)).not.toThrow();
  });

  it('GroupSection が描画できる', () => {
    expect(() => render(<GroupSection groupId="g1" />)).not.toThrow();
  });

  it('GroupSection が agentState つきでも描画できる', () => {
    useAppStore.setState((s) => ({
      tabs: { ...s.tabs, t1: { ...s.tabs.t1, agentState: 'blocked' } },
    }));
    const { container } = render(<GroupSection groupId="g1" />);
    expect(container.querySelector('.group-header__agent')).not.toBeNull();
  });

  it('GroupSection は agentState が idle ならインジケータを出さない', () => {
    useAppStore.setState((s) => ({
      tabs: { ...s.tabs, t1: { ...s.tabs.t1, agentState: 'idle' } },
    }));
    const { container } = render(<GroupSection groupId="g1" />);
    expect(container.querySelector('.group-header__agent')).toBeNull();
  });

  it('存在しない groupId でも GroupSection は落ちない', () => {
    expect(() => render(<GroupSection groupId="missing" />)).not.toThrow();
  });

  it('FavoriteDialog が add モードで描画できる', () => {
    expect(() =>
      render(<FavoriteDialog mode="add" onSubmit={() => {}} onClose={() => {}} />),
    ).not.toThrow();
  });

  it('FavoriteDialog が edit モード（通常のお気に入り）で描画できる', () => {
    expect(() =>
      render(
        <FavoriteDialog
          mode="edit"
          initial={{
            id: 'f1',
            title: 'テスト',
            shell: 'pwsh.exe',
            cwd: 'C:\\work',
            args: ['-NoLogo'],
            env: { FOO: 'bar' },
          }}
          onSubmit={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it('FavoriteDialog が edit モード（WSL 標準形）で描画できる', () => {
    useAppStore.setState({ wslDistros: ['Ubuntu-22.04'] });
    render(
      <FavoriteDialog
        mode="edit"
        initial={{
          id: 'f2',
          title: 'WSL',
          shell: 'wsl.exe',
          args: ['-d', 'Ubuntu-22.04', '--cd', '~/dev'],
        }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    // Radix の Dialog は Portal 経由で body 直下に描画される
    // WSL 簡易フォームなので distro の select と「引数を手動で指定する」導線が出る
    expect(document.body.textContent).toContain('WSL ディストリビューション');
    expect(document.body.textContent).toContain('引数を手動で指定する');
  });

  it('FavoriteDialog は未インストールの distro でも選択肢に残す', () => {
    // wslDistros が空でも、既存お気に入りが指す distro は distroOptions に載る
    useAppStore.setState({ wslDistros: [] });
    render(
      <FavoriteDialog
        mode="edit"
        initial={{ id: 'f4', title: 'WSL', shell: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '~'] }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    const select = document.body.querySelector('select.dialog-input:not([value=""])');
    expect(select, 'distro の select が見つからない').toBeTruthy();
    expect(document.body.textContent).toContain('Ubuntu');
  });

  it('FavoriteDialog が edit モード（WSL 手動引数）で描画できる', () => {
    expect(() =>
      render(
        <FavoriteDialog
          mode="edit"
          initial={{
            id: 'f3',
            title: 'WSL manual',
            shell: 'wsl.exe',
            args: ['-d', 'Ubuntu', '--', 'bash', '-ic', 'echo hi'],
          }}
          onSubmit={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it('SettingsDialog が描画できる', () => {
    expect(() => renderSettings()).not.toThrow();
  });
});

/**
 * 実際の操作を伴うテスト。
 * 描画できても操作で落ちるケース（イベントハンドラ内の例外）を拾う。
 */
describe('コンポーネントの操作', () => {
  beforeEach(() => {
    useAppStore.setState({
      groups: [{ id: 'g1', title: 'Default', collapsed: false, tabIds: ['t1'] }],
      tabs: { t1: { id: 't1', groupId: 'g1', status: 'live', userTitle: 'タブ1' } },
      activeTabId: 't1',
      activeGroupId: 'g1',
      favorites: [],
      editingId: null,
      wslDistros: ['Ubuntu-22.04'],
    });
  });

  afterEach(() => cleanup());

  it('FavoriteDialog: WSL 簡易フォーム → 手動引数モードに切り替えられる', async () => {
    render(
      <FavoriteDialog
        mode="edit"
        initial={{
          id: 'f1',
          title: 'WSL',
          shell: 'wsl.exe',
          args: ['-d', 'Ubuntu-22.04', '--cd', '~/dev'],
        }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    const toManual = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === '引数を手動で指定する',
    );
    expect(toManual, '手動モードへの導線が見つからない').toBeTruthy();

    await act(async () => {
      toManual!.click();
    });

    // 手動モードでは args テキストエリアが出て、簡易フォームに戻す導線が現れる
    expect(document.body.textContent).toContain('引数 (任意)');
    expect(document.body.textContent).toContain('WSL 簡易フォームに戻す');
  });

  it('FavoriteDialog: 手動引数モード → WSL 簡易フォームに戻せる', async () => {
    render(
      <FavoriteDialog
        mode="edit"
        initial={{
          id: 'f1',
          title: 'WSL',
          shell: 'wsl.exe',
          args: ['-d', 'Ubuntu-22.04', '--cd', '~/dev'],
        }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    const toManual = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === '引数を手動で指定する',
    );
    await act(async () => toManual!.click());

    const toWsl = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'WSL 簡易フォームに戻す',
    );
    expect(toWsl, '簡易フォームへ戻す導線が見つからない').toBeTruthy();
    await act(async () => toWsl!.click());

    expect(document.body.textContent).toContain('WSL ディストリビューション');
  });

  it('FavoriteDialog: 送信すると入力内容が onSubmit に渡る', async () => {
    const onSubmit = vi.fn();
    render(
      <FavoriteDialog
        mode="edit"
        initial={{ id: 'f1', title: 'テスト', shell: 'pwsh.exe', cwd: 'C:\\work' }}
        onSubmit={onSubmit}
        onClose={() => {}}
      />,
    );
    const form = document.body.querySelector('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ title: 'テスト', shell: 'pwsh.exe' });
  });

  it('SettingsDialog: 送信しても落ちない', async () => {
    renderSettings();
    const form = document.body.querySelector('form');
    expect(form, 'form が見つからない').toBeTruthy();
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  });

  it('StatusBar: 出す情報が何も無ければ帯ごと消える', () => {
    const { container } = renderStatusBar([]);
    expect(container.querySelector('.status-bar')).toBeNull();
  });

  it('StatusBar: モデル・effort・コンテキスト量・利用量を出す', () => {
    const { container } = renderStatusBar([
      {
        type: 'claude-status/meta-observed',
        tabId: 't1',
        meta: { model: 'claude-opus-5', effort: 'high', contextTokens: 55_002 },
      },
      {
        type: 'claude-status/usage-observed',
        usage: { fiveHourPercent: 13, sevenDayPercent: 22 },
      },
    ]);
    const text = container.textContent ?? '';
    expect(text).toContain('Opus 5');
    expect(text).toContain('high');
    expect(text).toContain('55k / 200k (28%)');
    expect(text).toContain('5h 13%');
    expect(text).toContain('週 22%');
  });

  it('StatusBar: 別タブの情報は出さない（切り替え直後に前のタブの値を残さない）', () => {
    const { container } = renderStatusBar([
      {
        type: 'claude-status/meta-observed',
        tabId: 'other',
        meta: { model: 'claude-opus-5', contextTokens: 1000 },
      },
      { type: 'claude-status/usage-observed', usage: { fiveHourPercent: 13 } },
    ]);
    expect(container.textContent).not.toContain('Opus 5');
    expect(container.textContent).toContain('5h 13%');
  });

  it('StatusBar: 設定で無効にすると描画しない', () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, statusBarEnabled: false },
    });
    const { container } = renderStatusBar([
      { type: 'claude-status/usage-observed', usage: { fiveHourPercent: 13 } },
    ]);
    expect(container.querySelector('.status-bar')).toBeNull();
  });

  it('TabItem: クリックでアクティブタブが切り替わる', async () => {
    useAppStore.setState((s) => ({
      groups: [{ ...s.groups[0], tabIds: ['t1', 't2'] }],
      tabs: { ...s.tabs, t2: { id: 't2', groupId: 'g1', status: 'live', userTitle: 'タブ2' } },
    }));
    const { container } = render(<TabItem tabId="t2" isActive={false} />);
    await act(async () => {
      container.querySelector<HTMLElement>('.tab-item')!.click();
    });
    expect(useAppStore.getState().activeTabId).toBe('t2');
  });
});
