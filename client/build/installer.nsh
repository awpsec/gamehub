; Gamehub NSIS customisation (electron-builder includes build/installer.nsh).
;
; Before the stock "is Gamehub running?" check, ask a running Gamehub to quit
; itself: drop %APPDATA%\Gamehub\quit-for-update. Gamehub (2.1.1+) checks for
; it twice a second, DELETES it (= "got it") and exits; we then wait for the
; process to go. Nobody picks it up within 3 s → no Gamehub is listening; remove
; it and fall through to the stock check.
;
; Why not trust the stock check: it finds Gamehub with a user-filtered
; `tasklist` and closes it with `taskkill`. Neither works on an ELEVATED
; Gamehub (Settings → Run as administrator), and the tasklist probe missed a
; running Gamehub in CI — the installer then sat in its file-in-use retry loop
; and the update never happened.
;
; electron-builder only declares these for its stock check when no custom
; macro exists — we still call that stock check, so declare them here.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  CreateDirectory "$APPDATA\Gamehub"
  ClearErrors
  FileOpen $R2 "$APPDATA\Gamehub\quit-for-update" w
  ${IfNot} ${Errors}
    FileWrite $R2 "1"
    FileClose $R2
    StrCpy $R1 0
    ${Do}
      Sleep 250
      IntOp $R1 $R1 + 1
      ${IfNot} ${FileExists} "$APPDATA\Gamehub\quit-for-update"
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $R1 >= 12
    ${If} ${FileExists} "$APPDATA\Gamehub\quit-for-update"
      Delete "$APPDATA\Gamehub\quit-for-update"
    ${Else}
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close...`
      StrCpy $R1 0
      ${Do}
        Sleep 500
        IntOp $R1 $R1 + 1
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 != 0
          ${ExitDo}
        ${EndIf}
      ${LoopUntil} $R1 >= 20
      Sleep 500
    ${EndIf}
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
