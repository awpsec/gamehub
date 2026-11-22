; Gamehub NSIS customisation (electron-builder includes build/installer.nsh).
;
; Before the stock "is Gamehub running?" check, ask a running Gamehub to quit
; itself: drop %APPDATA%\Gamehub\quit-for-update and wait up to ~6 s. A
; per-user installer cannot taskkill an ELEVATED Gamehub (Settings → Run as
; administrator), so without this the stock check fails with "cannot be
; closed" — or, when silent, quits and the update never happens. Gamehub
; (2.1.1+) polls for this file and exits cleanly.
; electron-builder only declares these for its stock check when no custom
; macro exists — we still call that stock check, so declare them here.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    CreateDirectory "$APPDATA\Gamehub"
    ClearErrors
    FileOpen $R2 "$APPDATA\Gamehub\quit-for-update" w
    ${IfNot} ${Errors}
      FileWrite $R2 "1"
      FileClose $R2
    ${EndIf}
    StrCpy $R1 0
    ${Do}
      Sleep 500
      IntOp $R1 $R1 + 1
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 != 0
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $R1 >= 12
    Delete "$APPDATA\Gamehub\quit-for-update"
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
