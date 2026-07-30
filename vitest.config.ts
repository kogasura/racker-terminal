import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,

    coverage: {
      provider: 'v8',
      // text は端末で見る用、html は掘る用、json-summary は閾値の確認用。
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',

      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        // 型定義だけのファイル。実行されるコードが無いので分母に入れる意味がない。
        'src/types/**',
        'src/vite-env.d.ts',
        // 起動時に一度 DOM へマウントするだけ。テストで触ると本物の描画が始まる。
        'src/main.tsx',
      ],

      // 閾値は「いま達成できている水準」に置く。目標値を先に置くと常に赤になり、
      // 赤いのが普通の状態になって誰も見なくなる。ここは**下がったら気付く**ための
      // ラチェットとして使い、テストを足したときに一緒に引き上げていく。
      //
      // 計測値 (2026-07-30): stmts 56.99 / branch 58.55 / funcs 52.28 / lines 57.53
      thresholds: {
        statements: 56,
        branches: 57,
        functions: 51,
        lines: 56,
      },
    },
  },
});
