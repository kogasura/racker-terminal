//! Windows 11 の新しいコンテキストメニュー用 shell extension。
//!
//! Windows 11 で右クリック直後に出る新メニューは、MSIX パッケージとして登録された
//! `IExplorerCommand` の COM オブジェクトしか受け付けない。レジストリの verb
//! (`Directory\shell\...`) は「その他のオプションを表示」の旧メニュー行きになる。
//! そのため、第一階層に「Racker Terminal で開く」を出すにはこの DLL が要る。
//!
//! この DLL は sparse package (`src-tauri/appx/AppxManifest.xml`) から
//! `<com:SurrogateServer>` として参照され、エクスプローラーの COM サロゲート
//! (dllhost.exe) にロードされる。`Invoke` では自前でフォルダを開かず、
//! 既存の `racker-terminal.exe "<フォルダ>"` を起動するだけにしてある。
//! 引数の解釈は本体側の `launch.rs`、二重起動の抑止は single-instance
//! プラグインがすでに担当しているので、ここに同じ処理を持たせる必要はない。
//!
//! Windows 10 には新メニュー自体が無いため、旧メニュー用のレジストリ登録
//! (`installer-hooks.nsh`) も引き続き必要。両方を維持している。

// 本体クレートと同じ方針。shell extension はエクスプローラーのプロセス空間に
// 近いところで動くので、パニックさせる価値はどこにもない。失敗は HRESULT で返す。
#![cfg_attr(not(test), warn(clippy::unwrap_used, clippy::expect_used))]

use std::ffi::c_void;
use std::path::PathBuf;
use std::process::Command;

use windows::core::{
    implement, w, Error, Interface, Ref, Result, BOOL, GUID, HRESULT, PCWSTR, PWSTR,
};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_NOTIMPL, E_POINTER, HMODULE,
    S_FALSE,
};
use windows::Win32::System::Com::{CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray, SHStrDupW,
    ECF_DEFAULT, ECS_ENABLED, SIGDN_FILESYSPATH,
};

/// この shell extension の CLSID。`AppxManifest.xml` の `com:Class` /
/// `desktop5:Verb` と一致していないとメニューに出ない。変更するときは必ず両方直すこと。
const CLSID_OPEN_IN_RACKER: GUID = GUID::from_u128(0xa93945cd_211a_4c38_a9ae_67f2b4c84e42);

/// メニューに出す文言。旧メニュー (installer-hooks.nsh) と同じ表記に揃えている。
const MENU_TITLE: PCWSTR = w!("Racker Terminal で開く");

/// 本体の実行ファイル名。
const RACKER_EXE: &str = "racker-terminal.exe";

/// `ECS_HIDDEN`。windows crate では `_EXPCMDSTATE` の定数として出ていないので直接置く。
const ECS_HIDDEN: u32 = 0x2;

/// `GetModuleHandleExW` に自モジュール内のアドレスとして渡すための錨。
/// この静的変数は DLL のデータセクションに置かれるので、そのアドレスから
/// 自分自身のモジュールハンドルを引ける。
static MODULE_ANCHOR: u8 = 0;

/// この DLL 自身のフルパスを返す。
fn module_path() -> Option<PathBuf> {
    let mut module = HMODULE::default();
    // SAFETY: MODULE_ANCHOR は自モジュール内の実在アドレス。module は書き込み可能。
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(std::ptr::addr_of!(MODULE_ANCHOR).cast::<u16>()),
            &mut module,
        )
        .ok()?;
    }
    // パスは MAX_PATH (260) を超えうるので広めに取る。
    let mut buf = [0u16; 1024];
    // SAFETY: module は上で取得済み。buf は書き込み可能なスライス。
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
    // 0 は失敗、buf 長ちょうどはバッファ不足 (切り詰められている) を意味する。
    if len == 0 || len >= buf.len() {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// 本体 `racker-terminal.exe` のフルパスを返す。
///
/// この DLL は通常インストール先の `<INSTDIR>\appx\` に置かれ、本体はその 1 つ上の
/// `<INSTDIR>\` にある。ただし sparse package のパス解決の都合で DLL を
/// `<INSTDIR>` 直下に置く構成もありうるので、隣と 1 つ上の両方を見る。
///
/// 絶対パスで解決するのは、COM サロゲート (dllhost.exe) の作業ディレクトリが
/// 何になっているか当てにできないため。
fn racker_exe() -> Option<PathBuf> {
    let dll = module_path()?;
    let dll_dir = dll.parent()?;
    // 隣 → 1 つ上、の順に探す。
    let candidates = [dll_dir.join(RACKER_EXE), dll_dir.parent()?.join(RACKER_EXE)];
    candidates.into_iter().find(|p| p.is_file())
}

/// 選択された項目 (またはフォルダ背景の場合は表示中フォルダ) のパスを取り出す。
///
/// 複数選択されていても先頭の 1 件だけを見る。右クリックしたフォルダで
/// 1 タブ開くのが目的なので、選択数だけタブを開いても嬉しくない。
fn folder_from(items: Ref<'_, IShellItemArray>) -> Option<String> {
    let array = items.as_ref()?;
    // SAFETY: array はシェルから渡された有効なインターフェース。
    unsafe {
        if array.GetCount().ok()? == 0 {
            return None;
        }
        let item = array.GetItemAt(0).ok()?;
        // SIGDN_FILESYSPATH はファイルシステム上の実体を持つ項目にしか使えない。
        // 仮想フォルダ (「PC」「クイックアクセス」など) では失敗するので、
        // その場合は None を返してメニューを出さない側に倒す。
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        // GetDisplayName の戻り値は呼び出し側が解放する契約。
        CoTaskMemFree(Some(name.0.cast::<c_void>()));
        path
    }
}

/// 「Racker Terminal で開く」コマンド本体。
#[implement(IExplorerCommand)]
struct OpenInRacker;

impl IExplorerCommand_Impl for OpenInRacker_Impl {
    fn GetTitle(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        // SAFETY: MENU_TITLE は静的な null 終端文字列。
        unsafe { SHStrDupW(MENU_TITLE) }
    }

    fn GetIcon(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        // 本体 exe の 1 つ目のアイコンをそのまま使う。
        let exe = racker_exe().ok_or_else(|| Error::from(E_FAIL))?;
        let icon: Vec<u16> = format!("{},0", exe.display())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: icon は null 終端済みで、呼び出しの間だけ生きていれば良い
        // (SHStrDupW が複製する)。
        unsafe { SHStrDupW(PCWSTR(icon.as_ptr())) }
    }

    fn GetToolTip(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        // ツールチップは出さない。E_NOTIMPL がその意思表示になる。
        Err(Error::from(E_NOTIMPL))
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(GUID::zeroed())
    }

    fn GetState(&self, items: Ref<'_, IShellItemArray>, _ok_to_be_slow: BOOL) -> Result<u32> {
        // パスを取り出せないもの (仮想フォルダなど) では項目自体を隠す。
        // 押しても何も起きないメニューを見せるよりそのほうが親切。
        if folder_from(items).is_none() {
            return Ok(ECS_HIDDEN);
        }
        Ok(ECS_ENABLED.0 as u32)
    }

    fn Invoke(&self, items: Ref<'_, IShellItemArray>, _bind_ctx: Ref<'_, IBindCtx>) -> Result<()> {
        let folder = folder_from(items).ok_or_else(|| Error::from(E_FAIL))?;
        let exe = racker_exe().ok_or_else(|| Error::from(E_FAIL))?;
        // 起動済みなら single-instance プラグインが argv を既存ウィンドウへ転送する。
        Command::new(exe)
            .arg(folder)
            .spawn()
            .map_err(|_| Error::from(E_FAIL))?;
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        // サブメニューは持たない。
        Err(Error::from(E_NOTIMPL))
    }
}

/// `DllGetClassObject` がシェルに返すクラスファクトリ。
#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, windows::core::IUnknown>,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> Result<()> {
        if ppv.is_null() {
            return Err(Error::from(E_POINTER));
        }
        // SAFETY: ppv は非 null を確認済み。失敗時に不定値を残さないよう先に潰す。
        unsafe { *ppv = std::ptr::null_mut() };
        if !outer.is_null() {
            // 集約 (aggregation) には対応しない。
            return Err(Error::from(CLASS_E_NOAGGREGATION));
        }
        let command: IExplorerCommand = OpenInRacker.into();
        // SAFETY: riid / ppv はシェルから渡された有効なポインタ。
        unsafe { command.query(riid, ppv).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        // DllCanUnloadNow で常にアンロードを断っているので、数える意味がない。
        Ok(())
    }
}

/// COM のエントリポイント。シェルがこの DLL からオブジェクトを作るときに呼ばれる。
///
/// # Safety
/// COM ランタイムからの呼び出し規約に従う。`rclsid` / `riid` / `ppv` は
/// 呼び出し側が有効なポインタを渡す契約になっている。
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    // SAFETY: ppv は非 null を確認済み。
    unsafe { *ppv = std::ptr::null_mut() };
    if rclsid.is_null() || riid.is_null() {
        return E_POINTER;
    }
    // SAFETY: rclsid は非 null を確認済み。
    if unsafe { *rclsid } != CLSID_OPEN_IN_RACKER {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory.into();
    // SAFETY: riid / ppv はシェルから渡された有効なポインタ。
    unsafe { factory.query(riid, ppv) }
}

/// シェルにアンロードさせない。
///
/// この DLL は常駐しても数百 KB で、アンロードを許しても得られるものが無い割に、
/// 生存管理を誤ったときの壊れ方 (エクスプローラーごと落ちる) が派手すぎる。
///
/// # Safety
/// COM ランタイムからの呼び出し規約に従う。
#[no_mangle]
pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}
