import type { ThemeOption } from '../features/theme/viewModel';

/** テーマの選択肢のグループ 1 つ。 */
export interface ThemeOptionGroup {
  readonly key: 'plain' | 'backdrop-dark' | 'backdrop-light' | 'user';
  readonly label: string;
  readonly options: readonly ThemeOption[];
}

/**
 * テーマの選択肢を 4 つのグループに分ける。純関数。
 *
 * 「配色だけ」「動く背景（ダーク）」「動く背景（ライト）」は組み込み、
 * 「自分のテーマ」は themes フォルダのテーマ（背景の有無は問わない）。
 * 選択肢が 0 件のグループ（自分のテーマが無いときなど）は返さない。
 * グループ内の並びは options の順のまま。
 * 設定ダイアログのカードの一覧と、お気に入りダイアログの select の両方で使う。
 */
export function groupThemeOptions(options: readonly ThemeOption[]): ThemeOptionGroup[] {
  const builtin = options.filter((o) => o.source === 'builtin');
  const groups: ThemeOptionGroup[] = [
    { key: 'plain', label: '配色だけ', options: builtin.filter((o) => !o.hasBackdrop) },
    {
      key: 'backdrop-dark',
      label: '動く背景（ダーク）',
      options: builtin.filter((o) => o.hasBackdrop && o.appearance === 'dark'),
    },
    {
      key: 'backdrop-light',
      label: '動く背景（ライト）',
      options: builtin.filter((o) => o.hasBackdrop && o.appearance === 'light'),
    },
    { key: 'user', label: '自分のテーマ', options: options.filter((o) => o.source === 'user') },
  ];
  return groups.filter((g) => g.options.length > 0);
}

/**
 * 選んでいる ID がカタログに無い (ファイルを消した・名前を変えた) か。
 * 空文字は「アプリの設定に従う」（お気に入りダイアログ）なので、見つからない扱いにしない。
 */
export function isMissingTheme(options: readonly ThemeOption[], value: string): boolean {
  return value !== '' && !options.some((o) => o.id === value);
}

/**
 * テーマの選択肢。groupThemeOptions の 4 グループを optgroup で分ける。
 *
 * 選択中の ID がカタログに無い (ファイルを消した・名前を変えた) ときは
 * 「見つかりません」の選択肢を足して値を保持する。足さないと select が先頭の
 * 選択肢を表示してしまい、保存時に黙って別のテーマへ変わったように見える。
 * お気に入りダイアログで使う（設定ダイアログはカードの一覧）。
 */
export function ThemeOptionGroups({
  options,
  value,
}: {
  options: readonly ThemeOption[];
  value: string;
}) {
  return (
    <>
      {isMissingTheme(options, value) && <option value={value}>（見つかりません: {value}）</option>}
      {groupThemeOptions(options).map((group) => (
        <optgroup key={group.key} label={group.label}>
          {group.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
