#Requires -RunAsAdministrator
<#
.SYNOPSIS
  为 dsh-plugin-wechat 创建一台跑微信的 Hyper-V 虚拟机。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\new-vm.ps1 `
    -Name dsh-wechat -IsoPath "D:\iso\Win11.iso" -VmRoot "D:\Hyper-V"
#>
param(
  [string]$Name = "dsh-wechat",
  [Parameter(Mandatory = $true)][string]$IsoPath,
  [string]$VmRoot = "D:\Hyper-V",
  [int]$Cpu = 4,
  [int]$MemoryGB = 8,
  [int]$MinimumMemoryGB = 2,
  [int]$DiskGB = 64,
  [string]$SwitchName = "Default Switch"
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "[new-vm] 错误：$msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { Fail "没找到 Hyper-V 模块（先启用 Hyper-V 并重启）" }
if (-not (Test-Path $IsoPath)) { Fail "ISO 不存在：$IsoPath" }
if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { Fail "虚拟机 $Name 已存在（先删除或换 -Name）" }

New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null
$vhd = Join-Path $VmRoot "$Name.vhdx"

Write-Host "[new-vm] 创建动态磁盘 $DiskGB GB -> $vhd"
New-VHD -Path $vhd -SizeBytes ($DiskGB * 1GB) -Dynamic | Out-Null

Write-Host "[new-vm] 创建 Gen2 虚拟机 $Name"
New-VM -Name $Name -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) -VHDPath $vhd | Out-Null

Set-VMMemory -VMName $Name -DynamicMemoryEnabled $true -MinimumBytes ($MinimumMemoryGB * 1GB) -MaximumBytes ($MemoryGB * 1GB) -StartupBytes ($MemoryGB * 1GB)
Set-VMProcessor -VMName $Name -Count $Cpu
Set-VM -Name $Name -AutomaticCheckpointsEnabled $true -CheckpointType Standard

if (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue) {
  Add-VMNetworkAdapter -VMName $Name -SwitchName $SwitchName
  Write-Host "[new-vm] 网卡已连到 $SwitchName"
} else {
  Write-Host "[new-vm] 警告：找不到交换机 $SwitchName，请手动连一个" -ForegroundColor Yellow
}

Add-VMDvdDrive -VMName $Name -Path $IsoPath
$dvd = Get-VMDvdDrive -VMName $Name
Set-VMFirmware -VMName $Name -FirstBootDevice $dvd

# Windows 11 需要 vTPM
try {
  Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
  Enable-VMTPM -VMName $Name
  Write-Host "[new-vm] vTPM 已启用"
} catch {
  Write-Host "[new-vm] 警告：vTPM 启用失败（Windows 11 可能装不上）：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[new-vm] 完成：$Name（$Cpu vCPU / $MemoryGB GB / $DiskGB GB / $SwitchName）" -ForegroundColor Green
Write-Host "下一步：Start-VM -Name $Name，连上控制台装 Windows 11"
Write-Host "装完微信后建议：Checkpoint-VM -Name $Name -SnapshotName clean-wechat"
