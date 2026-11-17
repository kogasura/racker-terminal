import type { ThemeOption } from '../features/theme/viewModel';

/**
 * テーマの選択肢。「組み込み」と「自分のテーマ」を optgroup で分ける。
 * 自分のテーマが 0 件なら、その optgroup は出さない。
 *
 * 選択中の ID がカタログに無い (ファイルを消した・名前を変えた) ときは
 * 「見つかりません」の選択肢を足して値を保持する。足さないと select が先頭の
 * 選択肢を表示してしまい、保存時に黙って別のテーマへ変わったように見える。
 * 設定ダイアログとお気に入りダイアログの両方で使う。
 */
export function ThemeOptionGroups({
  options,
  value,
}: {
  options: readonly ThemeOption[];
  value: string;
}) {
  const builtin = options.filter((o) => o.source === 'builtin');
  const user = options.filter((o) => o.source === 'user');
  const missing = value !== '' && !options.some((o) => o.id === value);
  return (
    <>
      {missing && <option value={value}>（見つかりません: {value}）</option>}
      <optgroup label="組み込み">
        {builtin.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </optgroup>
      {user.length > 0 && (
        <optgroup label="自分のテーマ">
          {user.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}
