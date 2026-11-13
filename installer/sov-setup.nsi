; sov-setup.nsi — one-click Windows installer for the Electron edition
; of the standalone sov app.
;
; Builds sov-setup.exe. The installer:
;   1. Stops ONLY a running sov.exe (by process name, preferring one
;      whose path is under the install dir) before touching any files.
;      It NEVER kills anything by port: a Jupyter notebook, dev server
;      or anything else on port 8888 is left alone. If a non-sov
;      process holds 8888, the app itself reports the conflict on
;      launch.
;   2. Cleans the install dir safely: if the dir is a proven sov
;      install (it holds a `.sov-install` marker written by this
;      installer, or sov.exe), it is wiped so old and new files are
;      never mixed; otherwise only known sov files are removed, so an
;      upgrade can never delete the user's own files if they picked
;      an arbitrary folder. The directory page also forces installs
;      into a dedicated "sov" subfolder (see .onVerifyInstDir).
;   3. Extracts the Electron app (sov.exe + its resources) into that
;      dir.
;   4. Registers an uninstaller (Apps & Features) and writes the
;      install location to HKCU\Software\sov.
;   5. Creates Desktop + Start Menu shortcuts to sov.exe.
;   6. Optionally (finish-page checkbox, off by default) starts sov
;      with Windows via the HKCU Run key.
;
; No admin rights needed: everything installs under the user profile.
; No Python, no venv, no pip, no downloads at install time — the
; Electron binaries are already inside this installer.
; No Client ID, token or secret is bundled or touched. The user's
; ~/.spotify_overlay.json (Client ID) is never deleted by install or
; uninstall. The window-position file ~/.sov-window.json is also
; never deleted — the app keeps its own place across updates.
;
; Versioning — one source of truth, three spellings of the same build:
;   * electron/package.json "version": "2026.11.13" (semver YYYY.MM.DD)
;   * build stamp (server.js BUILD, footer): "2026-11-13m"
;   * this installer / Apps & Features: "2026-11-13m-electron"
; Bump all three together. The letter suffix (l) is the build revision
; within the day; package.json carries only the date because semver
; has no letter slot for it.
;
; Code signing: the exe and this installer are UNSIGNED. Windows
; SmartScreen will warn on first run ("Windows protected your PC" —
; click "More info" > "Run anyway") and some antivirus tools may
; flag the fresh binary. To sign: buy an OV/EV code-signing
; certificate (or use Azure Trusted Signing), then sign sov.exe
; after electron-builder and sign sov-setup.exe after makensis with
; signtool + a timestamp server, and record the thumbprint in the
; packaging notes. See also "Code signing" in electron/README.md.
;
; Build on Linux:  makensis sov-setup.nsi
; (paths below are relative to this .nsi file)

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define SOV_DISPLAY_VERSION "2026-11-13m-electron"
!define SOV_FILE_VERSION "2026.11.13.0"
!define SOV_MARKER ".sov-install"

Name "sov — Spotify overlay"
OutFile "sov-setup.exe"
InstallDir "$LOCALAPPDATA\sov"
InstallDirRegKey HKCU "Software\sov" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "sov — Spotify overlay"

Icon "..\electron\sov.ico"
UninstallIcon "..\electron\sov.ico"

VIProductVersion "${SOV_FILE_VERSION}"
VIAddVersionKey "ProductName" "sov — Spotify overlay"
VIAddVersionKey "ProductVersion" "${SOV_DISPLAY_VERSION}"
VIAddVersionKey "FileVersion" "${SOV_FILE_VERSION}"
VIAddVersionKey "FileDescription" "sov — Spotify overlay installer"
VIAddVersionKey "CompanyName" "sov"
VIAddVersionKey "LegalCopyright" "sov"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\sov.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start sov now"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Start sov with Windows"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION EnableAutostart
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; --- directory page guard (item 1) -----------------------------------------
; MUI_PAGE_DIRECTORY lets the user pick ANY folder, so force installs
; into a dedicated "sov" subfolder: if the chosen dir's leaf isn't
; already "sov", append \sov. (Picking Documents would otherwise put
; sov.exe loose among the user's files — and the old script then
; wiped that whole folder on upgrade/uninstall.)
Function .onVerifyInstDir
  ; Strip a trailing backslash so we don't build a double one.
  StrCpy $R0 $INSTDIR "" -1
  ${If} $R0 == "\"
    StrCpy $INSTDIR $INSTDIR -1
  ${EndIf}
  StrCpy $R0 $INSTDIR "" -4
  ${If} $R0 != "\sov"
    StrCpy $INSTDIR "$INSTDIR\sov"
  ${EndIf}
FunctionEnd

; --- helpers ---------------------------------------------------------------
; Stop ONLY a running sov.exe — never anything on port 8888. Matches
; sov.exe processes whose path is under the install dir; processes
; whose path can't be read are matched by name only (still
; sov.exe — never a python.exe, Jupyter, dev server or anything
; else). If a non-sov process holds port 8888, it is left alone and
; the app reports the conflict on launch.
; NOTE: the $$ below is an escaped literal $ for NSIS — PowerShell
; needs $_.Name, and a bare $ in an NSIS string would be parsed as
; an NSIS variable. Without the escape the stop silently breaks.
; NOTE: the command is a double-quoted NSIS string, so the inner
; PowerShell double quotes are escaped as $" and the single-quoted
; PowerShell literals ('sov.exe', '$INSTDIR*') pass through as-is.
!macro StopSov
  nsExec::ExecToStack "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'sov.exe' -and (-not $$_.ExecutablePath -or $$_.ExecutablePath -like '$INSTDIR*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Pop $0
  Pop $1
!macroend

; Delete only the files sov itself ships (Electron app + uninstaller +
; icon + marker). Used when the install dir is NOT a proven sov
; install, so user files sitting next to the app are never touched.
!macro DeleteKnownSovFiles
  Delete "$INSTDIR\sov.exe"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\sov.ico"
  Delete "$INSTDIR\${SOV_MARKER}"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\*.dll"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir "$INSTDIR"
!macroend

; Clean the install dir before extracting. A full wipe happens ONLY
; when the dir is a proven sov install (marker file or sov.exe
; present); otherwise only known sov files are removed.
Function CleanSovInstallDir
  IfFileExists "$INSTDIR\${SOV_MARKER}" proven
  IfFileExists "$INSTDIR\sov.exe" proven
  Goto unproven
  proven:
  RMDir /r "$INSTDIR"
  Return
  unproven:
  !insertmacro DeleteKnownSovFiles
FunctionEnd

; Finish-page checkbox handler: "Start sov with Windows" (unchecked
; by default). Writes the HKCU Run key; the install section clears
; any stale Run value first, so unchecking on an upgrade removes it.
Function EnableAutostart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "sov" '"$INSTDIR\sov.exe"'
FunctionEnd

Section "sov" SecMain
  DetailPrint "Stopping any running sov..."
  !insertmacro StopSov

  ; Clean install dir — full wipe only for a proven sov install,
  ; known-files-only otherwise (see CleanSovInstallDir).
  DetailPrint "Cleaning the install folder..."
  Call CleanSovInstallDir

  DetailPrint "Extracting sov..."
  SetOutPath "$INSTDIR"
  File /r "..\electron\release\win-unpacked\*.*"
  File "..\electron\sov.ico"

  ; Marker proving this dir is a sov install — the wipe above and the
  ; uninstaller only ever RMDir /r a dir that holds this file (or
  ; sov.exe). Content is the build stamp, for forensics.
  FileOpen $R0 "$INSTDIR\${SOV_MARKER}" w
  FileWrite $R0 "sov ${SOV_DISPLAY_VERSION}$\r$\n"
  FileClose $R0

  ; Clear any stale "start with Windows" entry; the finish-page
  ; checkbox re-creates it only if the user ticks it.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "sov"

  ; Uninstaller + Apps & Features entry.
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\sov" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "DisplayName" "sov — Spotify overlay"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "DisplayVersion" "${SOV_DISPLAY_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "DisplayIcon" "$INSTDIR\sov.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "Publisher" "sov"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "QuietUninstallString" "$INSTDIR\uninstall.exe /S"
  ; EstimatedSize is in KB; 333776 KB is the measured size of the
  ; build-k unpacked tree — approximate, update if packaging changes
  ; materially.
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "EstimatedSize" 333776
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov" "NoRepair" 1

  ; Shortcuts to the app.
  DetailPrint "Creating shortcuts..."
  CreateShortcut "$DESKTOP\sov.lnk" "$INSTDIR\sov.exe" "" "$INSTDIR\sov.ico" 0 "" "" "sov — Spotify overlay"
  CreateShortcut "$SMPROGRAMS\sov.lnk" "$INSTDIR\sov.exe" "" "$INSTDIR\sov.ico" 0 "" "" "sov — Spotify overlay"
SectionEnd

Section "Uninstall"
  !insertmacro StopSov
  Delete "$DESKTOP\sov.lnk"
  Delete "$SMPROGRAMS\sov.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "sov"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sov"
  DeleteRegKey HKCU "Software\sov"
  ; The app files live under $INSTDIR — remove them, but only wipe
  ; the whole dir when it is a proven sov install (marker or
  ; sov.exe); otherwise delete known sov files only, so uninstalling
  ; never deletes the user's own files from a folder they picked.
  ; ~/.spotify_overlay.json (Client ID), the login and
  ; ~/.sov-window.json (window position) are NOT touched.
  IfFileExists "$INSTDIR\${SOV_MARKER}" un_proven
  IfFileExists "$INSTDIR\sov.exe" un_proven
  Goto un_unproven
  un_proven:
  RMDir /r "$INSTDIR"
  Goto un_done
  un_unproven:
  !insertmacro DeleteKnownSovFiles
  un_done:
SectionEnd
