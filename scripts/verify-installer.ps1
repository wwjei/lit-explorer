# 仅在 CI 临时目录安装，不运行产品，不接触实际用户的应用。
$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/Lit-Explorer-Setup-$version.exe").Path
$target = Join-Path $env:TEMP "lit-install-test-$([guid]::NewGuid())\Lit Explorer"
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.litexplorer.app.mygo'
try {
    $p = Start-Process -FilePath $installer -ArgumentList "/S /D=$target" -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw "Installer exit: $($p.ExitCode)" }
    if (!(Test-Path "$target\Lit Explorer.exe")) { throw 'Missing product executable' }
    $entry = Get-ItemProperty $key
    if ($entry.DisplayName -ne 'Lit Explorer' -or $entry.InstallLocation -ne $target) { throw 'Wrong product identity' }
    if ((Get-Item "$target\Lit Explorer.exe").VersionInfo.ProductName -ne 'Lit Explorer') { throw 'Wrong executable metadata' }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Lit Explorer.lnk'
    if (!(Test-Path $shortcut)) { throw 'Product shortcut missing' }
    # 同目录再安装一次，验证升级接管登记和旧卸载器。
    $p = Start-Process -FilePath $installer -ArgumentList "/S /D=$target" -PassThru -Wait
    if ($p.ExitCode -ne 0 -or !(Test-Path "$target\Lit Explorer.exe")) { throw 'Upgrade failed' }
    $p = Start-Process -FilePath "$target\Uninstall.exe" -ArgumentList '/S' -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw 'Uninstall failed' }
    for ($i=0; $i -lt 100 -and ((Test-Path $key) -or (Test-Path "$target\Lit Explorer.exe")); $i++) { Start-Sleep -Milliseconds 100 }
    if (Test-Path $key) { throw 'Uninstall registry entry remained' }
    if (Test-Path $shortcut) { throw 'Start menu shortcut remained' }
    if (Test-Path "$target\Lit Explorer.exe") { throw 'Executable remained after uninstall' }
} finally {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
}
