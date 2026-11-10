; Desk's NSIS installer hooks (bundle > windows > nsis > installerHooks).
;
; Desk Helper.exe keeps running after Desk's window closes, so an install
; over it, or an uninstall, couldn't replace or remove it. Before either,
; it is asked to stop (which also stops the backend in WSL; Desk starts both
; again when it opens), given up to 15 s, then ended if it's still there.
;
; Only the Desk Helper.exe in this install's folder is looked for or ended,
; by its full path (handed to PowerShell in DESK_HELPER_EXE, so no quoting
; of the path is needed), never another program of the same name.

!define DESK_HELPER_PS `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
!define DESK_HELPER_MINE `Get-Process -Name 'Desk Helper' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$env:DESK_HELPER_EXE }`

!macro DESK_STOP_HELPER
  ${If} ${FileExists} "$INSTDIR\Desk Helper.exe"
    Push $0
    Push $1
    System::Call 'Kernel32::SetEnvironmentVariable(t "DESK_HELPER_EXE", t "$INSTDIR\Desk Helper.exe")i'
    DetailPrint "Stopping Desk Helper..."
    ; Not waited on here: a WSL that doesn't answer mustn't hang the
    ; installer. The loop below waits, with a limit.
    ExecShell "" "$INSTDIR\Desk Helper.exe" "--stop" SW_HIDE
    StrCpy $1 0
    ${Do}
      Sleep 500
      IntOp $1 $1 + 1
      nsExec::Exec `${DESK_HELPER_PS} "if (${DESK_HELPER_MINE}) { exit 0 } else { exit 1 }"`
      Pop $0
      ${If} $0 != 0
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $1 >= 30
    ; Still there: end it and what it started (its wsl.exe), by process id.
    nsExec::Exec `${DESK_HELPER_PS} "${DESK_HELPER_MINE} | ForEach-Object { taskkill.exe /F /T /PID $$_.Id }"`
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
