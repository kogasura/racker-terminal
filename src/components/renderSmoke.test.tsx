import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act } from 'react';
import { render as rtlRender, cleanup, fireEvent } from '@testing-library/react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useAppStore } from '../store/appStore';
import { TabItem } from './TabItem';
import { GroupSection } from './GroupSection';
import { FavoriteDialog } from './FavoriteDialog';
import { SettingsDialog } from './SettingsDialog';
import { UpdaterRoot } from '../features/updater/UpdaterRoot';
import { TabsRoot } from '../features/tabs/TabsRoot';
import { ClaudeStatusRoot } from '../features/claudeStatus/ClaudeStatusRoot';
import { SettingsRoot } from '../features/settings/SettingsRoot';
import { ThemeRoot, useThemeCatalogRef, type ThemeCatalogRef } from '../features/theme/ThemeRoot';
import type { EffectDeps as ThemeEffectDeps } from '../features/theme/effects';
import { USER_THEMES_CACHE_KEY, WINDOW_THEME_CACHE_KEY } from '../features/theme/themeCache';
import type { ClaudeStatusEvent } from '../features/claudeStatus/events';
import { useEmit } from '../architecture/chain';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';
import { Sidebar } from './Sidebar';
import { DragDropProvider } from './DragDropProvider';
import { BUILTIN_THEMES } from '../lib/theme/builtinThemes';

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
 * テーマの読み込みの差し替え。自作テーマ 1 件と、壊れたファイル 1 件を返す。
 * 選択肢の optgroup と、読み込めなかったファイルの一覧が出ることを見るため。
 */
/** 窓に当たったテーマを accent で見分ける。 */
const accentOf = (id: string) => BUILTIN_THEMES.find((t) => t.id === id)!.ui.accent;
const TOKYO_NIGHT_ACCENT = accentOf('tokyo-night');
const DRACULA_ACCENT = accentOf('dracula');

const themeDeps: ThemeEffectDeps = {
  listUserThemes: () =>
    Promise.resolve([
      {
        fileName: 'sunset.json',
        content: JSON.stringify({ name: 'Sunset', ui: { accent: '#ff8800' } }),
        error: null,
      },
      { fileName: 'broken.json', content: '{', error: null },
    ]),
  ensureThemesDir: () => Promise.resolve(null),
  openThemesDir: () => Promise.resolve(false),
  openClaudeTab: () => {},
};

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
      <SettingsRoot>
        {/* テーマは設定を引くので SettingsRoot の内側。ファイルの読み込みは差し替える */}
        <ThemeRoot ready deps={themeDeps}>
          <TabsRoot>
            {/* fetchUsage={null} でプラン利用量のポーリングを止める（テストで通信させない） */}
            <ClaudeStatusRoot fetchUsage={null}>{children}</ClaudeStatusRoot>
          </TabsRoot>
        </ThemeRoot>
      </SettingsRoot>
    </UpdaterRoot>
  );
}

function render(ui: ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: AppRoots, ...options });
}

function renderSettings(onClose: () => void = () => {}) {
  return render(<SettingsDialog onClose={onClose} />);
}

/** 設定ダイアログのテーマのカード (名前で引く)。 */
function themeCard(name: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button.theme-card')].find(
    (b) => b.querySelector('.theme-card__name')?.textContent === name,
  );
}

/** 押されている (選択中の) カードの名前。 */
function pressedCards(): string[] {
  return [...document.body.querySelectorAll('button.theme-card[aria-pressed="true"]')].map(
    (b) => b.querySelector('.theme-card__name')?.textContent ?? '',
  );
}

/** 窓に当たっている accent の色。試しに表示の反映を見るのに使う。 */
function windowAccent(): string {
  return document.documentElement.style.getPropertyValue('--rk-accent');
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
      quickAccess: [],
      // ステータスバーの表示設定とテーマはテスト間で持ち越さない（既定に戻す）
      settings: {
        ...useAppStore.getState().settings,
        statusBarEnabled: undefined,
        theme: 'tokyo-night',
      },
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

  // TabBar / Sidebar は D&D のコンテキスト (DndContext) も要るため、
  // DragDropProvider ごと包んで描画する。
  it('TabBar が描画できる', () => {
    expect(() =>
      render(
        <DragDropProvider>
          <TabBar />
        </DragDropProvider>,
      ),
    ).not.toThrow();
  });

  it('TabBar: グループが無ければバーごと消える', () => {
    useAppStore.setState({ activeGroupId: null });
    const { container } = render(
      <DragDropProvider>
        <TabBar />
      </DragDropProvider>,
    );
    expect(container.querySelector('.tab-bar')).toBeNull();
  });

  it('Sidebar が描画できる', () => {
    expect(() =>
      render(
        <DragDropProvider>
          <Sidebar />
        </DragDropProvider>,
      ),
    ).not.toThrow();
  });

  it('Sidebar: クイックアクセスが無ければセクションを出さず、あれば行をクリックで claude タブを開く', () => {
    useAppStore.setState({ quickAccess: [] });
    const empty = render(
      <DragDropProvider>
        <Sidebar />
      </DragDropProvider>,
    );
    expect(empty.container.querySelector('.quick-access-item')).toBeNull();
    cleanup();

    useAppStore.setState({ quickAccess: [{ name: 'dev', path: 'C:/Users/me/dev' }] });
    const { container } = render(
      <DragDropProvider>
        <Sidebar />
      </DragDropProvider>,
    );
    const row = container.querySelector<HTMLButtonElement>('.quick-access-item');
    expect(row?.textContent).toContain('dev');

    act(() => row?.click());
    const opened = Object.values(useAppStore.getState().tabs).find(
      (t) => t.cwd === 'C:/Users/me/dev',
    );
    expect(opened).toMatchObject({ userTitle: 'dev', launchClaude: true });
  });

  it('SettingsDialog が描画できる', () => {
    expect(() => renderSettings()).not.toThrow();
  });

  it('SettingsDialog: テーマをカードの一覧 (4 グループ) で出し、読めなかったファイルを並べる', async () => {
    renderSettings();
    // 自作テーマの読み込み (Promise) が終わるのを待つ
    await act(async () => {});

    const list = document.body.querySelector('.theme-cards');
    expect(list, 'テーマのカードの一覧が見つからない').toBeTruthy();
    const groups = [...list!.querySelectorAll('.theme-card-group')].map((g) =>
      g.getAttribute('aria-label'),
    );
    expect(groups).toEqual(['配色だけ', '動く背景（ダーク）', '動く背景（ライト）', '自分のテーマ']);
    expect(themeCard('Tokyo Night')).toBeTruthy();
    expect(themeCard('Honu Lagoon')).toBeTruthy();
    expect(themeCard('Sunset')).toBeTruthy();
    // 選択中は設定のテーマ 1 枚だけ
    expect(pressedCards()).toEqual(['Tokyo Night']);
    // 背景付きのカードには、ひとこと説明とライト / ダークが出る
    const honu = themeCard('Honu Lagoon')!;
    expect(honu.querySelector('.theme-card__meta')?.textContent).toBe('ライト');
    expect(honu.querySelector('.theme-card__blurb')?.textContent).toBeTruthy();

    const text = document.body.textContent ?? '';
    expect(text).toContain('broken.json');
    expect(text).toContain('フォルダを開く');
    expect(text).toContain('Claude でテーマを作る');
    expect(text).toContain('再読み込み');
  });

  it('SettingsDialog: 設定のテーマがカタログに無ければ「見つかりません」と出し、値を保持する', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'user:deleted' },
    });
    renderSettings();
    await act(async () => {});

    expect(document.body.textContent).toContain('（見つかりません: user:deleted）');
    expect(pressedCards()).toEqual([]);
    // 何も押さずに保存しても、別のテーマに変わらない
    const form = document.body.querySelector('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(useAppStore.getState().settings.theme).toBe('user:deleted');
  });

  it('SettingsDialog: 自分のテーマが無ければ、カードの一覧は 3 グループ', async () => {
    const spy = vi.spyOn(themeDeps, 'listUserThemes').mockResolvedValue([]);
    try {
      renderSettings();
      await act(async () => {});
      const groups = [...document.body.querySelectorAll('.theme-card-group')].map((g) =>
        g.getAttribute('aria-label'),
      );
      expect(groups).toEqual(['配色だけ', '動く背景（ダーク）', '動く背景（ライト）']);
    } finally {
      spy.mockRestore();
    }
  });

  it('useThemeCatalogRef: テーマを読み込んでも描き直さず、current は最新のカタログを指す', async () => {
    // 前のテストが覚えさせた自作テーマのキャッシュを消し、読み込み前のカタログに入らないようにする
    localStorage.clear();
    let renders = 0;
    let seen: ThemeCatalogRef | null = null;
    function Probe() {
      renders += 1;
      seen = useThemeCatalogRef();
      return null;
    }
    render(<Probe />);
    const first = seen as ThemeCatalogRef | null;
    // 読み込み前は自作テーマが無い
    expect(first!.current.map((t) => t.id)).not.toContain('user:sunset');
    // 自作テーマの読み込み (Promise) が終わるのを待つ
    await act(async () => {});

    expect(renders).toBe(1);
    expect(seen).toBe(first);
    expect(first!.current.map((t) => t.id)).toContain('user:sunset');
  });

  it('FavoriteDialog: テーマの選択肢を 4 グループで出し (背景付きも選べる)、先頭は「アプリの設定に従う」', async () => {
    render(
      <FavoriteDialog
        mode="edit"
        initial={{ id: 'f5', title: 'Ember', themeId: 'racker-ember' }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    await act(async () => {});

    const select = [...document.body.querySelectorAll('select')].find((s) =>
      s.querySelector('option[value="racker-ember"]'),
    );
    expect(select, 'テーマの select が見つからない').toBeTruthy();
    expect(select!.options[0].value).toBe('');
    expect(select!.options[0].textContent).toBe('アプリの設定に従う');
    expect(select!.value).toBe('racker-ember');
    expect([...select!.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      '配色だけ',
      '動く背景（ダーク）',
      '動く背景（ライト）',
      '自分のテーマ',
    ]);
    expect(select!.querySelector('option[value="scene:honu-lagoon"]')).not.toBeNull();
    expect(select!.querySelector('option[value="scene:night-reef"]')).not.toBeNull();
    expect(select!.querySelector('option[value="user:sunset"]')).not.toBeNull();
    expect(document.body.textContent).toContain('テーマ');
    expect(document.body.textContent).not.toContain('ターミナルの配色');
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

  it('SettingsDialog: カードを押すと窓に試しに表示し、保存すると設定に入って試しに表示を終える', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    const onClose = vi.fn();
    renderSettings(onClose);
    await act(async () => {});
    expect(windowAccent()).toBe(TOKYO_NIGHT_ACCENT);

    await act(async () => themeCard('Dracula')!.click());
    // 保存するまでは設定を変えないが、窓には試しに表示する
    expect(useAppStore.getState().settings.theme).toBe('tokyo-night');
    expect(windowAccent()).toBe(DRACULA_ACCENT);
    expect(pressedCards()).toEqual(['Dracula']);

    const form = document.body.querySelector('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(useAppStore.getState().settings.theme).toBe('dracula');
    expect(onClose).toHaveBeenCalledTimes(1);
    // 試しに表示を終えても、確定したテーマのまま
    expect(windowAccent()).toBe(DRACULA_ACCENT);
    // アプリの設定に戻しても窓が追従する (試しに表示が残っていない)
    await act(async () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
      });
    });
    expect(windowAccent()).toBe(TOKYO_NIGHT_ACCENT);
  });

  it('SettingsDialog: 試しに表示してキャンセルすると、設定は変えず窓が元のテーマに戻る', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    const onClose = vi.fn();
    renderSettings(onClose);
    await act(async () => {});

    await act(async () => themeCard('Dracula')!.click());
    expect(windowAccent()).toBe(DRACULA_ACCENT);

    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'キャンセル',
    );
    await act(async () => cancel!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().settings.theme).toBe('tokyo-night');
    expect(windowAccent()).toBe(TOKYO_NIGHT_ACCENT);
  });

  it('SettingsDialog: 試しに表示の間は、起動時のキャッシュに試したテーマを保存しない', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    localStorage.clear();
    renderSettings(() => {});
    await act(async () => {});
    expect(localStorage.getItem(WINDOW_THEME_CACHE_KEY)).toBe('tokyo-night');

    await act(async () => themeCard('Dracula')!.click());
    expect(windowAccent()).toBe(DRACULA_ACCENT);
    expect(localStorage.getItem(WINDOW_THEME_CACHE_KEY)).toBe('tokyo-night');

    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'キャンセル',
    );
    await act(async () => cancel!.click());
    expect(localStorage.getItem(WINDOW_THEME_CACHE_KEY)).toBe('tokyo-night');
  });

  it('SettingsDialog: 試しに表示しても、自作テーマのキャッシュは書き直さない', async () => {
    localStorage.clear();
    renderSettings(() => {});
    await act(async () => {});
    // 読み込みが終わった時点で 1 回は保存している
    expect(localStorage.getItem(USER_THEMES_CACHE_KEY)).not.toBeNull();

    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      await act(async () => themeCard('Dracula')!.click());
      await act(async () => themeCard('Nord')!.click());
      const cancel = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'キャンセル',
      );
      await act(async () => cancel!.click());

      const userThemeWrites = setItem.mock.calls.filter(([key]) => key === USER_THEMES_CACHE_KEY);
      expect(userThemeWrites).toEqual([]);
    } finally {
      setItem.mockRestore();
    }
  });

  it('ThemeRoot: 起動時のキャッシュには、使っている自作テーマの背景の SVG だけを入れる', async () => {
    localStorage.clear();
    const svg = (mark: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg"><rect id="${mark}" width="1" height="1"/></svg>`;
    const json = (name: string) =>
      JSON.stringify({ name, backdrop: { svg: `${name}.svg` } });
    const spy = vi.spyOn(themeDeps, 'listUserThemes').mockResolvedValue([
      { fileName: 'used.json', content: json('used'), error: null },
      { fileName: 'used.svg', content: svg('mark-used'), error: null },
      { fileName: 'tab.json', content: json('tab'), error: null },
      { fileName: 'tab.svg', content: svg('mark-tab'), error: null },
    ]);
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'user:used' },
    });
    try {
      renderSettings();
      await act(async () => {});
      const cached = () => localStorage.getItem(USER_THEMES_CACHE_KEY) ?? '';
      // アプリの設定のテーマの SVG は入り、どこでも使っていないテーマは配色だけ
      expect(cached()).toContain('mark-used');
      expect(cached()).not.toContain('mark-tab');
      expect(cached()).toContain('user:tab');

      // タブの上書きで使い始めたら、そのテーマの SVG も入れ直す
      await act(async () => {
        const s = useAppStore.getState();
        useAppStore.setState({ tabs: { ...s.tabs, t1: { ...s.tabs.t1, themeId: 'user:tab' } } });
      });
      expect(cached()).toContain('mark-tab');
    } finally {
      spy.mockRestore();
    }
  });

  it('SettingsDialog: 試しに表示して Esc で閉じると、窓が元のテーマに戻る', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    const onClose = vi.fn();
    renderSettings(onClose);
    await act(async () => {});

    await act(async () => themeCard('Dracula')!.click());
    expect(windowAccent()).toBe(DRACULA_ACCENT);

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().settings.theme).toBe('tokyo-night');
    expect(windowAccent()).toBe(TOKYO_NIGHT_ACCENT);
  });

  it('SettingsDialog: 試しに表示したままダイアログが外されても、窓が元のテーマに戻る', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    // ダイアログだけを外せるよう、Root の内側で出し分ける
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" className="test-unmount" onClick={() => setOpen(false)} />
          {open && <SettingsDialog onClose={() => {}} />}
        </>
      );
    }
    render(<Host />);
    await act(async () => {});

    await act(async () => themeCard('Dracula')!.click());
    expect(windowAccent()).toBe(DRACULA_ACCENT);

    await act(async () => document.body.querySelector<HTMLButtonElement>('.test-unmount')!.click());
    expect(themeCard('Dracula')).toBeUndefined();
    expect(windowAccent()).toBe(TOKYO_NIGHT_ACCENT);
  });

  it('SettingsDialog: 背景付きのテーマを選んでいる間は、透明度のスライダーは使えるまま注記だけを出す', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    renderSettings();
    await act(async () => {});
    const range = document.body.querySelector<HTMLInputElement>('input[aria-label="背景透明度"]');
    const note = '背景付きのテーマでは使いません（配色だけのテーマのタブでは効きます）';
    expect(range!.disabled).toBe(false);
    expect(document.body.textContent).not.toContain(note);

    await act(async () => themeCard('Honu Lagoon')!.click());
    // お気に入りで配色だけのテーマを付けたタブでは効くので、無効にはしない
    expect(range!.disabled).toBe(false);
    expect(document.body.textContent).toContain(note);

    await act(async () => themeCard('Dracula')!.click());
    expect(range!.disabled).toBe(false);
    expect(document.body.textContent).not.toContain(note);
  });

  it('SettingsDialog: 「背景を動かす」は未設定ならオンで、切って保存すると設定に入る', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, backdropMotion: undefined },
    });
    renderSettings();
    const checkbox = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (c) => c.closest('label')?.textContent?.includes('背景を動かす'),
    );
    expect(checkbox, '「背景を動かす」が見つからない').toBeTruthy();
    expect(checkbox!.checked).toBe(true);

    await act(async () => checkbox!.click());
    // 保存するまでは設定を変えない
    expect(useAppStore.getState().settings.backdropMotion).toBeUndefined();

    const form = document.body.querySelector('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(useAppStore.getState().settings.backdropMotion).toBe(false);
  });

  it('SettingsDialog: 既定のフォントサイズ 12.5 でもフォントサイズ欄が検証を通る（保存ボタンが効く）', () => {
    // submit イベントを直接投げるテストはブラウザの検証を通らないため、ここで検証そのものを見る。
    // step を書き忘れると 1 刻みになり、12.5 が不正扱いで「保存」が黙って効かなくなる。
    // (フォーム全体の checkValidity は使わない: jsdom は透明度の range (0.7〜1, step 0.05) の
    //  値 1 を浮動小数の誤差で stepMismatch と誤判定する。WebView2 では正しく有効になる)
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, fontSize: 12.5 },
    });
    renderSettings();
    const fontSize = document.body.querySelector<HTMLInputElement>('input[type="number"][min="8"]');
    expect(fontSize!.value).toBe('12.5');
    expect(fontSize!.validity.stepMismatch).toBe(false);
    expect(fontSize!.checkValidity()).toBe(true);
  });

  it('SettingsDialog: 「Claude でテーマを作る」は入力中の内容を保存してから claude タブを頼み、ダイアログを閉じる', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, theme: 'tokyo-night' },
    });
    // claude タブを開きに行った時点で、入力中の内容が保存済みかを記録する
    const themeAtRequest: string[] = [];
    const ensureSpy = vi.spyOn(themeDeps, 'ensureThemesDir').mockImplementation(() => {
      themeAtRequest.push(useAppStore.getState().settings.theme);
      return Promise.resolve(null);
    });
    const onClose = vi.fn();
    try {
      renderSettings(onClose);
      await act(async () => themeCard('Dracula')!.click());
      const button = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'Claude でテーマを作る',
      );
      await act(async () => button!.click());

      expect(useAppStore.getState().settings.theme).toBe('dracula');
      expect(themeAtRequest).toEqual(['dracula']);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('FavoriteDialog: 選んだ配色が onSubmit に渡り、「アプリの設定に従う」なら undefined', async () => {
    const onSubmit = vi.fn();
    render(
      <FavoriteDialog
        mode="edit"
        initial={{ id: 'f1', title: 'テスト', themeId: 'nord' }}
        onSubmit={onSubmit}
        onClose={() => {}}
      />,
    );
    const form = document.body.querySelector('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ themeId: 'nord' });

    const select = [...document.body.querySelectorAll('select')].find((s) =>
      s.querySelector('option[value="nord"]'),
    );
    await act(async () => {
      fireEvent.change(select!, { target: { value: '' } });
    });
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSubmit.mock.calls[1][0].themeId).toBeUndefined();
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
    expect(text).toContain('55k / 1M (6%)');
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
