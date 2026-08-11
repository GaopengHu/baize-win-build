; NSIS include - handle running application and uninstaller overwrite
!macro customInit
  ClearErrors
  Delete "$INSTDIR\Uninstall 今点通.exe"
  ClearErrors
!macroend