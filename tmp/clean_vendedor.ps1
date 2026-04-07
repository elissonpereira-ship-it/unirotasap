$basePath = 'c:\Users\10642\Desktop\Projeto Principal\App e Programa UniRotas'
$htmlPath = Join-Path $basePath 'templates\vendedor.html'

# Lendo o HTML original para preservar os modais e estrutura do body
$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8)

# Extrai o bloco BODY (preservando tudo entre <body> e <nav> final ou </script>)
# Na verdade, é melhor reconstruir o head e manter o corpo até a navegação.
$bodyMatch = [regex]::Match($html, '(?s)<body>(.*?)<nav id="bottom-nav"')
if (!$bodyMatch.Success) {
    # Tenta um match mais genérico se o ID mudou
    $bodyMatch = [regex]::Match($html, '(?s)<body>(.*?)<!-- TOAST -->')
}

$bodyContent = $bodyMatch.Groups[1].Value.Trim()

# Novos modais de senha que estavam no final do arquivo
$modals = @"
    <!-- MODAL ESQUECI MINHA SENHA -->
    <div id="forgot-password-modal" class="modal-overlay" style="display:none; align-items:center;">
        <div class="modal-content glass-panel" style="max-width:400px; padding:30px;">
            <h3 style="margin-bottom:15px; color:var(--gold);">Recuperar Senha</h3>
            <p style="font-size:0.85rem; color:var(--muted); margin-bottom:20px;">
                Informe o seu e-mail cadastrado. Enviaremos um link seguro para você criar uma nova senha.
            </p>
            <div class="input-group">
                <input type="email" id="reset-email-input" class="form-input" placeholder="seu@email.com">
            </div>
            <div class="modal-footer" style="padding-top:20px;">
                <button class="btn btn-secondary" onclick="closeModal('forgot-password-modal')">Voltar</button>
                <button class="btn btn-primary" onclick="handleSendResetEmail()" id="btn-send-reset">Enviar Link</button>
            </div>
        </div>
    </div>

    <!-- MODAL NOVA SENHA (CALLBACK) -->
    <div id="new-password-modal" class="modal-overlay" style="display:none; align-items:center;">
        <div class="modal-content glass-panel" style="max-width:400px; padding:30px;">
            <h3 style="margin-bottom:15px; color:var(--success);">Nova Senha</h3>
            <p style="font-size:0.85rem; color:var(--muted); margin-bottom:20px;">
                Digite e confirme a sua nova senha para acessar o sistema.
            </p>
            <div class="input-group">
                <input type="password" id="new-pass-input" class="form-input" placeholder="Mínimo 6 caracteres">
            </div>
            <div class="modal-footer" style="padding-top:20px;">
                <button class="btn btn-primary" style="width:100%" onclick="handleUpdatePassword()" id="btn-update-pass">Salvar Nova Senha</button>
            </div>
        </div>
    </div>
"@

# Novo HTML Limpo
$newHtml = @"
<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>UniRotas - App Vendedor</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../src/vendedor.css">
</head>
<body>
    $bodyContent

    <nav id="bottom-nav" class="bottom-nav">
        <button class="bn-item active" id="menu-dashboard" onclick="showScreen('dashboard')">
            <i data-lucide="home"></i>
            <span>Início</span>
        </button>
        <button class="bn-item" id="menu-map" onclick="showScreen('map')">
            <i data-lucide="map"></i>
            <span>Mapa</span>
        </button>
        <button class="bn-item" id="menu-chat" onclick="showScreen('chat')">
            <i data-lucide="message-square"></i>
            <span id="badge-support" class="notif-badge"></span>
            <span>Suporte</span>
        </button>
        <button class="bn-item" id="menu-reuniao" onclick="showScreen('reuniao')">
            <i data-lucide="users"></i>
            <span>Reunião</span>
        </button>
        <button class="bn-item" id="menu-historico" onclick="showScreen('historico')">
            <i data-lucide="history"></i>
            <span>Histórico</span>
        </button>
        <button class="bn-item" id="bn-sidebar" onclick="openSidebar()">
            <i data-lucide="menu"></i>
            <span>Menu</span>
        </button>
    </nav>

    <div id="toast"></div>

    $modals

    <!-- SCRIPTS EXTERNOS -->
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyAO46S-g-tbXDg9aljUNajplLQV_3i7c9Q&libraries=places,geometry"></script>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>

    <!-- SCRIPTS MODULARES -->
    <script src="../scripts/vendedor.js"></script>
    <script src="../Logica/meeting-logic.js"></script>

</body>
</html>
"@

[System.IO.File]::WriteAllText($htmlPath, $newHtml, [System.Text.Encoding]::UTF8)
Write-Host "Vendedor.html atualizado com sucesso!"
