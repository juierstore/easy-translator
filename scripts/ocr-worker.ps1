#requires -Version 5.1
<#
  EasyTranslator - Windows 原生 OCR 常驻 worker
  依赖：Windows.Media.Ocr（系统自带，无需安装任何组件）
  协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应
    请求 {"id":1,"path":"C:\\x.png","lang":"auto|zh-Hans-CN|en-US","upscale":2}
    响应 {"id":1,"ok":true,"lang":"zh-Hans-CN","text":"...","lines":[...]}
        返回坐标已除以 upscale，即原始图片坐标系。
  注意：本文件必须以 UTF-8 BOM 保存，否则 PS 5.1 会按 GBK 解析中文注释。
#>
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-JsonLine($obj) {
    $json = $obj | ConvertTo-Json -Depth 9 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]

    function Await($op, [Type]$type) {
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $task = $asTask.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        return $task.Result
    }
} catch {
    Write-JsonLine @{ ok = $false; fatal = "winrt_init_failed: $($_.Exception.Message)" }
    exit 1
}

# ---------------- 文本清洗 ----------------
$script:Step = 'init'
$script:CjkRange = '[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]'
# 注意: PowerShell 把 U+2018/2019/201C/201D 也当作引号, 不能直接写进字符串
$script:NoSpaceBefore = '，。；：！？、）〕〉》」』】.,;:!?)]}>%'
$script:NoSpaceAfter = '（〔〈《「『【([{<'
$script:SmartBefore = @([char]0x201D, [char]0x2019)
$script:SmartAfter = @([char]0x201C, [char]0x2018)

function Test-CjkChar([string]$ch) {
    if ([string]::IsNullOrEmpty($ch)) { return $false }
    return ($ch -match $script:CjkRange)
}

function Join-Words($words) {
    $sb = New-Object System.Text.StringBuilder
    $prev = ''
    foreach ($w in $words) {
        $t = [string]$w.t
        if ([string]::IsNullOrEmpty($t)) { continue }
        if ($sb.Length -gt 0) {
            $a = $prev.Substring($prev.Length - 1, 1)
            $b = $t.Substring(0, 1)
            $noSpace = $false
            if ((Test-CjkChar $a) -and (Test-CjkChar $b)) { $noSpace = $true }
            if ($script:NoSpaceBefore.IndexOf($b) -ge 0) { $noSpace = $true }
            if ($script:NoSpaceAfter.IndexOf($a) -ge 0) { $noSpace = $true }
            if ($script:SmartBefore -contains $b) { $noSpace = $true }
            if ($script:SmartAfter -contains $a) { $noSpace = $true }
            if ($a -eq '-' -or $a -eq '/' -or $a -eq '@' -or $a -eq '.') { $noSpace = $true }
            if (-not $noSpace) { $null = $sb.Append(' ') }
        }
        $null = $sb.Append($t)
        $prev = $t
    }
    return $sb.ToString()
}

function Test-CjkText([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $false }
    return ($text -match $script:CjkRange)
}

# ---------------- 图片缩放 ----------------
$script:MaxDim = 10000
try { $script:MaxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { }

function Resize-Image([string]$path, [double]$scale) {
    $img = [System.Drawing.Image]::FromFile($path)
    try {
        $nw = [int][Math]::Round($img.Width * $scale)
        $nh = [int][Math]::Round($img.Height * $scale)
        if ($nw -lt 8) { $nw = 8 }
        if ($nh -lt 8) { $nh = 8 }
        $limit = $script:MaxDim - 40
        if ($nw -gt $limit -or $nh -gt $limit) {
            $k = [Math]::Min($limit / $nw, $limit / $nh)
            $nw = [int]($nw * $k); $nh = [int]($nh * $k)
        }
        $bmp = New-Object System.Drawing.Bitmap $nw, $nh
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $gfx.DrawImage($img, 0, 0, $nw, $nh)
        } finally { $gfx.Dispose() }

        $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("et_ocr_" + [guid]::NewGuid().ToString('N') + ".png"))
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return @{ path = $tmp; scale = ($nw / $img.Width) }
    } finally { $img.Dispose() }
}

# ---------------- 解码 ----------------
function Open-BitmapStream([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if ($null -eq $bytes -or $bytes.Length -eq 0) { throw 'empty_image' }
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter -ArgumentList $stream
    try {
        $writer.WriteBytes($bytes)
        $null = Await ($writer.StoreAsync()) ([uint32])
        $null = $writer.DetachStream()
    } finally {
        try { $writer.Dispose() } catch { }
    }
    $null = $stream.Seek(0)
    return $stream
}

# ---------------- OCR ----------------
$script:EngineCache = @{}
function Get-Engine([string]$tag) {
    if ($script:EngineCache.ContainsKey($tag)) { return $script:EngineCache[$tag] }
    $engine = $null
    try {
        $lang = New-Object Windows.Globalization.Language -ArgumentList $tag
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    } catch { $engine = $null }
    if ($null -eq $engine) {
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
    }
    $script:EngineCache[$tag] = $engine
    return $engine
}

function Invoke-Ocr([string]$path, [string]$tag) {
    $script:Step = 'engine'
    $engine = Get-Engine $tag
    if ($null -eq $engine) { throw "no_ocr_engine_for:$tag" }

    $script:Step = 'stream'
    $stream = Open-BitmapStream $path
    try {
        $script:Step = 'decode'
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $script:Step = 'softwarebitmap'
        $bmp = Await ($decoder.GetSoftwareBitmapAsync(
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $script:Step = 'recognize'
        $result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
        $script:Step = 'parse'

        $lines = New-Object System.Collections.ArrayList
        foreach ($ln in $result.Lines) {
            if ($ln.Words.Count -eq 0) { continue }
            $words = New-Object System.Collections.ArrayList
            $minX = [double]::MaxValue; $minY = [double]::MaxValue
            $maxX = [double]::MinValue; $maxY = [double]::MinValue
            foreach ($w in $ln.Words) {
                $r = $w.BoundingRect
                $null = $words.Add(@{
                        t = $w.Text
                        x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height
                    })
                if ($r.X -lt $minX) { $minX = $r.X }
                if ($r.Y -lt $minY) { $minY = $r.Y }
                if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
                if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
            }
            if ($maxX -le $minX) { continue }
            $null = $lines.Add([pscustomobject]@{
                    text  = (Join-Words $words)
                    x     = $minX; y = $minY
                    w     = ($maxX - $minX); h     = ($maxY - $minY)
                    words = $words
                })
        }
        return [pscustomobject]@{
            lines  = $lines
            width  = $decoder.PixelWidth
            height = $decoder.PixelHeight
            lang   = $engine.RecognizerLanguage.LanguageTag
        }
    } finally {
        try { $stream.Dispose() } catch { }
    }
}

function Convert-Lines($lines, [double]$scale) {
    $out = New-Object System.Collections.ArrayList
    foreach ($l in $lines) {
        $ws = New-Object System.Collections.ArrayList
        foreach ($w in $l.words) {
            $null = $ws.Add(@{
                    t = $w.t
                    x = [Math]::Round($w.x / $scale, 1); y = [Math]::Round($w.y / $scale, 1)
                    w = [Math]::Round($w.w / $scale, 1); h = [Math]::Round($w.h / $scale, 1)
                })
        }
        $null = $out.Add(@{
                text  = $l.text
                x     = [Math]::Round($l.x / $scale, 1); y = [Math]::Round($l.y / $scale, 1)
                w     = [Math]::Round($l.w / $scale, 1); h = [Math]::Round($l.h / $scale, 1)
                words = $ws
            })
    }
    return $out
}

# ---------------- 就绪握手 ----------------
$avail = @()
try { foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $avail += $l.LanguageTag } } catch { }
Write-JsonLine @{ ok = $true; ready = $true; pid = $PID; maxDim = $script:MaxDim; languages = $avail }

# ---------------- 主循环 ----------------
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'quit') { break }

    $req = $null
    try { $req = $line | ConvertFrom-Json } catch {
        Write-JsonLine @{ ok = $false; id = 0; error = 'bad_json' }
        continue
    }

    $id = $req.id
    $tmpPath = $null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $path = [string]$req.path
        if (-not (Test-Path -LiteralPath $path)) { throw 'file_not_found' }

        $want = [string]$req.lang
        if ([string]::IsNullOrWhiteSpace($want)) { $want = 'auto' }

        $scale = 1.0
        if ($null -ne $req.upscale) { $scale = [double]$req.upscale }
        $ocrPath = $path
        if ($scale -ne 1.0 -and $scale -gt 0) {
            $script:Step = 'resize'
            $rz = Resize-Image $path $scale
            $tmpPath = $rz.path
            $ocrPath = $rz.path
            $scale = $rz.scale
        }

        $primary = 'zh-Hans-CN'
        if ($want -ne 'auto') { $primary = $want }

        $res = Invoke-Ocr $ocrPath $primary
        $usedLang = $res.lang

        $joined = ($res.lines | ForEach-Object { $_.text }) -join "`n"
        if ($want -eq 'auto' -and $joined.Trim().Length -gt 0 -and -not (Test-CjkText $joined)) {
            try {
                $alt = Invoke-Ocr $ocrPath 'en-US'
                $altJoined = ($alt.lines | ForEach-Object { $_.text }) -join "`n"
                if ($altJoined.Trim().Length -ge $joined.Trim().Length) {
                    $res = $alt; $usedLang = $alt.lang; $joined = $altJoined
                }
            } catch { }
        }

        $finalLines = Convert-Lines $res.lines $scale
        $finalText = ($finalLines | ForEach-Object { $_.text }) -join "`n"
        $script:Step = 'done'

        $sw.Stop()
        Write-JsonLine @{
            ok      = $true
            id      = $id
            lang    = $usedLang
            text    = $finalText
            width   = [Math]::Round($res.width / $scale, 1)
            height  = [Math]::Round($res.height / $scale, 1)
            upscale = $scale
            ms      = $sw.ElapsedMilliseconds
            lines   = $finalLines
        }
    } catch {
        $sw.Stop()
        $detail = $_.Exception.Message
        if ($_.Exception.InnerException) { $detail += ' | inner=' + $_.Exception.InnerException.Message }
        if ($_.Exception.InnerException -and $_.Exception.InnerException.InnerException) {
            $detail += ' | inner2=' + $_.Exception.InnerException.InnerException.Message
        }
        $detail += ' | step=' + $script:Step
        if ($_.InvocationInfo) { $detail += ' @L' + $_.InvocationInfo.ScriptLineNumber }
        Write-JsonLine @{ ok = $false; id = $id; error = $detail; ms = $sw.ElapsedMilliseconds }
    } finally {
        if ($tmpPath -and (Test-Path -LiteralPath $tmpPath)) {
            try { Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}
