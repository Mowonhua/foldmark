param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    throw '此验收脚本需要 Windows。'
}
$source = (Resolve-Path -LiteralPath $Executable).Path
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryRoot ('foldmark-startup-' + [guid]::NewGuid().ToString('N'))
$started = [Collections.Generic.List[Diagnostics.Process]]::new()

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FoldmarkStartupWindows {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@

function Start-TestInstance([string]$Path, [string]$WorkingDirectory) {
    $process = Start-Process -FilePath $Path -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
    $started.Add($process)
}

function Get-TestInstances([string]$Path) {
    @($started | Where-Object {
        $_.Refresh()
        -not $_.HasExited -and $_.Path -eq $Path
    })
}

function Wait-TestWindow([string]$Path) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        foreach ($process in (Get-TestInstances $Path)) {
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) { return $process }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "启动后没有可用窗口：$Path"
}

function Assert-SingleInstance([string]$Path) {
    Start-Sleep -Milliseconds 1500
    $instances = @(Get-TestInstances $Path)
    if ($instances.Count -ne 1) {
        throw "同一程序应只有 1 个实例，实际为 $($instances.Count)：$Path"
    }
    return $instances[0]
}

try {
    $firstDirectory = Join-Path $testRoot 'first'
    $secondDirectory = Join-Path $testRoot 'second'
    New-Item -ItemType Directory -Path $firstDirectory, $secondDirectory | Out-Null
    $firstExecutable = Join-Path $firstDirectory 'foldmark.exe'
    $secondExecutable = Join-Path $secondDirectory 'foldmark.exe'
    $renamedExecutable = Join-Path $firstDirectory 'foldmark-copy.exe'
    Copy-Item -LiteralPath $source -Destination $firstExecutable
    Copy-Item -LiteralPath $source -Destination $secondExecutable
    Copy-Item -LiteralPath $source -Destination $renamedExecutable

    # 同时冷启动，验证窗口尚未创建时也只能有一个进程通过启动仲裁。
    1..4 | ForEach-Object { Start-TestInstance $firstExecutable $firstDirectory }
    $null = Wait-TestWindow $firstExecutable
    $primary = Assert-SingleInstance $firstExecutable
    $window = $primary.MainWindowHandle
    Write-Output 'PASS: 同一路径并发启动只保留一个实例。'

    Start-TestInstance $secondExecutable $secondDirectory
    $null = Wait-TestWindow $secondExecutable
    $second = Assert-SingleInstance $secondExecutable
    if ($second.Id -eq $primary.Id) { throw '不同路径的程序必须独立运行。' }
    Write-Output 'PASS: 不同路径的同名程序各有独立实例。'

    Start-TestInstance $renamedExecutable $firstDirectory
    $null = Wait-TestWindow $renamedExecutable
    $null = Assert-SingleInstance $renamedExecutable
    Write-Output 'PASS: 同目录不同文件名的程序独立运行。'

    $null = [FoldmarkStartupWindows]::ShowWindow($window, 6)
    if (-not [FoldmarkStartupWindows]::IsIconic($window)) { throw '无法建立最小化前置状态。' }
    Start-TestInstance $firstExecutable $secondDirectory
    $null = Assert-SingleInstance $firstExecutable
    if ([FoldmarkStartupWindows]::IsIconic($window)) { throw '重复启动没有还原最小化窗口。' }
    Write-Output 'PASS: 从其他工作目录重复启动仍还原已有窗口。'

    $null = [FoldmarkStartupWindows]::ShowWindow($window, 3)
    Start-TestInstance $firstExecutable $firstDirectory
    $null = Assert-SingleInstance $firstExecutable
    if (-not [FoldmarkStartupWindows]::IsZoomed($window)) { throw '重复启动丢失了最大化状态。' }
    Write-Output 'PASS: 重复启动保留最大化状态。'

    $null = [FoldmarkStartupWindows]::ShowWindow($window, 6)
    Start-TestInstance $firstExecutable $firstDirectory
    $null = Assert-SingleInstance $firstExecutable
    if ([FoldmarkStartupWindows]::IsIconic($window) -or -not [FoldmarkStartupWindows]::IsZoomed($window)) {
        throw '重复启动没有恢复最小化之前的最大化状态。'
    }
    Write-Output 'PASS: 最大化后最小化的窗口恢复为最大化。'

    $null = [FoldmarkStartupWindows]::ShowWindow($window, 0)
    Start-TestInstance $firstExecutable $firstDirectory
    $null = Assert-SingleInstance $firstExecutable
    if (-not [FoldmarkStartupWindows]::IsWindowVisible($window)) { throw '重复启动没有显示隐藏窗口。' }
    Write-Output 'PASS: 重复启动显示已有隐藏窗口。'

    # 正常关闭走应用保存及原生销毁流程；只操作脚本创建的测试副本。
    if (-not $primary.CloseMainWindow() -or -not $primary.WaitForExit(10000)) {
        throw '测试主实例没有正常关闭。'
    }
    if ($primary.ExitCode -ne 0) { throw '测试主实例正常关闭时发生异常。' }
    Start-TestInstance $firstExecutable $firstDirectory
    $replacement = Wait-TestWindow $firstExecutable
    $null = Assert-SingleInstance $firstExecutable
    if ($replacement.Id -eq $primary.Id) { throw '关闭后的启动未创建新主实例。' }
    $null = Assert-SingleInstance $secondExecutable
    Write-Output 'PASS: 正常关闭后可再次启动，另一程序继续独立运行。'

    Stop-Process -Id $replacement.Id -Force
    $replacement.WaitForExit()
    Start-TestInstance $firstExecutable $firstDirectory
    $null = Wait-TestWindow $firstExecutable
    $null = Assert-SingleInstance $firstExecutable
    Write-Output 'PASS: 主实例异常退出后可再次启动。'
} finally {
    foreach ($process in $started) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $null = $process.WaitForExit(5000)
        }
        $process.Dispose()
    }
    # 递归清理前确认绝对路径仍位于临时目录，且只指向本次创建的测试副本目录。
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRoot) -notmatch '^foldmark-startup-[0-9a-f]{32}$') {
        throw '测试目录超出允许清理的范围。'
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
