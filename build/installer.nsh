!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer" "" "用 Lit 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\LitExplorer\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"--open=%1$\"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\LitExplorer"
!macroend
