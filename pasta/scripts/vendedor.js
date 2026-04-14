console.log("UniRotas V2.6: Operando 100% no Supabase");

// ========================= VARIÁVEIS GLOBAIS =========================
let isTracking = false, watchId = null;
let lastLat = 0, lastLon = 0, lastTime = 0;
let vMap = null, vDirectionsRenderer = null, vDirectionsService = null;
// ESTADO GLOBAL DO VENDEDOR (Exposto para outros módulos)
window.currentVendorUid = "";
window.currentVendorName = "";
let currentTracking = false;
let updateInterval = null;
let isSignupMode = false, generatedCode = null, pendingUser = null;
let isProcessingAuth = false;
// Getter dinâmico para evitar Race Conditions com o Shim
const getSupa = () => window.supabase || window.sb;
let chatSub = null; // Canal ativo de comunicação em tempo real
let presenceChannel = null; // Controle de presença (App Online/Offline)
let vChatMessages = {}; // Cache local de mensagens para evitar duplicatas
let activeConvo = null; // null = inbox, {id, name} = conversation

// ========================= UTILITÁRIOS DE INTERFACE =========================
// Exibe mensagens temporárias para o usuário
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = msg;
        t.className = 'show ' + type;
        setTimeout(() => { t.className = ''; }, 3500);
    }
}

// Controla a exibição do indicador global de carregamento
function showLoading(show) {
    const loader = document.getElementById('loader-wrapper') || document.getElementById('global-loader');
    if (loader) loader.style.display = show ? 'flex' : 'none';
}

// Abre o menu lateral
function openSidebar() {
    if (typeof m_closeAllActionMenus === 'function') m_closeAllActionMenus();
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
}

// Fecha qualquer modal pelo ID
window.closeModal = function(id) {
    const m = document.getElementById(id);
    if (m) {
        m.classList.remove('show');
        m.classList.add('hidden');
        m.style.display = 'none';
    }
};

// Fecha o menu lateral
function closeSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebar-overlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('show');
}

// Atualiza informações da próxima reunião exibida no dashboard
function updateNextMeetingWidget() {
    const now = new Date();

    const getFirstBizDay = (year, month) => {
        let d = new Date(year, month, 1);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
        return d;
    };

    let nextMeeting = getFirstBizDay(now.getFullYear(), now.getMonth());

    if (now.getDate() > nextMeeting.getDate()) {
        nextMeeting = getFirstBizDay(now.getFullYear(), now.getMonth() + 1);
    }

    const diffDays = Math.ceil((nextMeeting - now) / (1000 * 60 * 60 * 24));
    const dayMonth = nextMeeting.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
    const weekDay = nextMeeting.toLocaleDateString('pt-BR', { weekday: 'long' });

    const dateEl = document.getElementById('next-meeting-date-text');
    const daysEl = document.getElementById('next-meeting-days-count');

    if (dateEl) dateEl.textContent = `Previsão: ${dayMonth} - ${weekDay}`;
    if (daysEl) daysEl.textContent = diffDays === 0 ? "HOJE" : diffDays;
}

document.addEventListener('DOMContentLoaded', updateNextMeetingWidget);

// Controla a navegação entre telas do sistema
function showScreen(id) {
    closeSidebar();

    const views = ['dashboard', 'map', 'chat', 'reuniao', 'historico'];

    views.forEach(v => {
        const el = document.getElementById('view-' + v);
        if (el) {
            el.classList.add('hidden');
            el.style.display = '';
        }
    });

    document.querySelectorAll('.bn-item, .menu-item').forEach(m => m.classList.remove('active'));

    const target = document.getElementById('view-' + id);

    if (target) {
        target.classList.remove('hidden');
        target.style.display = (id === 'map' || id === 'chat') ? 'flex' : '';
    }

    const mi = document.getElementById('menu-' + id);
    const bn = document.getElementById('bn-' + id);

    if (mi) mi.classList.add('active');
    if (bn) bn.classList.add('active');

    if (id === 'map' && vMap) google.maps.event.trigger(vMap, 'resize');
    if (id === 'chat') m_handleMessengerView();
    if (id === 'reuniao' && typeof loadMeetingScreen === 'function') loadMeetingScreen();
    if (id === 'historico' && typeof loadMyMeetingHistory === 'function') loadMyMeetingHistory();

    if (window.lucide) lucide.createIcons();
}

// ========================= CHAT EM TEMPO REAL =========================
async function m_handleMessengerView() {
    const sb = getSupa();
    if (!sb) return;

    if (!activeConvo) m_showInbox();
    else m_showRoom(activeConvo.id, activeConvo.name);
}

function m_showInbox() {
    activeConvo = null;
    document.getElementById('chat-inbox-container').style.display = 'block';
    document.getElementById('chat-room-container').style.display = 'none';
    document.getElementById('btn-chat-back').style.display = 'none';
    document.getElementById('chat-header-title').textContent = 'Mensagens';
    m_renderInbox();
}

function m_renderInbox() {
    const container = document.getElementById('chat-active-convos-list');
    if (!container) return;

    const ms = window.m_state || {};
    console.log("📨 [m_renderInbox] Estado:", ms.role, "Sessão:", !!ms.currentSession);
    let html = '';

    if (ms.currentSession) {
        // Se eu sou PASSAGEIRO (pax), mostra o MOTORISTA
        if (ms.role === 'pax' && ms.currentSession.driver_id) {
            html += m_createInboxItem(ms.currentSession.driver_id, ms.currentSession.driver_name || 'Motorista', 'user');
        }
        // Se eu sou MOTORISTA (driver), mostra os PASSAGEIROS
        else if (ms.role === 'driver' && ms.currentSession.passengers) {
            ms.currentSession.passengers.filter(p => !p.canceled).forEach(p => {
                html += m_createInboxItem(p.uid, p.name, 'user');
            });
        }
    }

    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function m_createInboxItem(id, name, type) {
    return `
        <div class="chat-inbox-item" onclick="m_openConvo('${id}', '${name}')">
            <div class="chat-inbox-avatar"><i data-lucide="${type === 'user' ? 'user' : 'shield'}"></i></div>
            <div class="chat-inbox-info">
                <div class="chat-inbox-name">${name}</div>
                <div class="chat-inbox-last">Inicie uma conversa privada</div>
            </div>
        </div>
    `;
}

function m_openConvo(id, name) {
    console.log("💬 Abrindo conversa:", id, name);
    activeConvo = { id, name };
    m_showRoom(id, name);
}

function m_closeChatConvo() {
    m_showInbox();
}

function m_showRoom(id, name) {
    document.getElementById('chat-inbox-container').style.display = 'none';
    document.getElementById('chat-room-container').style.display = 'flex';
    document.getElementById('btn-chat-back').style.display = 'block';
    document.getElementById('chat-header-title').textContent = name;
    loadChatHistory();
}

async function loadChatHistory() {
    const sb = getSupa();
    if (!window.currentVendorUid || !activeConvo || !sb) {
        console.warn("⚠️ Abortando carga de chat: UID ou Convo ausente.");
        return;
    }

    const messagesDiv = document.getElementById('chat-messages');
    if (messagesDiv) messagesDiv.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Sincronizando...</div>';

    console.log("🔍 Carregando chat para:", activeConvo.id);
    let query = sb.from('mensagens').select('*');

    if (activeConvo.id === 'admin') {
        // Suporte: (Eu -> Suporte [sem receiver]) OU (Admin -> Eu)
        query = query.or(`and(vendor_uid.eq.${window.currentVendorUid},receiver_uid.is.null),and(vendor_uid.eq.admin,receiver_uid.eq.${window.currentVendorUid})`);
    } else {
        // Chat Privado: (Eu -> Ele) OU (Ele -> Eu)
        query = query.or(`and(vendor_uid.eq.${window.currentVendorUid},receiver_uid.eq.${activeConvo.id}),and(vendor_uid.eq.${activeConvo.id},receiver_uid.eq.${window.currentVendorUid})`);
    }

    const { data, error } = await query.order('ts', { ascending: true });

    if (error) {
        console.error("❌ Erro ao carregar chat:", error);
        if (messagesDiv) messagesDiv.innerHTML = '<div style="text-align:center; color:var(--danger); padding:20px;">Falha na conexão.</div>';
        return;
    }

    vChatMessages = {};
    if (data) {
        console.log(`✅ ${data.length} mensagens carregadas.`);
        data.forEach(m => vChatMessages[m.id] = m);
    }
    renderMessages();
    m_subscribeToChat();
}

function renderMessages() {
    const container = document.getElementById('chat-messages');
    if (!container || !activeConvo) return;

    const sorted = Object.values(vChatMessages).sort((a, b) => new Date(a.ts) - new Date(b.ts));

    container.innerHTML = sorted.map(m => {
        // Sou EU se o vendor_uid da mensagem for o meu UID local
        const myUid = String(window.currentVendorUid).toLowerCase();
        const msgUid = String(m.vendor_uid).toLowerCase();
        const isMe = msgUid === myUid;
        return createMessageHtml(m, isMe);
    }).join('');

    container.scrollTop = container.scrollHeight;
    if (window.lucide) lucide.createIcons();
}

// Monta HTML de cada mensagem exibida
function createMessageHtml(m, isMe) {
    const ts = m.ts
        ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    return `
        <div style="max-width:85%; padding:10px 14px; border-radius:16px; margin-bottom:10px; align-self:${isMe ? 'flex-end' : 'flex-start'}; background:${isMe ? 'var(--gold)' : 'var(--surface2)'}; color:${isMe ? 'var(--bg)' : 'var(--text)'}; font-size:0.9rem; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
            ${m.content || m.text || ''}
            <div style="font-size:0.6rem; opacity:0.5; margin-top:4px; text-align:right;">${ts}</div>
        </div>
    `;
}

function m_subscribeToChat() {
    const sb = getSupa();
    if (!sb) return;

    if (chatSub) sb.removeChannel(chatSub);
    chatSub = sb
        .channel(`chat_realtime`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens' }, payload => {
            console.log("📨 Mudança no chat detectada:", payload.eventType, payload);

            if (payload.eventType === 'INSERT') {
                const m = payload.new;

                // Se a mensagem for relevante para a conversa aberta
                const myUid = String(window.currentVendorUid).toLowerCase();
                const activeId = String(activeConvo?.id).toLowerCase();
                const mSender = String(m.vendor_uid).toLowerCase();
                const mReceiver = m.receiver_uid ? String(m.receiver_uid).toLowerCase() : null;

                const isRelevant = (mSender === myUid && mReceiver === activeId) ||
                    (mSender === activeId && mReceiver === myUid);

                // Relevância para Chat Suporte/Admin
                const isAdminRelevant = activeId === 'admin' && (
                    (mSender === myUid && !mReceiver) ||
                    (mReceiver === myUid && (mSender === 'admin' || !mSender))
                );

                if (isRelevant || isAdminRelevant) {
                    if (!vChatMessages[m.id]) {
                        vChatMessages[m.id] = m;
                        renderMessages();
                    }
                }
            } else if (payload.eventType === 'DELETE') {
                // Se o gestor apagar uma mensagem, removemos do cache local
                const oldId = payload.old.id;
                if (vChatMessages[oldId]) {
                    console.log("🗑️ Mensagem removida via Realtime:", oldId);
                    delete vChatMessages[oldId];
                    renderMessages();
                }
            }
        })
        .subscribe();
}

// Seção redundante removida para evitar conflitos de lógica

// Envia mensagem para o suporte
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text || !window.currentVendorUid || !activeConvo) return;

    const tempId = 'temp_' + Date.now();
    const tempMsg = {
        id: tempId,
        vendor_uid: window.currentVendorUid,
        sender: window.currentVendorName || 'Vendedor',
        content: text,
        receiver_uid: activeConvo.id === 'admin' ? null : activeConvo.id,
        ts: new Date().toISOString()
    };

    vChatMessages[tempId] = tempMsg;
    renderMessages();
    input.value = '';

    try {
        const sb = getSupa();
        if (!sb) return;

        const { data, error } = await sb.from('mensagens').insert({
            vendor_uid: tempMsg.vendor_uid,
            sender: tempMsg.sender,
            content: tempMsg.content,
            receiver_uid: tempMsg.receiver_uid,
            ts: tempMsg.ts
        }).select();

        if (error) throw error;
        if (data && data[0]) {
            delete vChatMessages[tempId];
            vChatMessages[data[0].id] = data[0];
            renderMessages();
        }
    } catch (e) {
        console.error("Erro no envio:", e);
        showToast('Erro ao enviar!', 'error');
        delete vChatMessages[tempId];
        renderMessages();
    }
}

// ========================= AUTENTICAÇÃO =========================
// Realiza logout do usuário
async function handleLogout() {
    try {
        if (currentVendorUid) {
            await supabase.from('vendedores')
                .update({ status: 'Offline' })
                .eq('uid', currentVendorUid);
        }

        if (isTracking) stopTracking();

        // Desliga o radar de presença imediatamente
        if (presenceChannel) {
            presenceChannel.unsubscribe();
            const sb = window.supabase || supabase;
            if (sb) sb.removeChannel(presenceChannel);
            presenceChannel = null;
        }

        // Limpa estado de reunião para evitar vazamento entre contas
        if (typeof m_cleanupSession === 'function') m_cleanupSession();
        localStorage.removeItem('unirotas_m_v2_state');

        await supabase.auth.signOut();
    } catch (e) {
        console.error(e);
    }
}

// Alterna entre tela de Login e Cadastro
window.toggleAuthMode = function() {
    console.log("🔄 Toggling Auth Mode. Current signup mode:", isSignupMode);
    isSignupMode = !isSignupMode;
    const fields = document.getElementById('signup-fields');
    const title = document.getElementById('auth-title');
    const btn = document.getElementById('btn-login-action');
    const link = document.getElementById('auth-toggle-link');

    if (isSignupMode) {
        if (fields) fields.classList.remove('hidden');
        if (title) title.textContent = "Solicitar Cadastro";
        if (btn) btn.textContent = "ENVIAR SOLICITAÇÃO";
        if (link) link.textContent = "Já tenho conta? Entrar";
    } else {
        if (fields) fields.classList.add('hidden');
        if (title) title.textContent = "Acesso Restrito";
        if (btn) btn.textContent = "ENTRAR NO SISTEMA";
        if (link) link.textContent = "Solicitar novo cadastro";
    }
};

// Abre modal de recuperação de senha
window.openForgotPasswordModal = function() {
    console.log("🔑 Abrindo modal de esqueci senha...");
    const modal = document.getElementById('forgot-password-modal');
    if (modal) {
        modal.classList.add('show');
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    } else {
        console.error("❌ Modal 'forgot-password-modal' não encontrado no DOM!");
    }
};

// Envia e-mail de recuperação
window.handleSendResetEmail = async function() {
    const email = document.getElementById('reset-email-input')?.value.trim();
    if (!email) return showToast("Informe seu e-mail", "error");

    showLoading(true);
    try {
        const { error } = await getSupa().auth.resetPasswordForEmail(email, {
            redirectTo: window.location.href,
        });
        if (error) throw error;
        showToast("Link enviado! Confira seu e-mail.", "success");
        closeModal('forgot-password-modal');
    } catch (e) {
        showToast("Erro: " + e.message, "error");
    } finally {
        showLoading(false);
    }
};

// Atualiza a senha (usado após clicar no link do e-mail)
window.handleUpdatePassword = async function() {
    const newPass = document.getElementById('new-pass-input')?.value.trim();
    if (!newPass || newPass.length < 6) return showToast("Mínimo 6 caracteres", "error");

    showLoading(true);
    try {
        const { error } = await getSupa().auth.updateUser({ password: newPass });
        if (error) throw error;
        showToast("Senha atualizada com sucesso!", "success");
        closeModal('new-password-modal');
    } catch (e) {
        showToast("Erro ao atualizar: " + e.message, "error");
    } finally {
        showLoading(false);
    }
};

// Processa login ou cadastro do usuário
async function handleAuth() {
    console.log("🚀 handleAuth iniciada. Modo Signup:", isSignupMode);
    const rawUsername = document.getElementById('user-cpf-input')?.value.trim();
    const password = document.getElementById('user-pass-input')?.value.trim();

    if (!rawUsername || !password) {
        return showToast('Preencha os campos', 'error');
    }

    showLoading(true);

    let email = rawUsername.includes('@')
        ? rawUsername
        : `${rawUsername.replace(/\D/g, '')}@unirotas.com`;

    try {
        if (isSignupMode) {
            // LÓGICA DE CADASTRO (SIGN UP)
            const name = document.getElementById('reg-name')?.value.trim();
            const city = document.getElementById('addr-cidade')?.value.trim();
            if (!name) throw new Error("Informe seu nome completo");

            const { data, error } = await getSupa().auth.signUp({ 
                email, 
                password,
                options: { data: { full_name: name, city: city } }
            });

            if (error) throw error;

            // Cria entrada na tabela 'usuarios'
            await getSupa().from('usuarios').insert({
                uid: data.user.id,
                name: name,
                email: email,
                role: 'pax'
            });

            showToast("Solicitação enviada! Aguarde aprovação.", "success");
            toggleAuthMode();
        } else {
            // LÓGICA DE LOGIN (SIGN IN)
            const { data, error } = await getSupa().auth.signInWithPassword({ email, password });
            if (error) throw error;
            enterApp(data.user.id);
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

// ========================= RASTREAMENTO GPS =========================
// Alterna estado de rastreamento
function toggleTracking() {
    if (!isTracking) startTracking();
    else stopTracking();
    window.isTracking = isTracking;
}

// Inicia coleta contínua de localização
function startTracking() {
    if (!navigator.geolocation) {
        return showToast('Sem GPS', 'error');
    }

    isTracking = true;
    window.isTracking = true;
    localStorage.setItem('unirotas_tracking_active', 'true');

    document.getElementById('btn-tracking').textContent = 'PARAR RASTREAMENTO';
    document.getElementById('gps-status-card').classList.add('active-gps');

    watchId = navigator.geolocation.watchPosition(async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        window.lastLat = lat;
        window.lastLon = lon;

        document.getElementById('coords-text').textContent = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;

        if (window.currentVendorUid) {
            try {
                // ENVIO LIMPO E PADRONIZADO (Evita Erro 400)
                const { error } = await getSupa().from('vendedores').upsert({
                    uid: window.currentVendorUid,
                    name: window.currentVendorName,
                    lat: lat,
                    lon: lon,
                    last_active: new Date().toISOString()
                }, { onConflict: 'uid' });

                if (error) {
                    console.error("❌ [GPS] Erro:", error.message);
                } else {
                    console.log("✅ [GPS] Sincronizado com Sucesso!");
                }
            } catch (e) {
                console.error("🚨 [GPS] Falha na execução do Upsert:", e);
            }
        }

        if (typeof recordGpsPoint === 'function') {
            recordGpsPoint(lat, lon);
        }

    }, () => showToast('Erro GPS', 'error'), {
        enableHighAccuracy: true
    });
}

// Interrompe o rastreamento de localização
function stopTracking() {
    isTracking = false;
    window.isTracking = false;
    window.lastLat = 0;
    window.lastLon = 0;

    if (watchId) navigator.geolocation.clearWatch(watchId);

    document.getElementById('btn-tracking').textContent = 'INICIAR RASTREAMENTO';
    document.getElementById('gps-status-card').classList.remove('active-gps');
}

// ========================= REUNIÕES =========================
// Carrega tela inicial de reunião
function loadMeetingScreen() {
    if (typeof m_init === 'function') {
        m_init();
    }
}

// Carrega histórico de reuniões do usuário
async function loadMyMeetingHistory() {
    const container = document.getElementById('meeting-history-list');

    if (!container || !currentVendorUid) return;

    container.innerHTML = '<p style="padding:20px; opacity:0.5; text-align:center;">Carregando histórico...</p>';

    try {
        const { data: list, error } = await supabase
            .from('meeting_sessions')
            .select('*')
            .eq('driver_id', currentVendorUid)
            .order('date', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!list || !list.length) {
            container.innerHTML = '<p style="padding:20px; opacity:0.5; text-align:center;">Nenhuma viagem registrada.</p>';
            return;
        }

        container.innerHTML = list.map(s => `
            <div style="background:var(--surface2); padding:15px; border-radius:18px; margin-bottom:12px; border:1px solid var(--border);">
                <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                    <strong style="font-size:0.9rem;">${s.date.split('-').reverse().join('/')}</strong>
                    <span style="color:var(--gold); font-size:0.75rem; font-weight:700;">${(s.total_km || 0).toFixed(1)} km</span>
                </div>
                <div style="font-size:0.75rem; opacity:0.7;">${s.meeting_location_name || 'Reunião'}</div>
            </div>
        `).join('');

    } catch {
        container.innerHTML = '<p style="color:#ff4757; text-align:center;">Erro ao carregar.</p>';
    }
}

// ========================= INICIALIZAÇÃO DO APP =========================
// Configura o ambiente após autenticação
async function enterApp(uid) {
    window.currentVendorUid = uid;
    console.log("🚀 [enterApp] Definido UID:", window.currentVendorUid);

    document.getElementById('screen-login').style.display = 'none';
    document.getElementById('screen-app').style.display = 'flex';
    document.querySelector('.bottom-nav').style.display = 'flex';

    try {
        console.log("👤 [enterApp] Buscando perfil para:", uid);
        const { data: profile } = await getSupa()
            .from('usuarios')
            .select('*')
            .eq('uid', uid)
            .maybeSingle();

        if (profile) {
            currentVendorName = profile.name || 'Vendedor';

            window._currentUserId = uid;
            window._userProfile = profile;

            const headerNameEl = document.getElementById('header-first-name');
            const sidebarNameEl = document.getElementById('sidebar-user-name');
            const sidebarCpfEl = document.getElementById('sidebar-user-cpf');

            if (headerNameEl) headerNameEl.textContent = currentVendorName.split(' ')[0];
            if (sidebarNameEl) sidebarNameEl.textContent = currentVendorName;
            if (sidebarCpfEl) sidebarCpfEl.textContent = `CPF: ${profile.cpf || 'Ativo'}`;

            getSupa().from('vendedores').upsert({
                uid,
                status: 'Online',
                name: currentVendorName,
                lastActive: new Date().toISOString()
            });
        }

        // Função para sinalizar atividade imediata (interação)
        async function trackActivity() {
            if (presenceChannel && currentVendorUid) {
                await presenceChannel.track({
                    user_id: currentVendorUid,
                    online_at: new Date().toISOString(),
                    action: 'interaction'
                });
            }
        }

        // Inicia o sistema de Presença do Aplicativo (Online/Offline)
        function initPresence() {
            if (!currentVendorUid) return;

            // Tenta usar a instância global para garantir compatibilidade com Presence
            const sb = window.supabase || supabase;
            if (!sb) return;

            // --- NOVO: Se já existe um canal ativo (troca de conta), desinscreve e remove ---
            if (presenceChannel) {
                console.log("[Presence] Desconectando usuário anterior...");
                presenceChannel.unsubscribe();
                sb.removeChannel(presenceChannel);
            }

            presenceChannel = sb.channel('online-users');

            presenceChannel
                .subscribe(async (status) => {
                    console.log(`[Presence] Status da Conexão: ${status}`);
                    if (status === 'SUBSCRIBED') {
                        console.log("[Presence] App transmitindo sinal de vida...");
                        await trackActivity();
                    } else if (status === 'CHANNEL_ERROR') {
                        console.error("[Presence] Erro ao abrir canal de radar!");
                    }
                });

            // Detecta qualquer clique ou interação
            document.addEventListener('click', trackActivity);
            // Também detecta toques em dispositivos móveis
            document.addEventListener('touchstart', trackActivity);
        }

        initPresence();
        initVendedorMap();
        showScreen('dashboard');

        // AUTO-RESUME: Se o GPS estava ativo antes de atualizar, retoma!
        const savedTracking = localStorage.getItem('unirotas_tracking_active');
        if (savedTracking === 'true') {
            console.log("📡 Retomando Rastreamento GPS Automático...");
            startTracking();
        }

        // NOVO: Chama inicialização da lógica de reunião AQUI, 
        // agora que temos o currentVendorUid garantido.
        if (typeof m_init === 'function') {
            console.log("🏁 Inicializando Lógica de Reunião...");
            await m_init();
        }
    } catch (e) {
        console.error(e);
    }
}

// Inicializa o mapa do vendedor
function initVendedorMap() {
    const el = document.getElementById('map-canvas');

    if (!el || typeof google === 'undefined') return;

    vMap = new google.maps.Map(el, {
        center: { lat: -20.31, lng: -40.31 },
        zoom: 15,
        styles: [{ stylers: [{ invert_lightness: true }] }]
    });
}

// ========================= SISTEMA DE CONFIRMAÇÃO SOBERANO =========================
window.m_confirmCallback = null;

window.m_openConfirmModal = function(title, sub, callback) {
    console.log("📢 Abrindo Modal de Confirmação:", title);
    const modal = document.getElementById('notification-modal');
    const tEl = document.getElementById('notif-title');
    const sEl = document.getElementById('notif-sub');
    if(!modal || !tEl || !sEl) {
        if(confirm(sub)) callback();
        return;
    }

    tEl.textContent = title;
    sEl.textContent = sub;
    window.m_confirmCallback = callback;
    modal.classList.add('show');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
};

window.handleNotifAccept = function() {
    const modal = document.getElementById('notification-modal');
    if(modal) modal.classList.remove('show');
    if(window.m_confirmCallback) {
        window.m_confirmCallback();
        window.m_confirmCallback = null;
    }
};

window.handleNotifRefuse = function() {
    const modal = document.getElementById('notification-modal');
    if(modal) modal.classList.remove('show');
    window.m_confirmCallback = null;
};

// ========================= EVENTOS INICIAIS =========================
document.addEventListener("DOMContentLoaded", async () => {
    if (window.lucide) lucide.createIcons();

    setTimeout(async () => {
        const sb = getSupa();
        if (!sb) {
            console.error("❌ Supabase não encontrado após espera!");
            return;
        }

        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        console.log("🔑 [Auth] Sessão recuperada:", !!session);

        if (sessionError) console.error("🔑 [Auth] Erro ao buscar sessão:", sessionError.message);

        const splash = document.getElementById('auth-splash');

        if (session) {
            console.log("🚀 [Auth] Iniciando App para:", session.user.id);
            await enterApp(session.user.id);
            if (splash) {
                console.log("✨ [Auth] Removendo Splash...");
                splash.style.display = 'none';
            }
        } else {
            console.log("🚪 [Auth] Nenhuma sessão ativa. Exibindo Login.");
            if (splash) splash.style.display = 'none';
            document.getElementById('screen-login').style.display = 'flex';
        }

        sb.auth.onAuthStateChange((event, session) => {
            const isAppActive = document.getElementById('screen-app').style.display === 'flex';
            if (event === 'SIGNED_OUT' && isAppActive) {
                window.location.reload();
            }
        });
    }, 500); // Pequeno fôlego para o Shim inicializar
});

// ========================= HELPER DE INTERFACE DO MOTORISTA =========================
// Gerencia a troca visual entre os cards de Carro e Moto
function updateVehicleUi(type) {
    if (typeof driverVehicleType !== 'undefined') window.driverVehicleType = type;

    // Lista de IDs dos labels
    const options = ['carro', 'moto'];

    options.forEach(opt => {
        const el = document.getElementById(`label-vehicle-${opt}`);
        if (!el) return;

        if (opt === type) {
            // Se for carro, usa DOURADO. Se for moto, usa BRANCO.
            const accentColor = (opt === 'carro') ? '#bf9a56' : '#ffffff';
            const accentBg = (opt === 'carro') ? 'rgba(191, 154, 86, 0.1)' : 'rgba(255, 255, 255, 0.1)';

            el.style.border = `2.5px solid ${accentColor}`;
            el.style.background = accentBg;
            el.style.transform = "scale(1.02)";
        } else {
            el.style.border = "1px solid rgba(255, 255, 255, 0.05)";
            el.style.background = "rgba(0, 0, 0, 0.2)";
            el.style.transform = "scale(1)";
        }
    });
}
