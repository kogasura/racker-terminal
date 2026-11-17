/**
 * 動く背景（SVG）を入れる iframe の文書を作り、親から中の文書に SVG と値を書き込む。
 *
 * - iframe は `sandbox="allow-same-origin"`（allow-scripts なし）で置く。SVG 内のスクリプトや
 *   イベント属性は動かない。加えて CSP の meta で、CSP の対象になる外部からの読み込みも止める。
 * - srcdoc は CSP の meta と style だけを持つ空の文書（BACKDROP_DOCUMENT）。SVG を文字列として
 *   HTML に入れると、XML と HTML の読み方の違いで HTML の要素が作れてしまう（`<link>` による
 *   先行接続は CSP の対象外）。そこで SVG は親が XML として読み、要素のまま取り込む
 *   （mountBackdropSvg）。HTML として読み直すことはしない。
 * - allow-same-origin なので、親から contentDocument を触れる。止める class と連動の値は
 *   文書を作り直さずに書き換える（アニメーションが最初からやり直しにならない）。
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

/**
 * iframe の srcdoc。CSP の meta と、全面に広げる style・止める指定だけを持ち、body は空。
 * SVG は読み込み後に mountBackdropSvg で body に入れる。
 */
export const BACKDROP_DOCUMENT =
  '<!doctype html><html><head><meta charset=utf-8>' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
  '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent} ' +
  'body>svg{display:block;width:100%;height:100%} ' +
  `.${PAUSED_CLASS} *{animation-play-state:paused !important}</style></head><body></body></html>`;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Node.nodeType の値。iframe の中のノードは別の realm なので、Node の定数を使わずに比べる。 */
const ELEMENT_NODE = 1;
const PROCESSING_INSTRUCTION_NODE = 7;

/** エラー文に載せるパーサーの理由の上限（文字数）。長い理由で設定画面を埋めない。 */
const PARSE_DETAIL_MAX_LENGTH = 160;

type ParsedSvg = { ok: true; root: Element } | { ok: false; error: string };

/**
 * SVG を XML (image/svg+xml) として読み、ルートの `<svg>` 要素を取り出して中身を絞る。
 *
 * - 整形式でない・ルートが SVG の名前空間の `<svg>` でない場合は、理由を日本語で返す。
 * - `<svg>` の外側に書かれたもの（処理命令・DOCTYPE・コメント）は、ルートの要素だけを
 *   使うので入らない。
 * - ルートの中から、SVG の名前空間でない要素（XHTML など）・`<foreignObject>`・処理命令を
 *   取り除く（stripNonSvgNodes）。
 */
function parseSvg(svg: string): ParsedSvg {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  } catch (e) {
    // ブラウザは投げずに parsererror を返すが、実装によっては投げる。1 ファイルの問題に留める
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `SVG として読めません（${detail}）` };
  }
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
  stripNonSvgNodes(root);
  return { ok: true, root };
}

/** 取り除く要素か。SVG の名前空間でないもの（XHTML など）と、`<foreignObject>`。 */
function isStrippedElement(el: Element): boolean {
  return el.namespaceURI !== SVG_NAMESPACE || el.localName === 'foreignObject';
}

/**
 * root の中から、SVG の名前空間でない要素・`<foreignObject>`・処理命令を取り除く。
 * 深い入れ子でもスタックを使い切らないよう、再帰せずに辿る。
 */
function stripNonSvgNodes(root: Element): void {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === PROCESSING_INSTRUCTION_NODE) {
        child.parentNode?.removeChild(child);
      } else if (child.nodeType === ELEMENT_NODE) {
        if (isStrippedElement(child as Element)) child.parentNode?.removeChild(child);
        else pending.push(child);
      }
    }
  }
}

/** SVG を検証した結果。読めたら、取り込むのと同じ中身を文字列にしたもの。 */
export type SvgRootResult = { ok: true; svg: string } | { ok: false; error: string };

/**
 * 背景の SVG として使えるかを確かめ、取り込むのと同じ中身（ルートの `<svg>` 要素を
 * 絞ったもの）を文字列にして返す。テーマの読み込み時にエラーを出すのに使う。
 *
 * 戻り値の文字列は保存（テーマ・起動時のキャッシュ）用。HTML として読ませてはいけない
 * （XML と HTML の読み方の違いで HTML の要素が作れてしまう）。描くときは mountBackdropSvg が
 * もう一度 XML として読む。
 * @param svg - SVG ファイルの中身
 */
export function extractSvgRoot(svg: string): SvgRootResult {
  const parsed = parseSvg(svg);
  if (!parsed.ok) return parsed;
  return { ok: true, svg: new XMLSerializer().serializeToString(parsed.root) };
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
 * 背景の文書 (BACKDROP_DOCUMENT を読み込んだ iframe の文書) の body に SVG を取り込む。
 * SVG は XML として読んだ要素を importNode で入れる（HTML として読み直さない）。
 * body の中身は入れ替える。SVG として読めなければ body を空にして false を返す。
 * @param doc - iframe の contentDocument
 * @param svg - 背景の SVG（組み込みのシーン・自作のどちらも）
 */
export function mountBackdropSvg(doc: Document, svg: string): boolean {
  const body = doc.body;
  if (body === null) return false;
  while (body.firstChild) body.removeChild(body.firstChild);
  const parsed = parseSvg(svg);
  if (!parsed.ok) return false;
  body.appendChild(doc.importNode(parsed.root, true));
  return true;
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
