/**
 * 動く背景（SVG）を入れる iframe の文書を作り、親から中の文書に値を書き込む。
 *
 * - iframe は `sandbox="allow-same-origin"`（allow-scripts なし）で置く。SVG 内のスクリプトや
 *   イベント属性は動かない。加えて CSP の meta で外部からの読み込みも止める。
 * - allow-same-origin なので、親から contentDocument を触れる。止める class と連動の値は
 *   srcdoc を差し替えずに書き換える（アニメーションが最初からやり直しにならない）。
 *
 * @module theme/backdropDocument
 */

/** 背景に渡すエージェントの状態。SVG のルートの `data-agent` 属性になる。 */
export type BackdropAgent = 'idle' | 'working' | 'blocked';

/** 親から背景に書き込む値。 */
export interface BackdropSignals {
  /** true でアニメーションを止める（「背景を動かす」がオフ） */
  paused: boolean;
  /** アクティブなタブのコンテキストの使用率（0〜1）。SVG のルートの `--rk-context` になる */
  context: number;
  agent: BackdropAgent;
}

/** 止めるときに documentElement に付ける class。 */
const PAUSED_CLASS = 'rk-paused';

const DOCUMENT_HEAD =
  '<!doctype html><html><head><meta charset=utf-8>' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
  '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent} ' +
  'body>svg{display:block;width:100%;height:100%} ' +
  `.${PAUSED_CLASS} *{animation-play-state:paused !important}</style></head><body>`;

const DOCUMENT_TAIL = '</body></html>';

/**
 * iframe の srcdoc に入れる文書を作る。
 * @param svg - 背景の SVG。改変せずにそのまま入れる（守りは sandbox と CSP に任せる）
 */
export function buildBackdropDocument(svg: string): string {
  return DOCUMENT_HEAD + svg + DOCUMENT_TAIL;
}

/**
 * 背景の文書に、止める class と連動の値を書き込む。
 * 書き込む先は SVG のルート（body の最初の svg。無ければ documentElement）。
 * @param doc - iframe の contentDocument
 */
export function applyBackdropSignals(doc: Document, signals: BackdropSignals): void {
  doc.documentElement.classList.toggle(PAUSED_CLASS, signals.paused);
  const root: HTMLElement | SVGElement = doc.body?.querySelector('svg') ?? doc.documentElement;
  root.style.setProperty('--rk-context', String(clampContext(signals.context)));
  root.setAttribute('data-agent', signals.agent);
}

/** 0〜1 に収める。数でない値（NaN）は 0。 */
function clampContext(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
