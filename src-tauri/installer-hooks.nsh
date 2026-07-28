; Racker Terminal — Windows Explorer コンテキストメニュー登録用 NSIS フック
;
; フォルダ右クリック / フォルダ背景右クリックのメニューに
; 「Racker Terminal で開く」を追加し、選択（表示中）フォルダを引数として
; Racker Terminal を起動する。%V は対象フォルダのフルパスに展開される。
;
; SHCTX はインストールスコープ（現在ユーザー / 全ユーザー）に応じて
; HKCU / HKLM に解決される。Software\Classes 配下に書くことで、
; per-user インストールでもクラス登録が有効になる。
;
; 注: このファイルは日本語ラベルを含むため UTF-8 (BOM 付き) で保存すること。

!macro NSIS_HOOK_POSTINSTALL
  ; --- フォルダそのものを右クリックしたとき ---
  WriteRegStr SHCTX "Software\Classes\Directory\shell\RackerTerminal" "" "Racker Terminal で開く"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\RackerTerminal" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\RackerTerminal\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; --- フォルダ内の背景（空白部分）を右クリックしたとき ---
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\RackerTerminal" "" "Racker Terminal で開く"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\RackerTerminal" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\RackerTerminal\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\RackerTerminal"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\RackerTerminal"
!macroend
