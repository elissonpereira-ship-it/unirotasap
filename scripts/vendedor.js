// ── emailjs init ────────────────────────────────────────────────────────
if (typeof emailjs !== 'undefined') {
    emailjs.init({ publicKey: "OV-1JMg752txxJaSr" });
}

// ── GLOBALS ──────────────────────────────────────────────────────────────
let isTracking = false, watchId = null;
let lastLat = 0, lastLon = 0, lastTime = 0;
let vMap = null, vDirectionsRenderer = null, vDirectionsService = null;
let currentVendorName = '', currentVendorUid = '';
let isSignupMode = false, generatedCode = null, pendingUser = null;
let isProcessingAuth = false, chatListener = null;

// ── UI HELPERS ───────────────────────────────────────────────────────────
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = msg;
        t.className = 'show ' + type;
        setTimeout(() => { t.className = ''; }, 3500);
    }
}

function showLoading(show) {
    const loader = document.getElementById('loader-wrapper') || document.getElementById('global-loader');
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
    }
}

function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
}
function closeSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebar-overlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('show');
}

function showScreen(id) {
    closeSidebar();
    const views = ['dashboard', 'map', 'chat', 'reuniao', 'historico'];
    views.forEach(v => {
        const el = document.getElementById('view-' + v);
        if (el) { el.classList.add('hidden'); el.style.display = ''; }
    });
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    const target = document.getElementById('view-' + id);
    if (target) {
        target.classList.remove('hidden');
        if (id === 'map' || id === 'chat') {
            target.style.display = 'flex';
        } else {
            target.style.display = '';
        }
    }
    const mi = document.getElementById('menu-' + id);
    if (mi) mi.classList.add('active');
    if (id === 'map' && vMap) { google.maps.event.trigger(vMap, 'resize'); }
    if (id === 'chat') loadChat();
    if (id === 'reuniao' && typeof loadMeetingScreen === 'function') loadMeetingScreen();
    if (id === 'historico' && typeof loadMyMeetingHistory === 'function') loadMyMeetingHistory();
    if (window.lucide) lucide.createIcons();
}

// ── SUPPORT CHAT ─────────────────────────────────────────────────────────
function loadChat() {
    if (!currentVendorUid) return;
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '<div class="empty-state">Carregando mensagens...</div>';

    if (chatListener) supabase.database().ref(`mensagens/${currentVendorUid}`).off('value', chatListener);
    chatListener = supabase.database().ref(`mensagens/${currentVendorUid}`).on('value', snap => {
        const msgs = Object.values(snap.val() || {});
        container.innerHTML = msgs.map(m => {
            const isMe = m.sender !== 'admin';
            return `
                <div style="max-width:85%; padding:10px 14px; border-radius:16px; margin-bottom:10px; align-self:${isMe ? 'flex-end' : 'flex-start'}; background:${isMe ? 'var(--gold)' : 'var(--surface2)'}; color:${isMe ? 'var(--bg)' : 'var(--text)'}; font-size:0.9rem; position:relative; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    ${m.text}
                    <div style="font-size:0.6rem; opacity:0.5; margin-top:4px; text-align:right;">${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            `;
        }).join('');
        container.scrollTop = container.scrollHeight;
        const badge = document.getElementById('badge-support');
        if (badge) badge.classList.remove('active');
    });
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !currentVendorUid) return;
    try {
        await supabase.database().ref(`mensagens/${currentVendorUid}`).push({
            sender: currentVendorName, text, timestamp: Date.now(), read: false
        });
        input.value = '';
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

// ── AUTH HANDLERS ────────────────────────────────────────────────────────
function toggleAuthMode() {
    isSignupMode = !isSignupMode;
    const card = document.querySelector('.login-card');
    const toggleLink = document.getElementById('auth-toggle-link');

    document.getElementById('auth-title').textContent = isSignupMode ? 'Novo Cadastro' : 'Acesso Restrito';
    document.getElementById('signup-fields').classList.toggle('hidden', !isSignupMode);
    document.getElementById('btn-login-action').textContent = isSignupMode ? 'EFETUAR CADASTRO' : 'ENTRAR NO SISTEMA';

    if (toggleLink) {
        toggleLink.textContent = isSignupMode ? 'Já tenho cadastro (Login)' : 'Solicitar novo cadastro';
    }

    const loginTop = document.querySelector('.login-top');
    if (loginTop) {
        loginTop.style.display = isSignupMode ? 'none' : 'flex';
        if (card) card.classList.toggle('signup-mode', isSignupMode);
    }
    if (isSignupMode) setTimeout(initAddressAutocomplete, 100);
}

let addressAutocomplete;
function initAddressAutocomplete() {
    const input = document.getElementById('addr-rua');
    if (!input || addressAutocomplete) return;
    addressAutocomplete = new google.maps.places.Autocomplete(input, {
        types: ['address'], componentRestrictions: { country: 'br' }, fields: ['address_components', 'geometry']
    });
    addressAutocomplete.addListener('place_changed', () => {
        const place = addressAutocomplete.getPlace();
        if (!place.address_components) return;
        let street = '', number = '', neighborhood = '', city = '', state = '', cep = '';
        for (const component of place.address_components) {
            const types = component.types;
            if (types.includes('route')) street = component.long_name;
            if (types.includes('street_number')) number = component.long_name;
            if (types.includes('sublocality_level_1')) neighborhood = component.long_name;
            if (types.includes('locality')) city = component.long_name;
            if (types.includes('administrative_area_level_1')) state = component.short_name;
            if (types.includes('postal_code')) cep = component.long_name;
        }
        if (street) input.value = street;
        document.getElementById('addr-num').value = number;
        document.getElementById('addr-bairro').value = neighborhood;
        document.getElementById('addr-cidade').value = city;
        document.getElementById('addr-cep').value = cep;
    });
}

async function handleAuth() {
    if (isProcessingAuth) return;
    const cpf = document.getElementById('user-cpf-input').value.replace(/\D/g, '');
    const pass = document.getElementById('user-pass-input').value;
    const btn = document.getElementById('btn-login-action');
    if (cpf.length < 11 || pass.length < 6) { showToast('CPF ou senha inválidos.', 'error'); return; }
    const emailFirebase = `${cpf}@unirotas.app`;
    isProcessingAuth = true;
    const orig = btn.textContent; btn.textContent = 'Aguarde...'; btn.disabled = true;
    try {
        const { user } = await firebase.auth().signInWithEmailAndPassword(emailFirebase, pass);
        currentVendorUid = user.uid;
        enterApp();
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    } finally {
        isProcessingAuth = false;
        btn.textContent = orig; btn.disabled = false;
    }
}

async function enterApp() {
    const user = firebase.auth().currentUser;
    if (!user) return;
    currentVendorUid = user.uid;
    const snap = await supabase.database().ref('vendedores/' + currentVendorUid).once('value');
    if (snap.val()) currentVendorName = snap.val().name;
    updateHeaderName(currentVendorName || 'Vendedor');
    updateGreeting();
    document.getElementById('screen-login').style.display = 'none';
    document.getElementById('screen-app').style.display = 'flex';
    document.getElementById('auth-splash').style.display = 'none';
    startTracking();
    listenForMeetingNotifications();
}

function listenForMeetingNotifications() {
    if (!currentVendorUid) return;
    supabase.database().ref(`meeting/notifications/${currentVendorUid}`).on('value', snap => {
        const notif = snap.val();
        if (notif && !notif.handled) {
            showMeetingNotification(notif);
        }
    });
}

function showMeetingNotification(notif) {
    const container = document.getElementById('floating-notification-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'floating-notif-card';
    div.innerHTML = `<div class="f-notif-body"><strong>📢 Mensagem do Gestor</strong><p>${notif.text || 'Nova atualização de reunião.'}</p></div>`;
    div.onclick = () => { div.remove(); showScreen('reuniao'); };
    container.appendChild(div);
    setTimeout(() => div.remove(), 10000);
}

async function handleLogout() {
    await firebase.auth().signOut();
    location.reload();
}

firebase.auth().onAuthStateChanged(user => {
    if (user) enterApp();
    else {
        document.getElementById('screen-login').style.display = 'flex';
        document.getElementById('auth-splash').style.display = 'none';
    }
});

// ── GPS TRACKING ─────────────────────────────────────────────────────────
function startTracking() {
    if (!navigator.geolocation) return showToast('Sem GPS', 'error');
    isTracking = true;
    document.getElementById('btn-tracking').textContent = 'PARAR RASTREAMENTO';
    document.getElementById('status-ring').classList.add('active');
    document.getElementById('status-text').textContent = 'GPS Ativo';
    watchId = navigator.geolocation.watchPosition(pos => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        lastLat = lat; lastLon = lon;
        const cText = document.getElementById('coords-text'), aWarn = document.getElementById('accuracy-warning');
        if (cText) cText.textContent = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        if (aWarn) aWarn.classList.toggle('hidden', accuracy < 50);
        if (currentVendorUid) supabase.database().ref('vendedores/' + currentVendorUid).update({ lat, lon, lastActive: Date.now() });
        updateQuickCards();
    }, e => showToast('Erro GPS: ' + e.message, 'error'), { enableHighAccuracy: true });
}

function stopTracking() {
    isTracking = false;
    if (watchId) navigator.geolocation.clearWatch(watchId);
    document.getElementById('btn-tracking').textContent = 'INICIAR RASTREAMENTO';
    document.getElementById('status-ring').classList.remove('active');
    document.getElementById('status-text').textContent = 'Expediente Inativo';
}

function updateHeaderName(name) {
    const el = document.getElementById('header-first-name');
    if (el) el.textContent = name;
}
function updateGreeting() {
    const el = document.getElementById('header-greeting');
    if (!el) return;
    const hr = new Date().getHours();
    let g = 'Boa noite 🌙';
    if (hr < 12) g = 'Bom dia ☀️'; else if (hr < 18) g = 'Boa tarde ⛅';
    el.textContent = g;
}
function updateQuickCards() {
    const el = document.getElementById('qcard-gps');
    if (el) el.textContent = isTracking ? 'ON' : 'OFF';
}
