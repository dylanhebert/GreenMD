<#
.SYNOPSIS
    Generates GreenMD/Assets/app.ico.

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
    [string] $OutputPath = (Join-Path $PSScriptRoot '..\GreenMD\Assets\app.ico')
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

    # Small tiles get a thinner stroke and a wider mark. Both buy back the interior
    # gaps -- the M's two notches and the bowl's counter -- which are what stop the
    # whole thing collapsing into a blob at 16px.
    $tight = $Size -lt 32
    $stroke = if ($tight) { [Math]::Max(1.15, $Size * 0.072) } else { $Size * 0.075 }

    $pen = New-Object System.Drawing.Pen($ink, [single]$stroke)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    if ($true) {
        # "MD" stacked rather than side by side: the M sits on top, and below it a D
        # turned a quarter turn so its flat back becomes the bar under the M and its
        # bowl hangs downward. The two share that bar, which is what joins them.
        #
        # Stacking is naturally tall, so the proportions below are chosen to keep the
        # whole mark close to square inside a square tile -- the ink is measured after
        # generating, not assumed.
        #
        # Strokes rather than a font glyph, because a glyph loses its shape as the
        # tile shrinks.
        # The drawable box is derived rather than guessed, because a stroked path
        # spills half its width past its own coordinates: a path placed exactly on
        # the margin still paints over it. Padding is therefore the tile's inset,
        # plus the clear space wanted, plus half the stroke.
        #
        # The floor of one pixel of clear space is what keeps the ink off the tile
        # edge at 16px, where a percentage alone rounds away to nothing.
        $clear = if ($tight) { [Math]::Max(1.0, $Size * 0.10) } else { $Size * 0.13 }
        $pad   = $inset + $clear + ($stroke / 2)

        $left   = $pad
        $right  = $Size - $pad
        $mTop   = $pad
        $bottom = $Size - $pad

        # Vertical split expressed against the box, so it holds at any size.
        $span   = $bottom - $mTop
        $shareY = $mTop + $span * 0.56   # the bar: feet of the M, back of the D
        $sideY  = $mTop + $span * 0.70   # straight run before the bowl turns

        $midX = ($left + $right) / 2
        $vDip = $mTop + ($shareY - $mTop) * 0.62

        $letters = New-Object System.Drawing.Drawing2D.GraphicsPath

        # M, its legs landing on the shared bar.
        $letters.AddLines(@(
            (New-Object System.Drawing.PointF([single]$left,  [single]$shareY)),
            (New-Object System.Drawing.PointF([single]$left,  [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$midX,  [single]$vDip)),
            (New-Object System.Drawing.PointF([single]$right, [single]$mTop)),
            (New-Object System.Drawing.PointF([single]$right, [single]$shareY))
        ))

        # The shared bar.
        $letters.StartFigure()
        $letters.AddLine(
            (New-Object System.Drawing.PointF([single]$left,  [single]$shareY)),
            (New-Object System.Drawing.PointF([single]$right, [single]$shareY)))

        # The bowl, hanging from the bar. A cubic with both control points offset by C
        # peaks at 0.75 * C, so C is derived from where the bowl should reach.
        $drop = ($bottom - $sideY) / 0.75

        $letters.StartFigure()
        $letters.AddLine(
            (New-Object System.Drawing.PointF([single]$left, [single]$shareY)),
            (New-Object System.Drawing.PointF([single]$left, [single]$sideY)))
        $letters.AddBezier(
            (New-Object System.Drawing.PointF([single]$left,  [single]$sideY)),
            (New-Object System.Drawing.PointF([single]$left,  [single]($sideY + $drop))),
            (New-Object System.Drawing.PointF([single]$right, [single]($sideY + $drop))),
            (New-Object System.Drawing.PointF([single]$right, [single]$sideY)))
        $letters.AddLine(
            (New-Object System.Drawing.PointF([single]$right, [single]$sideY)),
            (New-Object System.Drawing.PointF([single]$right, [single]$shareY)))

        $g.DrawPath($pen, $letters)
        $letters.Dispose()
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
