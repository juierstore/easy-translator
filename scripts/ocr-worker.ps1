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

# ---------------- 语种判定 ----------------
function Get-ScriptStats([string]$text) {
    $cjk = 0; $latin = 0; $kana = 0; $hangul = 0; $other = 0; $total = 0
    if ([string]::IsNullOrEmpty($text)) {
        return @{ cjk = 0; latin = 0; kana = 0; hangul = 0; other = 0; total = 0 }
    }
    foreach ($ch in $text.ToCharArray()) {
        $c = [int]$ch
        if ($c -eq 32 -or $c -eq 10 -or $c -eq 13 -or $c -eq 9) { continue }
        $total++
        if ($c -ge 0x3040 -and $c -le 0x30ff) { $kana++ }
        elseif ($c -ge 0xac00 -and $c -le 0xd7af) { $hangul++ }
        elseif (($c -ge 0x3400 -and $c -le 0x9fff) -or ($c -ge 0xf900 -and $c -le 0xfaff)) { $cjk++ }
        elseif ((($c -ge 0x41 -and $c -le 0x5a)) -or (($c -ge 0x61 -and $c -le 0x7a))) { $latin++ }
        elseif ($c -gt 0x7e) { $other++ }
    }
    return @{ cjk = $cjk; latin = $latin; kana = $kana; hangul = $hangul; other = $other; total = $total }
}

# 语言由识别出的文本本身决定，避免"中文引擎读英文 → 判成中文"这类误判
function Get-LangFromText([string]$text) {
    $s = Get-ScriptStats $text
    if ($s.total -eq 0) { return 'auto' }
    if ($s.kana -ge 3) { return 'ja' }
    if ($s.hangul -ge 3) { return 'ko' }
    if (($s.cjk / $s.total) -ge 0.10) { return 'zh-CN' }
    if (($s.latin / $s.total) -ge 0.45) { return 'en' }
    return 'auto'
}

# 语言码 -> Windows OCR 引擎语言标签
function Get-EngineTagFor([string]$code) {
    switch ($code) {
        'en'    { return 'en-US' }
        'zh-CN' { return 'zh-Hans-CN' }
        'zh-TW' { return 'zh-Hans-CN' }
        'ja'    { return 'ja-JP' }
        'ko'    { return 'ko-KR' }
        'ru'    { return 'ru-RU' }
        'fr'    { return 'fr-FR' }
        'de'    { return 'de-DE' }
        'es'    { return 'es-ES' }
        'it'    { return 'it-IT' }
        'pt'    { return 'pt-BR' }
        default { return 'zh-Hans-CN' }
    }
}

# 拉丁文本质量：真实英文的词较长、单字符词很少；乱码往往是 "EE AE i" 这种
function Measure-TokenQuality([string]$text) {
    $tokens = @($text -split '\s+' | Where-Object { $_ -ne '' })
    if ($tokens.Count -eq 0) { return @{ tokens = 0; avgLen = 0; single = 1.0 } }
    $sum = 0; $single = 0
    foreach ($t in $tokens) {
        $sum += $t.Length
        if ($t.Length -le 1) { $single++ }
    }
    return @{ tokens = $tokens.Count; avgLen = ($sum / $tokens.Count); single = ($single / $tokens.Count) }
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

        # ---- 引擎选择 ----
        # auto: 先用中英混合能力最强的中文引擎；若结果几乎不含中日韩字符，
        #       说明画面是拉丁文本，再换英文引擎重识别（英文引擎对拉丁字形更准）
        if ($want -eq 'auto') {
            $res = Invoke-Ocr $ocrPath 'zh-Hans-CN'
            $joined = ($res.lines | ForEach-Object { $_.text }) -join "`n"
            $stat = Get-ScriptStats $joined

            $needLatin = ($joined.Trim().Length -eq 0) -or ($stat.cjk -lt 2) -or (($stat.cjk / [Math]::Max($stat.total, 1)) -lt 0.06)
            if ($needLatin) {
                try {
                    $alt = Invoke-Ocr $ocrPath 'en-US'
                    $altJoined = ($alt.lines | ForEach-Object { $_.text }) -join "`n"
                    $altStat = Get-ScriptStats $altJoined
                    # 英文引擎读出的拉丁字符更多，或中文引擎基本没读到东西，则采用英文结果
                    if ($altJoined.Trim().Length -gt 0 -and
                        (($joined.Trim().Length -eq 0) -or ($altStat.latin -gt $stat.latin))) {
                        $res = $alt
                        $joined = $altJoined
                    }
                } catch { }
            }
            $engineTag = $res.lang
            # 语言由"识别出的文本"决定，而不是由引擎决定
            $detected = Get-LangFromText $joined
        } else {
            $engineTag = (Get-EngineTagFor $want)
            $res = Invoke-Ocr $ocrPath $engineTag
            $joined = ($res.lines | ForEach-Object { $_.text }) -join "`n"
            $detected = Get-LangFromText $joined

            # 指定英文时：若英文引擎读出来的是"乱码感"的拉丁串（多半其实是中文画面），
            # 再用中文引擎试一次；真读出中文就切过去，避免把中文当英文去翻译
            if ($want -eq 'en') {
                $stat = Get-ScriptStats $joined
                $q = Measure-TokenQuality $joined
                $latinRatio = $stat.latin / [Math]::Max($stat.total, 1)
                # 非 ASCII 杂字符 = 很可能把中文硬读成了乱码，此时必须拿中文引擎复核
                $suspicious = ($stat.other -gt 0)
                $confident = ($joined.Trim().Length -ge 3) -and ($latinRatio -gt 0.70) -and
                             ($q.avgLen -ge 3.2) -and ($q.single -lt 0.35)
                if ($suspicious -or (-not $confident)) {
                    try {
                        $alt = Invoke-Ocr $ocrPath 'zh-Hans-CN'
                        $altText = ($alt.lines | ForEach-Object { $_.text }) -join "`n"
                        $altStat = Get-ScriptStats $altText
                        if ($altStat.cjk -ge 4) {
                            $res = $alt
                            $joined = $altText
                            $engineTag = $alt.lang
                            $detected = Get-LangFromText $altText
                        }
                    } catch { }
                }
            }
        }

        $finalLines = Convert-Lines $res.lines $scale
        $finalText = ($finalLines | ForEach-Object { $_.text }) -join "`n"
        $script:Step = 'done'

        $sw.Stop()
        Write-JsonLine @{
            ok      = $true
            id      = $id
            lang    = $detected
            engine  = $engineTag
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
