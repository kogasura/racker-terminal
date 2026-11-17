/**
 * 動く背景（SVG）を入れる iframe の文書を作り、親から中の文書に値を書き込む。
 *
 * - iframe は `sandbox="allow-same-origin"`（allow-scripts なし）で置く。SVG 内のスクリプトや
 *   イベント属性は動かない。加えて CSP の meta で外部からの読み込みも止める。
 * - 文書に入れるのは SVG のルートの `<svg>` 要素だけ（extractSvgRoot）。外側に書かれた
 *   ものは入れない。
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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** エラー文に載せるパーサーの理由の上限（文字数）。長い理由で設定画面を埋めない。 */
const PARSE_DETAIL_MAX_LENGTH = 160;

/** SVG のルート要素だけを取り出した結果。 */
export type SvgRootResult = { ok: true; svg: string } | { ok: false; error: string };

/**
 * SVG を XML (image/svg+xml) として読み、ルートの `<svg>` 要素だけを文字列に戻す。
 *
 * 文書に入れるのはこの戻り値だけにする。`<svg>` の外側に書かれたもの（`<?xml-stylesheet?>`
 * などの処理命令・DOCTYPE・コメント）は落ちる。`</svg>` の後ろに `<link>` などを続けた
 * ものは XML として整形式でないので、まるごと読めない扱いにする（CSP の対象外の先行接続を
 * 起こさないため）。
 * 整形式でない・ルートが SVG の名前空間の `<svg>` でない場合は、理由を日本語で返す。
 * @param svg - SVG ファイルの中身
 */
export function extractSvgRoot(svg: string): SvgRootResult {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError !== undefined) {
    return { ok: false, error: `SVG として読めません（${parserErrorDetail(parserError)}）` };
  }
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    return {
      ok: false,
      error:
        `SVG として読めません（ルートの要素が <${root.localName}> です。` +
        `<svg xmlns="${SVG_NAMESPACE}"> で始めてください）`,
    };
  }
  return { ok: true, svg: new XMLSerializer().serializeToString(root) };
}

/**
 * パーサーのエラー要素から、理由の 1 行を取り出す。
 * Chromium は `<h3>見出し</h3><div>理由</div><h3>…</h3>` の形で入れるので div を優先する。
 */
function parserErrorDetail(parserError: Element): string {
  const text = (parserError.querySelector('div') ?? parserError).textContent ?? '';
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line === '') return 'XML として整形式ではありません';
  return line.length > PARSE_DETAIL_MAX_LENGTH
    ? `${line.slice(0, PARSE_DETAIL_MAX_LENGTH)}…`
    : line;
}

/**
 * iframe の srcdoc に入れる文書を作る。
 * @param svg - 背景の SVG。ルートの `<svg>` 要素だけを入れる（extractSvgRoot）。
 *   SVG として読めなければ何も描かない（守りは加えて sandbox と CSP が受け持つ）
 */
export function buildBackdropDocument(svg: string): string {
  const root = extractSvgRoot(svg);
  return DOCUMENT_HEAD + (root.ok ? root.svg : '') + DOCUMENT_TAIL;
}

/** SMIL のアニメーション（`<animate>` など）を止める・動かす口。SVGSVGElement にある。 */
interface SmilControl {
  pauseAnimations(): void;
  unpauseAnimations(): void;
}

function hasSmilControl(el: object): el is SmilControl {
  const candidate = el as Partial<SmilControl>;
  return (
    typeof candidate.pauseAnimations === 'function' &&
    typeof candidate.unpauseAnimations === 'function'
  );
}

/**
 * 背景の文書に、止める class と連動の値を書き込む。
 * 書き込む先は SVG のルート（body の最初の svg。無ければ documentElement）。
 * 止めるときは CSS アニメーション（class）に加えて、SMIL のアニメーションも止める。
 * @param doc - iframe の contentDocument
 */
export function applyBackdropSignals(doc: Document, signals: BackdropSignals): void {
  doc.documentElement.classList.toggle(PAUSED_CLASS, signals.paused);
  const svgRoot = doc.body?.querySelector('svg') ?? null;
  // iframe の中の要素は別の realm なので instanceof SVGSVGElement では見分けられない。
  // テスト環境 (happy-dom) には無いこともあるので、関数があるときだけ呼ぶ。
  if (svgRoot !== null && hasSmilControl(svgRoot)) {
    if (signals.paused) svgRoot.pauseAnimations();
    else svgRoot.unpauseAnimations();
  }
  const root: HTMLElement | SVGElement = svgRoot ?? doc.documentElement;
  root.style.setProperty('--rk-context', String(clampContext(signals.context)));
  root.setAttribute('data-agent', signals.agent);
}

/** 0〜1 に収める。数でない値（NaN）は 0。 */
function clampContext(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
