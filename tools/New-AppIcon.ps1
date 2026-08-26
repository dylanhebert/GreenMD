<#
.SYNOPSIS
    Generates MarkdownViewer/Assets/app.ico.

.DESCRIPTION
    Draws the icon at every size the Windows shell asks for and packs them into a
    multi-resolution .ico. The embedded EXE icon is what Explorer shows next to
    associated .md files (via the DefaultIcon registry value), so the small sizes
    matter as much as the large ones.

    Design: solid rounded square in HPE green (#01A982), white "M", and a down
    chevron that only appears at 32px and above -- below that it turns to mush and
    the bare M reads better in an Explorer list.

    Re-run after changing the design. Output is committed; this is not part of the build.
#>
[CmdletBinding()]
param(
    [string] $OutputPath = (Join-Path $PSScriptRoot '..\MarkdownViewer\Assets\app.ico')
)

Add-Type -AssemblyName System.Drawing

$sizes  = @(16, 20, 24, 32, 48, 64, 128, 256)
$accent = [System.Drawing.Color]::FromArgb(255, 0x01, 0xA9, 0x82)   # HPE green
$ink    = [System.Drawing.Color]::FromArgb(255, 0xFF, 0xFF, 0xFF)

function New-IconBitmap {
    param([int] $Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Rounded-square tile. Keep a 1px inset so the antialiased edge is not clipped.
    $inset  = [Math]::Max(1, [int]($Size * 0.02))
    $box    = $Size - ($inset * 2)
    $radius = [Math]::Max(2, [int]($Size * 0.18))
    $d      = $radius * 2

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($inset, $inset, $d, $d, 180, 90)
    $path.AddArc($inset + $box - $d, $inset, $d, $d, 270, 90)
    $path.AddArc($inset + $box - $d, $inset + $box - $d, $d, $d, 0, 90)
    $path.AddArc($inset, $inset + $box - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.SolidBrush($accent)
    $g.FillPath($brush, $path)

    $withChevron = $Size -ge 32
    $pen = New-Object System.Drawing.Pen($ink, [single]([Math]::Max(1.4, $Size * 0.075)))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    if ($withChevron) {
        # "M" drawn as strokes rather than text -- a font glyph loses its shape
        # once the tile gets small, and this keeps the weight consistent per size.
        $mLeft   = $Size * 0.18
        $mRight  = $Size * 0.60
        $mTop    = $Size * 0.32
        $mBottom = $Size * 0.66
        $mMidX   = ($mLeft + $mRight) / 2
        $mMidY   = $Size * 0.52

        $g.DrawLines($pen, @(
            (New-Object System.Drawing.PointF([single]$mLeft,  [single]$mBottom)),
            (New-Object System.Drawing.PointF([single]$mLeft,  [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$mMidX,  [single]$mMidY)),
            (New-Object System.Drawing.PointF([single]$mRight, [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$mRight, [single]$mBottom))
        ))

        # Down chevron, right of the M.
        $cx   = $Size * 0.80
        $cTop = $Size * 0.40
        $cBot = $Size * 0.66
        $cArm = $Size * 0.11

        $g.DrawLine($pen, [single]$cx, [single]$cTop, [single]$cx, [single]$cBot)
        $g.DrawLines($pen, @(
            (New-Object System.Drawing.PointF([single]($cx - $cArm), [single]($cBot - $cArm))),
            (New-Object System.Drawing.PointF([single]$cx,           [single]$cBot)),
            (New-Object System.Drawing.PointF([single]($cx + $cArm), [single]($cBot - $cArm)))
        ))
    }
    else {
        # Small sizes: one fat M filling the tile.
        $mLeft   = $Size * 0.22
        $mRight  = $Size * 0.78
        $mTop    = $Size * 0.28
        $mBottom = $Size * 0.72
        $mMidX   = ($mLeft + $mRight) / 2
        $mMidY   = $Size * 0.55

        $g.DrawLines($pen, @(
            (New-Object System.Drawing.PointF([single]$mLeft,  [single]$mBottom)),
            (New-Object System.Drawing.PointF([single]$mLeft,  [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$mMidX,  [single]$mMidY)),
            (New-Object System.Drawing.PointF([single]$mRight, [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$mRight, [single]$mBottom))
        ))
    }

    $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

function ConvertTo-IcoDib {
    <#
        Packs a bitmap as an uncompressed 32bpp DIB for embedding in an .ico.

        The shell has understood PNG-compressed ICO frames since Vista, but GDI+
        (System.Drawing.Icon, and anything built on it) does not -- it throws on
        DrawIcon and callers see a blank icon. Real-world .ico files use DIB for
        the small sizes for exactly this reason, so that is what we emit below
        256px. 256 stays PNG because a 256x256 DIB is 256 KB and every consumer
        that asks for that size handles PNG.
    #>
    param([System.Drawing.Bitmap] $Bitmap)

    $w = $Bitmap.Width
    $h = $Bitmap.Height

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER. Height is doubled: the XOR (colour) mask plus the AND mask.
    $bw.Write([uint32]40)
    $bw.Write([int32]$w)
    $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]0)              # BI_RGB, uncompressed
    $bw.Write([uint32]($w * $h * 4))
    $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                             [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $buffer = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)

        # DIB rows are bottom-up.
        for ($y = $h - 1; $y -ge 0; $y--) {
            $bw.Write($buffer, $y * $stride, $w * 4)
        }
    }
    finally { $Bitmap.UnlockBits($data) }

    # AND mask: 1bpp, rows padded to 4 bytes. The alpha channel does the real work,
    # but the mask must be present and correctly sized or the shell rejects the frame.
    $maskStride = [Math]::Floor(($w + 31) / 32) * 4
    $bw.Write((New-Object byte[] ($maskStride * $h)))

    $bw.Flush()
    $bytes = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()

    # Unary comma: without it PowerShell unrolls the byte[] into the output stream
    # and the caller gets an Object[] of boxed bytes, which BinaryWriter will not
    # write as binary. This silently produces a corrupt .ico.
    return , $bytes
}

$images = @()
foreach ($size in $sizes) {
    $bmp = New-IconBitmap -Size $size

    if ($size -ge 256) {
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
        $ms.Dispose()
        $format = 'PNG'
    }
    else {
        $bytes  = ConvertTo-IcoDib -Bitmap $bmp
        $format = 'DIB'
    }

    $images += , [pscustomobject]@{ Size = $size; Bytes = $bytes; Format = $format }
    $bmp.Dispose()
}

$dir = Split-Path -Parent $OutputPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$fs = [System.IO.File]::Create($OutputPath)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([uint16]0)                 # reserved
$bw.Write([uint16]1)                 # type: 1 = icon
$bw.Write([uint16]$images.Count)

# ICONDIRENTRY per image, then the image data.
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }   # 0 means 256
    $bw.Write([byte]$dim)            # width
    $bw.Write([byte]$dim)            # height
    $bw.Write([byte]0)               # palette count
    $bw.Write([byte]0)               # reserved
    $bw.Write([uint16]1)             # color planes
    $bw.Write([uint16]32)            # bits per pixel
    $bw.Write([uint32]$img.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bw.Write($img.Bytes) }

$bw.Flush(); $bw.Dispose(); $fs.Dispose()

$resolved = (Resolve-Path $OutputPath).Path
"Wrote $resolved ({0:N0} bytes)" -f (Get-Item $resolved).Length
foreach ($img in $images) {
    $expected = if ($img.Format -eq 'DIB') { 40 + ($img.Size * $img.Size * 4) + ([Math]::Floor(($img.Size + 31) / 32) * 4 * $img.Size) } else { $null }
    $note = if ($expected -and $img.Bytes.Length -ne $expected) { "  <-- EXPECTED $expected" } else { '' }
    "  {0,3}px  {1}  {2,7:N0} bytes{3}" -f $img.Size, $img.Format, $img.Bytes.Length, $note
}

# Prove every frame decodes. GDI+ is the strictest common consumer, so if it can
# read them all, Explorer and the taskbar certainly can.
Add-Type -AssemblyName System.Drawing
foreach ($size in $sizes) {
    try {
        $probe = New-Object System.Drawing.Icon($resolved, $size, $size)
        "  verify {0,3}px -> decoded {1}x{2}" -f $size, $probe.Width, $probe.Height
        $probe.Dispose()
    }
    catch { "  verify {0,3}px -> FAILED: {1}" -f $size, $_.Exception.Message }
}
