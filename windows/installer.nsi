Unicode true
!ifndef VERSION
  !define VERSION "1.0.1"
!endif
!ifndef FILEVERSION
  !define FILEVERSION "1.0.1.0"
!endif
!ifndef APP_ICON
  !define APP_ICON "app.ico"
!endif
Name "codex手机助手"
OutFile "codex-phone-assistant-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\codex-phone-assistant"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${FILEVERSION}"
VIAddVersionKey /LANG=2052 "ProductName" "codex手机助手"
VIAddVersionKey /LANG=2052 "CompanyName" "lijiahao66666"
VIAddVersionKey /LANG=2052 "FileDescription" "codex手机助手 Windows 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright lijiahao66666"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\codex-phone-assistant.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 codex手机助手"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function QuitRunningAssistant
  FindWindow $0 "" "codex手机助手"
  StrCmp $0 0 done
  ExecWait '"$INSTDIR\codex-phone-assistant.exe" --quit'
  Sleep 800
  FindWindow $0 "" "codex手机助手"
  StrCmp $0 0 done
  MessageBox MB_ICONSTOP|MB_OK "codex手机助手正在运行，Windows 无法覆盖被占用的程序文件。$\r$\n$\r$\n请从系统托盘右键选择“退出”，然后重新运行安装包。"
  Abort
  done:
FunctionEnd

Function .onInit
  Call QuitRunningAssistant
FunctionEnd

Function un.onInit
  FindWindow $0 "" "codex手机助手"
  StrCmp $0 0 unNotRunning
  MessageBox MB_ICONSTOP|MB_OK "卸载前请先从系统托盘退出 codex手机助手。"
  Abort
  unNotRunning:
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\codex-phone-assistant" unPathOk
  MessageBox MB_ICONSTOP "卸载程序不在预期的安装目录中。"
  Abort
  unPathOk:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "dist\*"
  WriteUninstaller "$INSTDIR\卸载.exe"
  SetShellVarContext current
  CreateShortcut "$SMPROGRAMS\codex手机助手.lnk" "$INSTDIR\codex-phone-assistant.exe" "" "$INSTDIR\app.ico" 0 SW_SHOWNORMAL "" "Codex 手机助手"
  CreateShortcut "$DESKTOP\codex手机助手.lnk" "$INSTDIR\codex-phone-assistant.exe" "" "$INSTDIR\app.ico" 0 SW_SHOWNORMAL "" "Codex 手机助手"
  ; Remove the nested Start Menu shortcuts created by older installers.
  Delete "$SMPROGRAMS\codex手机助手\codex手机助手.lnk"
  Delete "$SMPROGRAMS\codex手机助手\卸载.lnk"
  RMDir "$SMPROGRAMS\codex手机助手"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayName" "codex手机助手"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "Publisher" "lijiahao66666"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayIcon" "$INSTDIR\app.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "UninstallString" '$\"$INSTDIR\卸载.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\codex手机助手.lnk"
  Delete "$DESKTOP\codex手机助手.lnk"
  Delete "$SMPROGRAMS\codex手机助手\codex手机助手.lnk"
  Delete "$SMPROGRAMS\codex手机助手\卸载.lnk"
  RMDir "$SMPROGRAMS\codex手机助手"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant"
  RMDir /r "$INSTDIR"
SectionEnd
