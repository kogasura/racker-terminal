/**
 * サイドバーの項目に付ける「クリックで claude が起動する」印。
 *
 * お気に入りとクイックアクセスで共通。起動しない項目には何も付けないので、
 * 印の有無だけで「開いたら即 claude」か「シェルだけ開く」かを見分けられる。
 * 形は Claude Code 自身が画面で使う ✻ に寄せ、色は Claude のオレンジにしてある。
 */
export function ClaudeMark() {
  return (
    <span className="claude-mark" aria-label="claude を起動" title="クリックで claude を起動">
      ✻
    </span>
  );
}
