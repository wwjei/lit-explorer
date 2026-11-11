# 安装/卸载只请求关闭目标目录中的产品进程，不结束其他程序或强制终止未保存的工作。
$ErrorActionPreference = 'Stop'
$folder = [IO.Path]::GetFullPath($env:LIT_INSTALL_DIR).TrimEnd('\') + '\'
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) -and
    $_.Name -like 'Lit Explorer*.exe'
})
foreach ($item in $running) {
    $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($process) { [void]$process.CloseMainWindow(); if (!$process.WaitForExit(10000)) { exit 2 } }
}
exit 0
