#Requires -Version 5.1
<#
.SYNOPSIS
  准备 Wechat 鲸鲸 的运行环境：Python 虚拟环境 + 桥接依赖。

.DESCRIPTION
  插件自带 runtime/wechat-adapter（Python）与 runtime/wechat-bridge（Node）。
  这个脚本只做两件事：
    1. 在 runtime/wechat-adapter 建 .venv 并装 requirements.txt
    2. 在 runtime/wechat-bridge 跑 npm install

  装完打开设置 → 「Wechat 鲸鲸」→ 一键启动即可。可重复执行（幂等）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1
#>
param(
  [string]$Python = "python",
  [switch]$SkipNode
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$adapter = Join-Path $root "runtime\wechat-adapter"
$bridge = Join-Path $root "runtime\wechat-bridge"

function Step($msg) { Write-Host "`n[setup] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[setup] 失败：$msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $adapter)) { Fail "找不到 runtime\wechat-adapter" }
if (-not (Test-Path $bridge)) { Fail "找不到 runtime\wechat-bridge" }

# ---- Python ----
Step "检查 Python"
try { & $Python --version } catch { Fail "找不到 $Python（装 Python 3.10+ 并加入 PATH）" }
$pyVersion = (& $Python -c "import sys;print('%d.%d'%sys.version_info[:2])").Trim()
Write-Host "[setup] Python $pyVersion"

$venv = Join-Path $adapter ".venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  Step "创建虚拟环境（$venv）"
  & $Python -m venv $venv
} else {
  Write-Host "[setup] 虚拟环境已存在"
}

Step "安装适配层依赖"
$pip = Join-Path $venv "Scripts\pip.exe"
& $pip install --upgrade pip -q
& $pip install -r (Join-Path $adapter "requirements.txt")
if ($LASTEXITCODE -ne 0) { Fail "pip install 失败" }

# ---- Node ----
if (-not $SkipNode) {
  Step "安装桥接依赖"
  $nodeModules = Join-Path $bridge "node_modules"
  if (Test-Path $nodeModules) {
    Write-Host "[setup] node_modules 已存在，跳过（要重装先删掉它）"
  } else {
    Push-Location $bridge
    try {
      & npm install --omit=dev
      if ($LASTEXITCODE -ne 0) { Fail "npm install 失败（需要 Node 20+ 和 npm）" }
    } finally { Pop-Location }
  }
}

Step "完成"
Write-Host "接下来：重启 DSH → 设置 → Wechat 鲸鲸 → 一键启动" -ForegroundColor Green
