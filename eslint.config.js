import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

// 関数の長さ・複雑度をチェックするための ESLint 設定。
//
// 目的を「複雑度の歯止め」に絞っており、typescript-eslint の recommended 等の
// 一般的なスタイル / 型安全ルールセットは意図的に入れていない。既存コードに対して
// ノイズが大きく、本来の目的が埋もれるため。必要になったら段階的に足す。
export default [
  {
    ignores: ['dist/**', 'src-tauri/**', 'node_modules/**', 'scripts/**', '*.config.js'],
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
