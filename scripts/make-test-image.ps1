[CmdletBinding()]
param(
    [string]$Out = "$PSScriptRoot\..\.tmp\ocr-test.png"
)

Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$W = 960; $H = 460
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'ClearTypeGridFit'
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 36, 48))

# 深色卡片 + 浅色文字
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 29, 39))), 40, 30, 880, 170)
$f1 = New-Object System.Drawing.Font 'Microsoft YaHei UI', 26, ([System.Drawing.FontStyle]::Bold)
$g.DrawString('截图取词翻译 Screenshot Translate', $f1, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 235, 240, 250))), 64, 56)
$f2 = New-Object System.Drawing.Font 'Microsoft YaHei UI', 17
$g.DrawString('按下快捷键后框选屏幕区域，文字会被糊化并替换成译文。', $f2, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 150, 165, 190))), 64, 110)
$g.DrawString('The quick brown fox jumps over the lazy dog 0123456789', $f2, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 120, 200, 255))), 64, 148)

# 浅色卡片 + 深色文字
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 252, 252, 250))), 40, 225, 880, 195)
$f3 = New-Object System.Drawing.Font 'Microsoft YaHei UI', 20, ([System.Drawing.FontStyle]::Bold)
$g.DrawString('历史记录 History Records', $f3, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 28, 32, 40))), 64, 250)
$g.DrawString('记录内容包括截图、原语言、翻译结果与时间。', $f2, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 70, 78, 92))), 64, 300)
$g.DrawString('Translate API: deepseek-chat  |  OCR: Windows.Media.Ocr', $f2, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 60, 60))), 64, 345)
$g.DrawString('目标语言 · 复制 · 截图 · 对照 · 原图/译文', (New-Object System.Drawing.Font 'Microsoft YaHei UI', 15), (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 110, 118, 132))), 64, 382)

$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $Out"
