<#
.SYNOPSIS
    版本化打包脚本 — 从 package.json 读取版本，输出到 release\v<version>\

.DESCRIPTION
    运行 electron-builder --win portable，将产物输出到 release\v<version>\ 目录下，
    实现按版本隔离存储。保留 release 下其他版本目录，不做删除。
    构建失败时返回非零退出码。

.PARAMETER UseSystemCA
    当本机 CA 证书导致 electron-builder 下载失败时，设置此开关注入
    NODE_OPTIONS=--use-system-ca，使用系统证书存储。
#>

param(
    [switch]$UseSystemCA
)

$ErrorActionPreference = "Stop"

# 脚本所在目录上一级即为项目根目录
$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir   = Split-Path -Parent $ScriptDir
$PackageJson = Join-Path $RootDir "package.json"

# ---------------------------------------------------------------------------
# 1. 读取版本
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $PackageJson)) {
    Write-Error "[pack] 未找到 package.json: $PackageJson"
    exit 1
}

try {
    $pkg = Get-Content -LiteralPath $PackageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = $pkg.version
    if ([string]::IsNullOrWhiteSpace($version)) {
        Write-Error "[pack] package.json 中 version 字段为空"
        exit 1
    }
} catch {
    Write-Error "[pack] 解析 package.json 失败: $_"
    exit 1
}

# ---------------------------------------------------------------------------
# 2. 确定输出目录
# ---------------------------------------------------------------------------
$outputDir = "release\v$version"
$outputPath = Join-Path $RootDir $outputDir

Write-Host "[pack] ============================================"
Write-Host "[pack]  版本 : $version"
Write-Host "[pack]  输出  : $outputDir"
Write-Host "[pack] ============================================"

# 确保输出目录存在（electron-builder 会自动创建，但提前创建更安全）
if (-not (Test-Path -LiteralPath $outputPath)) {
    New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
    Write-Host "[pack] 创建输出目录: $outputDir"
}

# ---------------------------------------------------------------------------
# 3. 可选的系统 CA 证书注入
# ---------------------------------------------------------------------------
if ($UseSystemCA) {
    $env:NODE_OPTIONS = "--use-system-ca"
    Write-Host "[pack] 已设置 NODE_OPTIONS=--use-system-ca"
}

# ---------------------------------------------------------------------------
# 4. 执行构建
# ---------------------------------------------------------------------------
Push-Location -LiteralPath $RootDir
try {
    # 用 -c.directories.output 覆盖 package.json build.directories.output
    npx electron-builder --win portable "-c.directories.output=$outputDir"
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        Write-Error "[pack] electron-builder 失败，退出码: $exitCode"
        exit $exitCode
    }

    # -----------------------------------------------------------------------
    # 5. 输出产物信息
    # -----------------------------------------------------------------------
    $artifactName = "KimiCodeDesktop-Portable.exe"
    $artifact = Join-Path $outputPath $artifactName

    if (Test-Path -LiteralPath $artifact) {
        $item = Get-Item -LiteralPath $artifact
        $sizeMB = $item.Length / 1MB
        Write-Host ""
        Write-Host "[pack] ✅ 构建成功"
        Write-Host "[pack] 📦 产物: $artifact"
        Write-Host "[pack] 📏 大小: $("{0:N2}" -f $sizeMB) MB"
        Write-Host ""
        Write-Host "[pack] 📂 输出目录: $outputPath"
        Get-ChildItem -LiteralPath $outputPath | ForEach-Object {
            Write-Host "       $($_.Name)"
        }
    } else {
        Write-Error "[pack] 构建完成但未找到产物 $artifactName"
        Write-Host "[pack] 📂 输出目录内容:"
        if (Test-Path -LiteralPath $outputPath) {
            Get-ChildItem -LiteralPath $outputPath | ForEach-Object {
                Write-Host "       $($_.Name)"
            }
        }
        exit 1
    }
} catch {
    Write-Error "[pack] 构建异常: $_"
    exit 1
} finally {
    Pop-Location
}
