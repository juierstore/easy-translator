Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot '..\assets'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

function New-Icon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [Math]::Max(1, [int]($size * 0.045))
    $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - $pad * 2), ($size - $pad * 2)
    $radius = [Math]::Max(2, [int]($size * 0.24))

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 82, 138, 255)
    $c2 = [System.Drawing.Color]::FromArgb(255, 150, 110, 255)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45.0
    $g.FillPath($brush, $path)

    # 内高光
    $hl = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
        ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)),
        ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)), 90.0
    $g.FillPath($hl, $path)

    # 译 字
    $txt = [string][char]0x8BD1
    $fontSize = $size * 0.56
    $font = New-Object System.Drawing.Font 'Microsoft YaHei UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.DrawString($txt, $font, $white, (New-Object System.Drawing.RectangleF 0, ($size * 0.015), $size, $size), $sf)

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved $outPath"
}

New-Icon 512 (Join-Path $dir 'icon-512.png')
New-Icon 256 (Join-Path $dir 'icon.png')
New-Icon 32  (Join-Path $dir 'tray.png')
New-Icon 16  (Join-Path $dir 'tray-16.png')
