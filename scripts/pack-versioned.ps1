<#
.SYNOPSIS
    版本化打包脚本 — 从 package.json 读取版本，输出 NSIS 安装包、便携版、7z 自解压到 release\v<version>\
#>

param(
    [switch]$UseSystemCA
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir   = Split-Path -Parent $ScriptDir
$PackageJson = Join-Path $RootDir "package.json"

if (-not (Test-Path -LiteralPath $PackageJson)) {
    Write-Error "[pack] 未找到 package.json: $PackageJson"; exit 1
}

try {
    $pkg = Get-Content -LiteralPath $PackageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = $pkg.version
    if ([string]::IsNullOrWhiteSpace($version)) { Write-Error "[pack] package.json 中 version 字段为空"; exit 1 }
} catch { Write-Error "[pack] 解析 package.json 失败: $_"; exit 1 }

$outputDir = "release\v$version"
$outputPath = Join-Path $RootDir $outputDir

Write-Host "[pack] ============================================"
Write-Host "[pack]  版本 : $version"
Write-Host "[pack]  输出  : $outputDir"
Write-Host "[pack]  格式  : NSIS 安装包 + 便携版 + 7z 自解压"
Write-Host "[pack] ============================================"

if (-not (Test-Path -LiteralPath $outputPath)) {
    New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
}

if ($UseSystemCA) {
    $env:NODE_OPTIONS = "--use-system-ca"
    Write-Host "[pack] 已设置 NODE_OPTIONS=--use-system-ca"
}

Push-Location -LiteralPath $RootDir
try {
    # electron-builder 按 win.target 顺序构建 NSIS → portable → 7z
    npx electron-builder --win "-c.directories.output=$outputDir"
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        Write-Error "[pack] electron-builder 失败，退出码: $exitCode"
        exit $exitCode
    }

    # 验证三种产物
    $artifacts = @(
        @{ Name = "安装包";      Pattern = "KimiCodeDesktop-Setup-${version}.exe" },
        @{ Name = "便携版";      Pattern = "KimiCodeDesktop-Portable-${version}.exe" },
        @{ Name = "7z 自解压";   Pattern = "KimiCodeDesktop-${version}-x64.7z" }
    )

    Write-Host ""
    Write-Host "[pack] ✅ 构建成功"
    foreach ($a in $artifacts) {
        $found = Get-ChildItem -LiteralPath $outputPath -Filter $a.Pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $sizeMB = $found.Length / 1MB
            Write-Host "[pack] 📦 $($a.Name): $($found.Name) ($('{0:N2}' -f $sizeMB) MB)"
        } else {
            Write-Host "[pack] ⚠️  $($a.Name): 未找到 ($($a.Pattern))"
        }
    }
    Write-Host ""
    Write-Host "[pack] 📂 输出目录: $outputPath"
    Get-ChildItem -LiteralPath $outputPath | ForEach-Object { Write-Host "       $($_.Name)" }
} catch {
    Write-Error "[pack] 构建异常: $_"; exit 1
} finally {
    Pop-Location
}
