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
    document.querySelectorAll('.bn-item').forEach(m => m.classList.remove('active'));
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
    
    const bn = document.getElementById('bn-' + id);
    if (bn) bn.classList.add('active');

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
        if (isSignupMode) {
            const name = document.getElementById('user-name-input').value.trim();
            const email = document.getElementById('user-email-input').value.trim();
            const rua = document.getElementById('addr-rua').value.trim();
            const num = document.getElementById('addr-num').value.trim();
            const bairro = document.getElementById('addr-bairro').value.trim();

            const cidade = document.getElementById('addr-cidade').value.trim();
            const cep = document.getElementById('addr-cep').value.trim();
            if (!name || !email || !rua || !cidade) { showToast('Preencha os campos.', 'error'); return; }
            const res = await firebase.auth().createUserWithEmailAndPassword(emailFirebase, pass);
            const uid = res.user.uid;
            await firebase.database().ref('usuarios/' + uid).set({
                name, cpf, email, uid, address: { rua, numero: num, bairro, cidade, cep }, registeredAt: Date.now()
            });
            showToast('Sucesso!', 'success');
            enterApp(uid);
        } else {
            const res = await firebase.auth().signInWithEmailAndPassword(emailFirebase, pass);
            enterApp(res.user.uid);
        }
    } catch (e) {
        showToast('Falha: ' + (e.message || 'Erro de rede'), 'error');
    } finally {
        isProcessingAuth = false; btn.textContent = orig; btn.disabled = false;
    }
}

async function handleLogout() {
    try {
        const user = firebase.auth().currentUser;
        if (user) {
            await firebase.database().ref('vendedores/' + user.uid).update({ status: 'Offline', lastActive: Date.now() });
            try { await firebase.database().ref(`meeting/participants/${user.uid}`).remove(); } catch(_) {}
        }
        if (isTracking) stopTracking();
        await firebase.auth().signOut();
    } catch (e) {
        console.error(e);
    } finally {
        window.location.reload();
    }
}

function openForgotPasswordModal() {
    document.getElementById('forgot-password-modal').style.display = 'flex';
}
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

async function handleSendResetEmail() {
    const email = document.getElementById('reset-email-input').value.trim();
    if (!email) { showToast('Informe o seu e-mail.', 'error'); return; }
    try {
        await firebase.auth().sendPasswordResetEmail(email, { redirectTo: window.location.href });
        showToast('Link enviado!', 'success');
        closeModal('forgot-password-modal');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function handleUpdatePassword() {
    const newPass = document.getElementById('new-pass-input').value;
    if (newPass.length < 6) return showToast('Min. 6 caracteres', 'error');
    try {
        await firebase.auth().updateUser({ password: newPass });
        showToast('Senha atualizada!', 'success');
        closeModal('new-password-modal');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── GPS TRACKING ─────────────────────────────────────────────────────────
function toggleTracking() { if (isTracking) stopTracking(); else startTracking(); }
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
        if (currentVendorUid) firebase.database().ref('vendedores/' + currentVendorUid).update({ lat, lon, lastActive: Date.now() });
        updateQuickCards();
        if (typeof updateUniversalPresence === 'function') updateUniversalPresence();
    }, e => showToast('Erro GPS: ' + e.message, 'error'), { enableHighAccuracy: true });
}
function stopTracking() {
    isTracking = false;
    if (watchId) navigator.geolocation.clearWatch(watchId);
    document.getElementById('btn-tracking').textContent = 'INICIAR RASTREAMENTO';
    document.getElementById('status-ring').classList.remove('active');
    document.getElementById('status-text').textContent = 'Expediente Inativo';
    updateQuickCards();
}

// ── HEADER & CARDS ───────────────────────────────────────────────────────
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
    const el = document.getElementById('status-summary');
    if (el) el.textContent = isTracking ? 'Operando no momento' : 'Aguardando início';
}

function logAudit(action) {
    console.log(`[Audit] ${action} at ${new Date().toISOString()}`);
}

function initVendedorMap() {
    const el = document.getElementById('map-canvas');
    if (!el || typeof google === 'undefined') return;
    vMap = new google.maps.Map(el, {
        center: { lat: -20.31, lng: -40.31 }, zoom: 15,
        styles: [{ "featureType": "all", "elementType": "all", "stylers": [{ "invert_lightness": true }, { "saturation": 10 }, { "lightness": 30 }, { "gamma": 0.5 }, { "hue": "#435158" }] }]
    });
}

function initSupportMessageListener(uid) {
    firebase.database().ref(`mensagens/${uid}`).on('child_added', snap => {
        const m = snap.val();
        if (m.sender === 'admin' && !m.read) {
            document.getElementById('badge-support')?.classList.add('active');
            if (typeof showGlobalNotification === 'function') {
                showGlobalNotification('Suporte UniRotas', m.text, 'support');
            }
        }
    });
}

// ── ENTER APP ────────────────────────────────────────────────────────────
async function enterApp(uid) {
    currentVendorUid = uid;
    const screenLogin = document.getElementById('screen-login'), screenApp = document.getElementById('screen-app');
    const bottomNav = document.querySelector('.bottom-nav');
    if (screenLogin) { screenLogin.classList.add('hidden'); screenLogin.style.display = 'none'; }
    if (screenApp) { screenApp.classList.remove('hidden'); screenApp.style.display = 'flex'; }
    if (bottomNav) { bottomNav.style.display = 'flex'; }

    try {
        const snap = await firebase.database().ref('usuarios/' + uid).once('value');
        const data = snap.val() || {};
        currentVendorName = data.name || 'Vendedor';
        updateHeaderName(currentVendorName);
        updateGreeting();
        updateQuickCards();

        document.getElementById('sidebar-user-name').textContent = currentVendorName;
        document.getElementById('sidebar-user-cpf').textContent = data.cpf ? `CPF: ${data.cpf}` : 'ID Ativo';

        firebase.database().ref('vendedores/' + uid).onDisconnect().update({ status: 'Offline' });
        firebase.database().ref('vendedores/' + uid).update({ status: 'Online', name: currentVendorName, lastActive: Date.now() });

        initVendedorMap();
        if (typeof listenForMeetingNotifications === 'function') listenForMeetingNotifications(uid);

        initSupportMessageListener(uid);
        showScreen('dashboard');
        if (typeof loadMeetingScreen === 'function') loadMeetingScreen();
        if (typeof loadEconomyStats === 'function') loadEconomyStats();
    } catch (e) {
        console.error("EnterApp Error:", e);
    }
}

// ── INITIALIZATION ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    console.log("UniRotas: DOMContentLoaded");
    const authSplash = document.getElementById('auth-splash');
    const safetyTimeout = setTimeout(() => {
        if (authSplash && authSplash.style.display !== 'none') {
            authSplash.style.display = 'none';
            const sl = document.getElementById('screen-login');
            if (sl) { sl.classList.remove('hidden'); sl.style.display = 'flex'; }
        }
    }, 8000);

    if (window.firebase && firebase.auth) {
        firebase.auth().onAuthStateChanged((user) => {
            clearTimeout(safetyTimeout);
            if (authSplash) authSplash.style.display = 'none';

            if (user) enterApp(user.uid);
            else {
                const sl = document.getElementById('screen-login');
                const bottomNav = document.querySelector('.bottom-nav');
                if (sl) { sl.classList.remove('hidden'); sl.style.display = 'flex'; }
                if (bottomNav) { bottomNav.style.display = 'none'; }
            }
        });
    }

    // Mask for CPF info
    const cpfInput = document.getElementById('user-cpf-input');
    if (cpfInput) {
        cpfInput.addEventListener('input', function() {
            let v = this.value.replace(/\D/g, '');
            if (v.length > 11) v = v.slice(0, 11);
            v = v.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d{1,2})$/, '$1.$2.$3-$4');
            this.value = v;
        });
    }

    // Hash detection for reset password
    if (window.location.hash.includes('type=recovery')) {
        document.getElementById('new-password-modal').style.display = 'flex';
    }

    // Particles effect
    (function particles() {
        const top = document.querySelector('.login-top');
        if (!top) return;
        const wrap = document.createElement('div');
        wrap.className = 'login-particles';
        for (let i = 0; i < 15; i++) {
            const p = document.createElement('div');
            p.className = 'login-particle';
            p.style.cssText = `left:${Math.random()*100}%;bottom:${Math.random()*20}%;animation-delay:${Math.random()*5}s;`;
            wrap.appendChild(p);
        }
        top.prepend(wrap);
    })();
});
