; Desk's NSIS installer hooks (bundle > windows > nsis > installerHooks).
;
; Desk Helper.exe keeps running after Desk's window closes, so an install
; over it, or an uninstall, couldn't replace or remove it. Before either,
; it is asked to stop (which also stops the backend in WSL; Desk starts both
; again when it opens), given up to 15 s, then ended if it's still there.

!macro DESK_STOP_HELPER
  ${If} ${FileExists} "$INSTDIR\Desk Helper.exe"
    Push $0
    Push $1
    DetailPrint "Stopping Desk Helper..."
    ; Not waited on here: a WSL that doesn't answer mustn't hang the
    ; installer. The loop below waits, with a limit.
    ExecShell "" "$INSTDIR\Desk Helper.exe" "--stop" SW_HIDE
    StrCpy $1 0
    ${Do}
      Sleep 500
      IntOp $1 $1 + 1
      nsExec::Exec 'cmd.exe /c tasklist /NH /FI "IMAGENAME eq Desk Helper.exe" | find /I "Desk Helper.exe"'
      Pop $0
      ${If} $0 != 0
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $1 >= 30
    nsExec::Exec 'taskkill /F /T /IM "Desk Helper.exe"'
    Pop $0
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DESK_STOP_HELPER
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DESK_STOP_HELPER
!macroend
