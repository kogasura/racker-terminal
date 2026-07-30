import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

// 関数の長さ・複雑度をチェックするための ESLint 設定。
//
// 目的を「複雑度の歯止め」に絞っており、typescript-eslint の recommended 等の
// 一般的なスタイル / 型安全ルールセットは意図的に入れていない。既存コードに対して
// ノイズが大きく、本来の目的が埋もれるため。必要になったら段階的に足す。
export default [
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      'node_modules/**',
      'scripts/**',
      '*.config.js',
      // npm run test:coverage が吐く HTML レポート。同梱の JS は生成物なので見ない。
      'coverage/**',
    ],
  },

  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    // テストは分岐網羅のために意図的に長く・分岐が多くなるので対象外
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      // 既存コードに `// eslint-disable-next-line react-hooks/exhaustive-deps` が
      // あり、プラグイン未登録だと rule not found で落ちるため登録している。
      'react-hooks': reactHooks,
    },
    rules: {
      // 有効化しても既存の違反はゼロだったのでそのまま入れている。
      // 抑制コメントが既に書かれている＝元々このルールを前提にしていたため。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // 循環的複雑度。分岐が増えすぎた関数を検出する。本設定の主指標。
      complexity: ['error', { max: 8 }],

      // ネストの深さ。複雑度に現れにくい「読みにくさ」を拾う。
      'max-depth': ['error', 4],

      // 引数の数。Rust 側の clippy::too_many_arguments と揃えている。
      'max-params': ['error', 5],

      // コールバックのネスト。useEffect の中の setTimeout の中の … を防ぐ。
      'max-nested-callbacks': ['error', 4],
    },
  },

  {
    // ── 非同期の取り扱いを型情報で検査する ──────────────────────────────────
    //
    // 型情報を要求するルールなので parserOptions.projectService が要る。その分
    // lint は遅くなるが、ここに挙げた 4 つは**導入時点で違反ゼロ**だった。
    // つまり現状の書き方は既に正しく、これは「崩れたら気付く」ための固定であって
    // 既存コードの修正を迫るものではない。
    //
    // 非同期の取り違えはこのアプリで実際に事故になった領域でもある
    // (v1.8.1 のフリーズ)。安く張れる網は張っておく。
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // await も .catch() も付けずに投げっぱなしにした Promise を検出する。
      // 失敗が握り潰され、原因の分からない不整合として現れるのを防ぐ。
      // 意図的に待たない場合は既存コードと同じく `void` を付ける。
      '@typescript-eslint/no-floating-promises': 'error',

      // Promise を返す関数を、それを待たない場所へ渡すのを検出する。
      // 典型は onClick={async () => ...} や if (asyncFn()) で、
      // 前者は例外が消え、後者は常に truthy になる。
      '@typescript-eslint/no-misused-promises': 'error',

      // Promise でない値への await を検出する。待っているつもりで待てていない箇所。
      '@typescript-eslint/await-thenable': 'error',

      // await を含まない async 関数を検出する。非同期のつもりで同期のまま、
      // あるいは await の書き忘れ。テストのモックでは普通に起きるので対象外にしている。
      '@typescript-eslint/require-await': 'error',

      // ── 見送ったルール ────────────────────────────────────────────────
      // no-unnecessary-condition (39 件): React の cancellation フラグ
      //   (`let cancelled = false` を cleanup で true にする書き方) を
      //   「常に falsy」と誤検知する。TypeScript がクロージャによる書き換えを
      //   追えないための誤りで、こちらのコードの問題ではないため入れていない。
    },
  },

  {
    // 関数の行数チェックは .ts のみに適用する。
    //
    // React コンポーネント (.tsx) は JSX を返す都合で 1 関数が長くなるのが
    // 構造上避けられず、行数で縛るとルールに合わせた不自然な分割を誘発する。
    // .tsx 側は complexity で見る方針。
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 150, skipBlankLines: true, skipComments: true, IIFEs: false },
      ],
    },
  },
];
