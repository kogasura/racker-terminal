/**
 * 組み込みの動く背景（20 シーン）の一覧。
 *
 * 出典: Anthropic の Claude Code 公式プラグイン theme-examples 0.4.3 の hooks/themes.ts（Apache-2.0）。
 * racker 用に変更した:
 * - id / title / window / twin / glass は本家の値そのまま。blurb は日本語に訳した
 * - racker の配色に使う accent / accent2 を足した（シーンの絵から選んだ色。tint の上で 4.5:1 以上）
 * - シーンを作る関数は一覧から外し、sceneSvg で ID から引く形にした
 *
 * ライセンス: LICENSES/theme-examples-Apache-2.0.txt、変更点: LICENSES/NOTICE-theme-examples.md
 *
 * @module backdrop/catalog
 */

import { blueprintSvg } from './scenes/blueprint';
import { brailleStarsSvg } from './scenes/brailleStars';
import { auroraSvg, deepWaterSvg, emberSvg } from './scenes/classic';
import { departureBoardSvg } from './scenes/departureBoard';
import { ditherDunesNightSvg, ditherDunesSvg } from './scenes/ditherDunes';
import { halftoneDawnSvg, halftoneDuskSvg } from './scenes/halftoneDawn';
import { honuLagoonSvg } from './scenes/honuLagoon';
import { koiMosaicSvg } from './scenes/koiMosaic';
import { nightReefSvg } from './scenes/nightReef';
import { paperGardenKraftSvg, paperGardenSvg } from './scenes/paperGarden';
import { plotterTideNightSvg, plotterTideSvg } from './scenes/plotterTide';
import { snowPinesSvg } from './scenes/snowPines';
import { teletextCloudsSvg } from './scenes/teletextClouds';
import { vectorRangeSvg } from './scenes/vectorRange';

/** シーンの上に重ねるすりガラス。値は本家のまま。 */
export interface SceneGlass {
  /** ぼかしの強さ（px）。 */
  blur: number;
  /** パネルの色（#rrggbb）。 */
  tint: string;
  /** パネルの濃さ（0〜1）。 */
  opacity: number;
}

/** 組み込みの背景 1 つ。 */
export interface BuiltinScene {
  /** 本家の id。テーマの ID は `scene:<id>` になる。 */
  id: string;
  /** 名前（本家の英語のまま）。 */
  title: string;
  /** ひとこと説明（本家の blurb の日本語訳）。 */
  blurb: string;
  /** ライトの窓向けか、ダークの窓向けか。 */
  window: 'light' | 'dark';
  /** 同じ絵の、もう一方（ライト / ダーク）のシーンの id。 */
  twin?: string;
  glass: SceneGlass;
  /** racker の配色に使う強調色（#rrggbb）。 */
  accent: string;
  /** racker の配色に使う 2 つ目の強調色（#rrggbb）。 */
  accent2: string;
}

/** 組み込みの背景の一覧。並びは本家と同じ。 */
export const BUILTIN_SCENES: readonly BuiltinScene[] = [
  {
    id: 'honu-lagoon',
    title: 'Honu Lagoon',
    blurb: '上から見た、動く ASCII の礁湖。タイルのウミガメが砂の島のそばを泳ぐ',
    window: 'light',
    glass: { blur: 7, tint: '#e6fbff', opacity: 0.42 },
    accent: '#0b6e80',
    accent2: '#b8325a',
  },
  {
    id: 'koi-mosaic',
    title: 'Koi Mosaic',
    blurb: 'タイルで描いた鯉の池を上から。2 匹の鯉と蓮の葉、ゆっくり広がる波紋',
    window: 'light',
    glass: { blur: 12, tint: '#eef8f1', opacity: 0.36 },
    accent: '#0d5a66',
    accent2: '#b8501f',
  },
  {
    id: 'halftone-dawn',
    title: 'Halftone Dawn',
    blurb: '2 色刷りのリソグラフの朝日。網点が外へ向かって呼吸する',
    window: 'light',
    twin: 'halftone-dusk',
    glass: { blur: 14, tint: '#f6ead9', opacity: 0.55 },
    accent: '#b0432a',
    accent2: '#3f5f94',
  },
  {
    id: 'halftone-dusk',
    title: 'Halftone Dusk',
    blurb: '夜の青い紙に刷ったリソグラフの朝日。呼吸する網点で描いた熾火の色の太陽',
    window: 'dark',
    twin: 'halftone-dawn',
    glass: { blur: 14, tint: '#1f2336', opacity: 0.5 },
    accent: '#ef7a52',
    accent2: '#9fb0d8',
  },
  {
    id: 'plotter-tide',
    title: 'Plotter Tide',
    blurb: '温かみのある紙に、ペンプロッターが潮の線をひとりでに描いていく',
    window: 'light',
    twin: 'plotter-tide-night',
    glass: { blur: 0, tint: '#f4efe4', opacity: 0.32 },
    accent: '#2c4a86',
    accent2: '#a8461f',
  },
  {
    id: 'plotter-tide-night',
    title: 'Plotter Tide, Night',
    blurb: 'プロッターの潮の図を、青みがかった黒い夜の紙に淡いインクで',
    window: 'dark',
    twin: 'plotter-tide',
    glass: { blur: 0, tint: '#141a27', opacity: 0.32 },
    accent: '#e98a5e',
    accent2: '#aab6d0',
  },
  {
    id: 'dither-dunes',
    title: 'Dither Dunes',
    blurb: '砂色の紙に 1 ビットの砂丘。点で陰影を付け、テラコッタの太陽が浮かぶ',
    window: 'light',
    twin: 'dither-dunes-night',
    glass: { blur: 18, tint: '#f1e8d6', opacity: 0.34 },
    accent: '#a8452c',
    accent2: '#6f5d49',
  },
  {
    id: 'dither-dunes-night',
    title: 'Dither Dunes Night',
    blurb: '日が暮れたあとの同じ砂丘。焦げ茶の地に淡い点、熾火の色の太陽',
    window: 'dark',
    twin: 'dither-dunes',
    glass: { blur: 18, tint: '#1c1712', opacity: 0.4 },
    accent: '#e07a55',
    accent2: '#c9b48a',
  },
  {
    id: 'paper-garden',
    title: 'Paper Garden',
    blurb: '温かみのある白い紙の端に切り絵の葉。珊瑚色の花がひとつ',
    window: 'light',
    twin: 'paper-garden-kraft',
    glass: { blur: 16, tint: '#fbf6ec', opacity: 0.5 },
    accent: '#b04a35',
    accent2: '#4f6b3f',
  },
  {
    id: 'paper-garden-kraft',
    title: 'Paper Garden, Kraft',
    blurb: '濃い色のクラフト紙の端に切り絵の葉。珊瑚色の花がひとつ',
    window: 'dark',
    twin: 'paper-garden',
    glass: { blur: 16, tint: '#35312a', opacity: 0.5 },
    accent: '#e4846a',
    accent2: '#a9c294',
  },
  {
    id: 'night-reef',
    title: 'Night Reef',
    blurb: '夜の礁湖。泳ぎながら光るウミガメとエイ',
    window: 'dark',
    glass: { blur: 14, tint: '#0a1430', opacity: 0.4 },
    accent: '#5fd0c8',
    accent2: '#9d8cff',
  },
  {
    id: 'snow-pines',
    title: 'Snow Pines',
    blurb: '夕暮れの ASCII の松林。木々のあいだを雪が舞い降りる',
    window: 'dark',
    glass: { blur: 16, tint: '#14143a', opacity: 0.5 },
    accent: '#ffb65c',
    accent2: '#b4c2ec',
  },
  {
    id: 'braille-stars',
    title: 'Braille Stars',
    blurb: '点字のグリッドに 1 点ずつ描いた、ゆっくり巡る夜空',
    window: 'dark',
    glass: { blur: 20, tint: '#0a1430', opacity: 0.3 },
    accent: '#8ea6ff',
    accent2: '#ffdcae',
  },
  {
    id: 'teletext-clouds',
    title: 'Block Clouds',
    blurb: 'テレテキストのグリッドにブロックで組んだ夜の雲が、流れ込んでくる',
    window: 'dark',
    glass: { blur: 12, tint: '#0d173f', opacity: 0.34 },
    accent: '#4cc4d8',
    accent2: '#f0cf52',
  },
  {
    id: 'vector-range',
    title: 'Vector Range',
    blurb: '黒地に蛍光の山並み。琥珀色のビームが何度もなぞり直す',
    window: 'dark',
    glass: { blur: 22, tint: '#0e2f27', opacity: 0.42 },
    accent: '#7df0b0',
    accent2: '#ffb454',
  },
  {
    id: 'departure-board',
    title: 'Departure Board',
    blurb: '琥珀色の LED の発車案内板が、1 行ずつ文字を書き換えていく',
    window: 'dark',
    glass: { blur: 14, tint: '#1a120b', opacity: 0.34 },
    accent: '#f2a53a',
    accent2: '#5fd0b8',
  },
  {
    id: 'blueprint',
    title: 'Blueprint',
    blurb: '青写真の紙。隅では彗星が、描かれた軌道を巡る',
    window: 'dark',
    glass: { blur: 14, tint: '#0c2444', opacity: 0.42 },
    accent: '#7fb2f0',
    accent2: '#f2c14e',
  },
  {
    id: 'deep-water',
    title: 'Deep Water',
    blurb: '深い水に差し込む光と、静かなウミガメが 1 匹',
    window: 'dark',
    glass: { blur: 14, tint: '#062c3a', opacity: 0.34 },
    accent: '#4fd0e6',
    accent2: '#8fe3c4',
  },
  {
    id: 'aurora',
    title: 'Aurora',
    blurb: '暗い尾根の上で揺れるオーロラ',
    window: 'dark',
    glass: { blur: 18, tint: '#14123a', opacity: 0.3 },
    accent: '#5dffb5',
    accent2: '#a98bff',
  },
  {
    id: 'ember',
    title: 'Ember',
    blurb: '隅にともる温かい光と、立ちのぼるいくつかの火の粉',
    window: 'dark',
    glass: { blur: 12, tint: '#2a0d12', opacity: 0.3 },
    accent: '#ff7a2a',
    accent2: '#ffc27a',
  },
];

/** シーンの SVG を作る関数。キーは BuiltinScene.id。 */
const SCENE_BUILDERS: ReadonlyMap<string, () => string> = new Map(
  Object.entries({
    'honu-lagoon': honuLagoonSvg,
    'koi-mosaic': koiMosaicSvg,
    'halftone-dawn': halftoneDawnSvg,
    'halftone-dusk': halftoneDuskSvg,
    'plotter-tide': plotterTideSvg,
    'plotter-tide-night': plotterTideNightSvg,
    'dither-dunes': ditherDunesSvg,
    'dither-dunes-night': ditherDunesNightSvg,
    'paper-garden': paperGardenSvg,
    'paper-garden-kraft': paperGardenKraftSvg,
    'night-reef': nightReefSvg,
    'snow-pines': snowPinesSvg,
    'braille-stars': brailleStarsSvg,
    'teletext-clouds': teletextCloudsSvg,
    'vector-range': vectorRangeSvg,
    'departure-board': departureBoardSvg,
    blueprint: blueprintSvg,
    'deep-water': deepWaterSvg,
    aurora: auroraSvg,
    ember: emberSvg,
  }),
);

const built = new Map<string, string>();

/**
 * シーンの SVG 文字列。初めて求められたときに作って覚えておく（見せたシーンの分だけ作る）。
 * 組み込みに無い ID には undefined を返す。
 */
export function sceneSvg(id: string): string | undefined {
  const ready = built.get(id);
  if (ready !== undefined) return ready;
  const build = SCENE_BUILDERS.get(id);
  if (build === undefined) return undefined;
  const svg = build();
  built.set(id, svg);
  return svg;
}
