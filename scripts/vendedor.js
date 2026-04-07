console.log("UniRotas V2.6: Operando 100% no Supabase");

// ========================= VARIÁVEIS GLOBAIS =========================
let isTracking = false, watchId = null;
let lastLat = 0, lastLon = 0, lastTime = 0;
let vMap = null, vDirectionsRenderer = null, vDirectionsService = null;
let currentVendorName = '', currentVendorUid = '';
let isSignupMode = false, generatedCode = null, pendingUser = null;
let isProcessingAuth = false;
let chatSub = null; // Canal ativo de comunicação em tempo real

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
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
}

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
    if (id === 'chat') handleChatView();
    if (id === 'reuniao' && typeof loadMeetingScreen === 'function') loadMeetingScreen();
    if (id === 'historico' && typeof loadMyMeetingHistory === 'function') loadMyMeetingHistory();

    if (window.lucide) lucide.createIcons();
}

// ========================= CHAT EM TEMPO REAL =========================
// Inicializa e mantém sincronização de mensagens via Supabase
async function handleChatView() {
    const container = document.getElementById('chat-messages');
    if (!container || !currentVendorUid) return;

    const { data: msgs } = await supabase
        .from('mensagens')
        .select('*')
        .eq('vendor_uid', currentVendorUid)
        .order('ts', { ascending: true });

    renderMessages(msgs || []);

    if (chatSub) supabase.removeChannel(chatSub);

    chatSub = supabase
        .channel(`chat_${currentVendorUid}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'mensagens',
            filter: `vendor_uid=eq.${currentVendorUid}`
        }, payload => {
            const m = payload.new;
            const isMe = m.sender !== 'admin';

            container.innerHTML += createMessageHtml(m, isMe);
            container.scrollTop = container.scrollHeight;

            if (!isMe) document.getElementById('badge-support')?.classList.add('active');
        })
        .subscribe();
}

// Renderiza lista de mensagens
function renderMessages(msgs) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = msgs.map(m => createMessageHtml(m, m.sender !== 'admin')).join('');
    container.scrollTop = container.scrollHeight;
}

// Monta HTML de cada mensagem exibida
function createMessageHtml(m, isMe) {
    const ts = m.ts
        ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    return `
        <div style="max-width:85%; padding:10px 14px; border-radius:16px; margin-bottom:10px; align-self:${isMe ? 'flex-end' : 'flex-start'}; background:${isMe ? 'var(--gold)' : 'var(--surface2)'}; color:${isMe ? 'var(--bg)' : 'var(--text)'}; font-size:0.9rem; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
            ${m.content || m.text}
            <div style="font-size:0.6rem; opacity:0.5; margin-top:4px; text-align:right;">${ts}</div>
        </div>
    `;
}

// Envia mensagem para o suporte
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if (!text || !currentVendorUid) return;

    try {
        await supabase.from('mensagens').insert({
            vendor_uid: currentVendorUid,
            sender: currentVendorName,
            content: text,
            ts: new Date().toISOString()
        });

        input.value = '';
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
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

        await supabase.auth.signOut();
    } catch (e) {
        console.error(e);
    }
}

// Processa login do usuário
async function handleAuth() {
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
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) throw error;

        enterApp(data.user.id);
    } catch (e) {
        showToast('Acesso negado: ' + e.message, 'error');
    } finally {
        showLoading(false);
    }
}

// ========================= RASTREAMENTO GPS =========================
// Alterna estado de rastreamento
function toggleTracking() {
    if (!isTracking) startTracking();
    else stopTracking();
}

// Inicia coleta contínua de localização
function startTracking() {
    if (!navigator.geolocation) {
        return showToast('Sem GPS', 'error');
    }

    isTracking = true;

    document.getElementById('btn-tracking').textContent = 'PARAR RASTREAMENTO';
    document.getElementById('gps-status-card').classList.add('active-gps');

    watchId = navigator.geolocation.watchPosition(pos => {
        const { latitude: lat, longitude: lon } = pos.coords;

        document.getElementById('coords-text').textContent = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;

        if (currentVendorUid) {
            supabase.from('vendedores')
                .update({ lat, lon, lastActive: new Date().toISOString() })
                .eq('uid', currentVendorUid);
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

    if (watchId) navigator.geolocation.clearWatch(watchId);

    document.getElementById('btn-tracking').textContent = 'INICIAR RASTREAMENTO';
    document.getElementById('gps-status-card').classList.remove('active-gps');
}

// ========================= REUNIÕES =========================
// Carrega tela inicial de reunião
function loadMeetingScreen() {
    if (typeof showMeetingView === 'function') {
        showMeetingView('meeting-role-select');
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
    currentVendorUid = uid;

    document.getElementById('screen-login').style.display = 'none';
    document.getElementById('screen-app').style.display = 'flex';
    document.querySelector('.bottom-nav').style.display = 'flex';

    try {
        const { data: profile } = await supabase
            .from('usuarios')
            .select('*')
            .eq('uid', uid)
            .maybeSingle();

        if (profile) {
            currentVendorName = profile.name || 'Vendedor';

            window._currentUserId = uid;
            window._userProfile = profile;

            document.getElementById('header-first-name').textContent = currentVendorName.split(' ')[0];
            document.getElementById('sidebar-user-name').textContent = currentVendorName;
            document.getElementById('sidebar-user-cpf').textContent = `CPF: ${profile.cpf || 'Ativo'}`;

            supabase.from('vendedores').upsert({
                uid,
                status: 'Online',
                name: currentVendorName,
                lastActive: new Date().toISOString()
            });
        }

        initVendedorMap();
        showScreen('dashboard');
        startTracking();

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

// ========================= EVENTOS INICIAIS =========================
document.addEventListener("DOMContentLoaded", async () => {
    if (window.lucide) lucide.createIcons();

    const { data: { session } } = await supabase.auth.getSession();

    const splash = document.getElementById('auth-splash');
    if (splash) splash.style.display = 'none';

    if (session) enterApp(session.user.id);
    else document.getElementById('screen-login').style.display = 'flex';

    supabase.auth.onAuthStateChange((event, session) => {
        const isAppActive = document.getElementById('screen-app').style.display === 'flex';

        console.log("[UniRotas] Evento de autenticação:", event, "App ativo:", isAppActive);

        if (event === 'SIGNED_OUT' && isAppActive) {
            window.location.reload();
        }
    });
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
