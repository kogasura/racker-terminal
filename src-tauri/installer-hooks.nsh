; Racker Terminal — Windows エクスプローラーコンテキストメニュー登録用 NSIS フック
;
; 右クリックメニューに「Racker Terminal で開く」を追加する。
; Windows 11 とそれ以前で仕組みが全く違うため、両方を登録している。
;
;   1. 旧メニュー (レジストリの verb)
;      Windows 10 ではこれが唯一の手段。Windows 11 では
;      「その他のオプションを表示」(Shift+F10) の中に出る。
;      %V は対象フォルダのフルパスに展開される。
;
;   2. 新メニュー (sparse package の IExplorerCommand)
;      Windows 11 で右クリック直後に出るメニューの第一階層に出すには、
;      MSIX として登録された COM 拡張である必要がある (レジストリでは届かない)。
;      実体は $INSTDIR\appx\ に入る。
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

  ; --- ドライブ直下（「PC」からドライブを右クリック）---
  ; 新メニュー側の ItemType に Drive は指定できない（スキーマ制約）ため、
  ; ドライブについてはこの旧メニュー登録が唯一の手段になる。
  WriteRegStr SHCTX "Software\Classes\Drive\shell\RackerTerminal" "" "Racker Terminal で開く"
  WriteRegStr SHCTX "Software\Classes\Drive\shell\RackerTerminal" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Classes\Drive\shell\RackerTerminal\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; --- Windows 11 の新メニュー用 sparse package を登録 ---
  ; ビルド番号 22000 以上が Windows 11。それ未満では新メニュー自体が無いので何もしない。
  ; 登録に失敗してもインストール自体は成功扱いにする（旧メニューは使えるため）。
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "if ([Environment]::OSVersion.Version.Build -ge 22000) { try { Add-AppxPackage -Path '$INSTDIR\appx\RackerTerminal.msix' -ExternalLocation '$INSTDIR' -ForceUpdateFromAnyVersion -ErrorAction Stop } catch { } }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\RackerTerminal"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\RackerTerminal"
  DeleteRegKey SHCTX "Software\Classes\Drive\shell\RackerTerminal"

  ; 新メニューの登録を外す。登録されていなければ何も起きない。
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name yokubo.RackerTerminal | Remove-AppxPackage"`
  Pop $0
!macroend
