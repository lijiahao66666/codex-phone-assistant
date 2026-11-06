Unicode true
Name "codex手机助手"
OutFile "codex-phone-assistant-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\codex-phone-assistant"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!define MUI_ABORTWARNING
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
