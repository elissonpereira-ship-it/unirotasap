$basePath = 'c:\Users\10642\Desktop\Projeto Principal\App e Programa UniRotas'
$htmlPath = Join-Path $basePath 'templates\vendedor.html'
$cssPath  = Join-Path $basePath 'src\vendedor.css'
$jsPath   = Join-Path $basePath 'scripts\vendedor.js'

$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8)

# Extrai CSS (entre <style> e </style>)
$cssPattern = '(?s)<style>(.*?)</style>'
$cssMatch = [regex]::Match($html, $cssPattern)
if ($cssMatch.Success) {
    $css = $cssMatch.Groups[1].Value.Trim()
    [System.IO.File]::WriteAllText($cssPath, $css, [System.Text.Encoding]::UTF8)
    $size = (Get-Item $cssPath).Length
    Write-Host "CSS criado: $size bytes"
} else {
    Write-Host "ERRO: bloco <style> nao encontrado"
}

# Extrai JS inline (o script que começa com o comentário do Supabase shim)
$jsPattern = '(?s)<script>\s*(/\* UniRotas.*?)</script>'
$jsMatch = [regex]::Match($html, $jsPattern)
if ($jsMatch.Success) {
    $js = $jsMatch.Groups[1].Value.Trim()
    [System.IO.File]::WriteAllText($jsPath, $js, [System.Text.Encoding]::UTF8)
    $size = (Get-Item $jsPath).Length
    Write-Host "JS criado: $size bytes"
} else {
    Write-Host "ERRO: script inline nao encontrado"
    # Tenta alternativo: pega todos os scripts inline
    $allScripts = [regex]::Matches($html, '(?s)<script>(.+?)</script>')
    Write-Host "Scripts inline encontrados: $($allScripts.Count)"
    foreach ($m in $allScripts) {
        Write-Host "  -> primeiros 100 chars: $($m.Groups[1].Value.Substring(0, [Math]::Min(100, $m.Groups[1].Value.Length)))"
    }
}
