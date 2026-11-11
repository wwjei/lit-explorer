Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!define PRODUCT "Lit Explorer"
; 稳定技术标识用于接管旧安装登记，不作为产品名称展示。
!define APPKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.litexplorer.app.mygo"
Name "${PRODUCT}"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
RequestExecutionLevel user
BrandingText " "
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT}.exe"
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var OldDir

!macro CLOSE_APP PREFIX
Function ${PREFIX}CloseApp
  Exch $0
  InitPluginsDir
  File /oname=$PLUGINSDIR\close-app.ps1 "${CLOSE_SCRIPT}"
  System::Call 'Kernel32::SetEnvironmentVariable(t "LIT_INSTALL_DIR", t r0)'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-app.ps1"'
  Pop $1
  ${If} $1 != 0
    MessageBox MB_OK|MB_ICONSTOP "请保存并关闭 Lit Explorer 后重试。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $0
FunctionEnd
!macroend
!insertmacro CLOSE_APP ""
!insertmacro CLOSE_APP "un."

Section "安装"
  SetShellVarContext current
  Push "$INSTDIR"
  Call CloseApp
  ReadRegStr $OldDir HKCU "${APPKEY}" "InstallLocation"
  ${If} $OldDir != ""
    IfFileExists "$OldDir\Uninstall.exe" 0 old_done
    Push "$OldDir"
    Call CloseApp
    ExecWait '"$OldDir\Uninstall.exe" /S _?=$OldDir' $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "旧版本卸载失败，请关闭应用后重试。" /SD IDOK
      SetErrorLevel 3
      Quit
    ${EndIf}
    Delete "$OldDir\Uninstall.exe"
    RMDir "$OldDir"
  ${EndIf}
  old_done:
  ; 接管此前 Electron 安装版占用的同名安装目录。
  IfFileExists "$INSTDIR\Uninstall Lit Explorer.exe" 0 electron_done
  ExecWait '"$INSTDIR\Uninstall Lit Explorer.exe" /S _?=$INSTDIR' $0
  ${If} $0 != 0
    SetErrorLevel 3
    Quit
  ${EndIf}
  electron_done:
  SetOutPath "$INSTDIR"
  File "/oname=${PRODUCT}.exe" "${APP_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\Lit Explorer MyGo.lnk"
  Delete "$DESKTOP\Lit Explorer MyGo.lnk"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${PRODUCT}.exe"
  WriteRegStr HKCU "${APPKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${APPKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${APPKEY}" "DisplayIcon" "$INSTDIR\${PRODUCT}.exe"
  WriteRegStr HKCU "${APPKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APPKEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${APPKEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "${APPKEY}" "Publisher" "wwjei"
  WriteRegDWORD HKCU "${APPKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APPKEY}" "NoRepair" 1
  DeleteRegKey HKCU "Software\Classes\Directory\shell\LitExplorerMyGo"
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer" "" "用 Lit Explorer 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer" "Icon" "$INSTDIR\${PRODUCT}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer\command" "" '$\"$INSTDIR\${PRODUCT}.exe$\" $\"--open=%1$\"'
SectionEnd

Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${PRODUCT}.exe"
FunctionEnd
Section "Uninstall"
  SetShellVarContext current
  Push "$INSTDIR"
  Call un.CloseApp
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  DeleteRegKey HKCU "${APPKEY}"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\LitExplorer"
  Delete "$INSTDIR\${PRODUCT}.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; 用户数据位于独立目录，卸载不删除项目记录或授权。
SectionEnd
