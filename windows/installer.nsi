Unicode true
!ifndef VERSION
  !define VERSION "0.3.49"
!endif
!ifndef FILEVERSION
  !define FILEVERSION "0.3.49.0"
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
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function un.onInit
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\codex-phone-assistant" +3
  MessageBox MB_ICONSTOP "卸载程序不在预期的安装目录中。"
  Abort
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "dist\*"
  WriteUninstaller "$INSTDIR\卸载.exe"
  CreateDirectory "$SMPROGRAMS\codex手机助手"
  CreateShortcut "$SMPROGRAMS\codex手机助手\codex手机助手.lnk" "$INSTDIR\codex-phone-assistant.exe"
  CreateShortcut "$SMPROGRAMS\codex手机助手\卸载.lnk" "$INSTDIR\卸载.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayName" "codex手机助手"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "Publisher" "lijiahao66666"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "DisplayIcon" "$INSTDIR\app.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "UninstallString" '$\"$INSTDIR\卸载.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\codex手机助手\codex手机助手.lnk"
  Delete "$SMPROGRAMS\codex手机助手\卸载.lnk"
  RMDir "$SMPROGRAMS\codex手机助手"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPhoneAssistant"
  RMDir /r "$INSTDIR"
SectionEnd
