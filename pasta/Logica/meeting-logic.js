/**
 * UniRotas - Lógica de Reuniões (Módulo Ultra-Fidelidade V2 - Nativo Supabase)
 * Implementado com auditoria anti-fraude, fluxos A-B-C-D e otimização TSP.
 */

/* ── ESTADO GLOBAIS ── */
window.m_state = {
    role: null,           // 'driver' | 'pax' | 'individual'
    location: null,       // { id, name, address, lat, lng }
    vehicleType: 'carro', // 'carro' | 'moto'
    paxSelected: [],      // [{uid, name, lat, lng, isOnline, target}]
    passengersData: {},   // { uid: { embark, dropoff, status } }
    status: 'idle',       // 'idle' | 'outbound' | 'at_meeting' | 'return'
    startTime: null,
    currentSession: null
};
const m_state = window.m_state;

/* ── CONSTANTES ── */
const KM_VALUE_CAR = 0.90;
const KM_VALUE_MOTO = 0.40;
const GPS_TIMEOUT_MS = 900000; // 15 minutos de tolerância para oscilações de sinal

/* ── HELPERS ── */
function m_showToast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) {
        console.warn("Toast element not found, using alert:", msg);
        return;
    }
    el.textContent = msg;
    el.className = `toast toast-${type} show`;
    setTimeout(() => el.classList.remove('show'), 3500);
}

function m_showView(viewId) {
    const views = [
        'm-view-role', 'm-view-location', 'm-view-search',
        'm-view-outbound', 'm-view-at-meeting', 'm-view-return',
        'm-view-individual', 'm-view-pax-waiting', 'm-view-pax-onboard',
        'm-view-pax-meeting', 'm-view-pax-returning'
    ];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function m_haversine(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 999;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function m_saveState() {
    m_state.userId = window.currentVendorUid; // Vincula o estado ao usuário atual
    localStorage.setItem('unirotas_m_v2_state', JSON.stringify(m_state));
}

window.m_openConfirmModal = function (title, msg, onConfirm) {
    const modal = document.getElementById('m-modal-confirm');
    const titleEl = document.getElementById('m-confirm-title');
    const msgEl = document.getElementById('m-confirm-msg');
    const btnNo = document.getElementById('m-confirm-no');
    const btnYes = document.getElementById('m-confirm-yes');

    if (!modal) return;

    titleEl.textContent = title;
    msgEl.innerText = msg;

    modal.style.display = 'flex';
    modal.classList.add('show');
    modal.classList.remove('hidden');

    btnNo.onclick = () => {
        closeModal('m-modal-confirm');
    };

    btnYes.onclick = () => {
        closeModal('m-modal-confirm');
        if (onConfirm) onConfirm();
    };

    if (window.lucide) lucide.createIcons();
};

function m_init() {
    console.log("📍 Inicializando lógica de Reunião...");

    // Se já temos um estado em memória com status ativo, não sobrescrevemos do localStorage 
    // a menos que seja um carregamento inicial (status idle)
    if (m_state.status === 'idle' || !m_state.sessionId) {
        const saved = localStorage.getItem('unirotas_m_v2_state');
        if (saved) {
            const parsed = JSON.parse(saved);
            // TRAVA DE SEGURANÇA: Só restaura se o arquivo salvo pertencer ao usuário logado
            if (parsed.userId === window.currentVendorUid) {
                Object.assign(m_state, parsed);
                console.log("💾 Estado recuperado do Storage:", m_state.status);
            } else {
                console.log("⚠️ Estado antigo de outro usuário detectado. Descartando.");
                localStorage.removeItem('unirotas_m_v2_state');
            }
        }
    }

    // Agora processa o status atual (seja o recém-lido ou o que já estava em memória)
    if (m_state.status === 'outbound') {
        m_resumeOutbound();
        m_refreshSessionData();
    }
    else if (m_state.status === 'at_meeting') {
        m_showView('m-view-at-meeting');
    }
    else if (m_state.status === 'return' || m_state.status === 'inbound') {
        m_resumeReturn();
        m_refreshSessionData();
    }
    else if (m_state.status === 'pax_waiting') {
        m_resumePaxWaiting();
        m_refreshSessionData();
    }
    else if (m_state.status === 'pax_onboard') {
        m_showView('m-view-pax-onboard');
        m_subscribeToSession();
        m_startPaxOnboardRadar();
    }
    else if (m_state.status === 'pax_at_meeting') {
        m_showView('m-view-pax-meeting');
        m_subscribeToSession();
    }
    else if (m_state.status === 'pax_returning') {
        m_showView('m-view-pax-returning');
        m_subscribeToSession();
    }
    else if (m_state.location && m_state.location.id && m_state.role === 'individual') {
        // Modo Solo / Jornada Individual
        m_showView('m-view-individual');
        const destInfo = document.getElementById('m-indiv-location-info');
        if (destInfo) destInfo.textContent = `Local: ${m_state.location.name}`;
        m_startGpsPolling();
    }
    else {
        m_showView('m-view-role');
    }

    m_initRealtimeListeners();
    m_autoDiscoverSession();
}

function m_resumePaxWaiting() {
    m_state.role = 'pax';
    m_showView('m-view-pax-waiting');
    const msg = document.getElementById('m-pax-waiting-msg');
    if (msg && m_state.currentSession) msg.textContent = `Carona com ${m_state.currentSession.driver_name || 'Colega'}`;
    m_subscribeToSession();
    if (typeof m_renderInbox === 'function') m_renderInbox();
}

// BUSCA DADOS FRESCOS DA SESSÃO SE ESTIVER EM CURSO
async function m_refreshSessionData() {
    if (!m_state.sessionId) return;
    try {
        const { data, error } = await window.supabase
            .from('meeting_sessions')
            .select('*')
            .eq('id', m_state.sessionId)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            console.warn("⚠️ Sessão não encontrada no DB no momento.");
            // Não limpamos imediatamente para evitar flickering em caso de micro-atraso do Supabase
            return;
        }

        m_state.currentSession = data;

        // Garantia de persistência do papel (role)
        if (data.driver_id === window.currentVendorUid) m_state.role = 'driver';
        else m_state.role = 'pax';

        m_renderOutboundList();
        m_renderReturnList();
        if (typeof m_renderInbox === 'function') m_renderInbox();
    } catch (e) {
        console.error("Erro ao dar refresh na sessão:", e);
    }
}

// BUSCA SESSÃO ATIVA ONDE SOU PASSAGEIRO
async function m_autoDiscoverSession() {
    const myUid = window.currentVendorUid;
    if (!myUid) return;

    try {
        const { data, error } = await window.supabase
            .from('meeting_sessions')
            .select('*')
            .is('finalized_at', null)
            .order('created_at', { ascending: false });

        if (error) throw error;
        const mySession = data.find(s => s.passengers && s.passengers.some(p => p.uid === myUid));

        if (mySession) {
            console.log("📍 Sessão vinculada encontrada via DB:", mySession.id);
            m_state.sessionId = mySession.id;
            m_state.currentSession = mySession;
            m_state.role = 'pax';

            const myInfo = mySession.passengers.find(p => p.uid === myUid);

            if (myInfo && myInfo.boarded) {
                // Já embarcou, então está na reunião ou aguardando presença final
                m_state.status = 'at_meeting';
                m_showView('m-view-at-meeting');
            } else if (myInfo) {
                // Está na lista mas não embarcou: Tela de Espera
                m_state.status = 'pax_waiting';
                m_resumePaxWaiting();
            }

            m_saveState();
            m_subscribeToSession();

            // Verifica se tem sinal de embarque ativo no carregamento
            if (myInfo && myInfo.signal_embark) {
                const modal = document.getElementById('m-modal-embark');
                if (modal) modal.classList.add('show');
            }
        }
        m_listenForInvites();
    } catch (e) {
        console.error("Erro na autodescoberta:", e.message);
    }
}

let m_inviteChannel = null;
function m_listenForInvites() {
    if (!window.currentVendorUid || m_inviteChannel) return;

    m_inviteChannel = window.supabase.channel('global_invites', { config: { broadcast: { self: false } } })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'meeting_sessions' }, payload => {
            console.log("🔔 Atividade na Sessão Detectada via Banco:", payload.eventType);
            if (payload.new) m_handleNewInvitePayload(payload.new);
        })
        .on('broadcast', { event: 'new_invite' }, payload => {
            console.log("🚀 Novo convite via BROADCAST Detectado");
            m_handleNewInvitePayload(payload.payload.session);
        })
        .subscribe();
}

function m_handleNewInvitePayload(sessionData) {
    const myUid = window.currentVendorUid;
    if (!sessionData || !sessionData.passengers || !myUid) return;

    // Verifica se eu estou na lista de passageiros e NÃO cancelei
    const isForMe = sessionData.passengers.some(p => p.uid === myUid && !p.canceled);

    console.log("🛠️ Checking invite payload:", { isForMe, sessionStatus: sessionData.status, currentStoredId: m_state.sessionId });

    // Se for para mim e eu não estiver já nessa sessão com este status ativo
    // (Ou se eu estava antes em 'idle' e agora fui puxado para uma sessão)
    if (isForMe && (m_state.sessionId !== sessionData.id || m_state.status === 'idle')) {
        console.log("🎯 CONVITE CONFIRMADO! Iniciando redirecionamento automático...");

        // 1. Atualiza estado em memória IMEDIATAMENTE
        m_state.sessionId = sessionData.id;
        m_state.currentSession = sessionData;
        const status = sessionData.status;
        m_state.status = (status === 'inbound') ? 'pax_returning' : 'pax_waiting';
        m_state.role = 'pax';
        m_saveState();

        // 2. Muda para a aba Reunião globalmente
        if (window.currentScreen !== 'reuniao') {
            if (typeof showScreen === 'function') showScreen('reuniao');
        }

        // 3. Força a sintonização e mostra a tela correta
        if (m_state.status === 'pax_returning') {
            m_showView('m-view-pax-returning');
            m_showToast("Um motorista iniciou um retorno com você...", "success");
        } else {
            m_resumePaxWaiting();
            m_showToast(`Viagem com ${sessionData.driver_name || 'Colega'} iniciada!`, "success");
        }
        m_subscribeToSession();
    }
}

/* ── FLUXOS DE CONFIGURAÇÃO (SUPABASE NATIVE) ── */
function m_selectRole(role) {
    m_state.role = role;
    m_saveState();
    m_showView('m-view-location');
    m_loadLocations();
}

async function m_loadLocations() {
    const list = document.getElementById('m-location-list');
    if (!list) return;
    list.innerHTML = '<p style="padding:15px; opacity:0.5;">Buscando locais...</p>';

    try {
        const { data, error } = await window.supabase
            .from('meeting_locations')
            .select('*');

        if (error) throw error;
        if (!data || data.length === 0) {
            list.innerHTML = '<p style="padding:15px; opacity:0.5;">Nenhum local ativo.</p>';
            return;
        }

        list.innerHTML = data.map(loc => `
            <button class="action-btn" onclick='m_setMeetingLocation(${JSON.stringify(loc)})' 
                    style="width:100%; text-align:left; background:var(--glass); border:1px solid var(--border); padding:16px; border-radius:18px; margin-bottom:10px;">
                <div style="font-weight:800; color:#fff;">${loc.name}</div>
                <div style="font-size:0.7rem; color:var(--muted);">${loc.address}</div>
            </button>
        `).join('');
    } catch (e) {
        console.error("Erro ao carregar locais:", e);
        list.innerHTML = '<p style="color:var(--danger); padding:15px;">Erro ao carregar locais. Verifique a conexão.</p>';
    }
}

function m_setMeetingLocation(loc) {
    m_state.location = loc;
    m_saveState();
    if (m_state.role === 'driver') {
        m_showView('m-view-search');
    } else {
        m_showView('m-view-individual');
        const destInfo = document.getElementById('m-indiv-location-info');
        if (destInfo) destInfo.textContent = `Local: ${loc.name}`;
        m_startGpsPolling(); // Começa radar de distância
    }
}

function m_setVehicle(type) {
    // ✅ VALIDAÇÃO AO TROCAR VEÍCULO
    if (type === 'moto' && m_state.paxSelected.length > 1) {
        return m_showToast("Você já selecionou mais caronas do que cabe em uma moto! Remova alguns antes de trocar.", "warning");
    }

    m_state.vehicleType = type;
    m_saveState();
    const btnCarro = document.getElementById('m-btn-veh-carro');
    const btnMoto = document.getElementById('m-btn-veh-moto');

    if (btnCarro) {
        if (type === 'carro') btnCarro.classList.add('active-veh');
        else btnCarro.classList.remove('active-veh');
    }
    if (btnMoto) {
        if (type === 'moto') btnMoto.classList.add('active-veh');
        else btnMoto.classList.remove('active-veh');
    }
}

async function m_searchPassengers(q) {
    const container = document.getElementById('m-search-results');
    if (!container) return;

    if (!q || q.length < 2) {
        container.innerHTML = '';
        container.style.display = 'none';
        container.classList.add('hidden');
        return;
    }

    try {
        const myUid = window.currentVendorUid;
        let { data, error } = await window.supabase
            .from('usuarios')
            .select('uid, name, cpf')
            .or(`name.ilike.%${q}%,cpf.ilike.%${q}%`)
            .limit(10);

        if (error) throw error;
        const filtered = data ? data.filter(u => u.uid !== myUid) : [];

        container.style.display = 'block';
        container.classList.remove('hidden');

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:20px; text-align:center; color:var(--muted); font-size:0.8rem;">Nenhum colega encontrado.</div>`;
        } else {
            container.innerHTML = filtered.map(u => `
                <div class="search-result-item" onclick="m_togglePaxSelection('${u.uid}', '${u.name}')" style="cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05);">
                    <div style="flex:1">
                        <div style="font-weight:700; color:#fff; font-size:0.95rem;">${u.name}</div>
                        <div style="font-size:0.7rem; color:var(--gold);">${u.cpf || 'Vendedor UniRotas'}</div>
                    </div>
                    <i data-lucide="plus" style="color:var(--gold); width:18px;"></i>
                </div>
            `).join('');
        }
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        console.error(e);
        container.innerHTML = `<p style="color:var(--danger); padding:15px; font-size:0.8rem;">Erro na busca.</p>`;
    }
}

function m_togglePaxSelection(uid, name) {
    const idx = m_state.paxSelected.findIndex(p => p.uid === uid);
    if (idx > -1) {
        m_state.paxSelected.splice(idx, 1);
    } else {
        // ✅ VALIDAÇÃO DE CAPACIDADE NA SELEÇÃO INICIAL
        const vehicleType = m_state.vehicleType || 'carro';
        const maxPax = vehicleType === 'moto' ? 1 : 4;

        if (m_state.paxSelected.length >= maxPax) {
            const label = vehicleType === 'moto' ? 'moto (máx. 1 carona)' : 'carro (máx. 4 caronas)';
            return m_showToast(`Limite atingido! Seu ${label} já está completo.`, 'error');
        }

        m_state.paxSelected.push({ uid, name, target: true });
        const input = document.getElementById('m-pax-search');
        const results = document.getElementById('m-search-results');
        if (input) input.value = '';
        if (results) {
            results.style.display = 'none';
            results.innerHTML = '';
        }
    }
    m_renderChips();
    m_saveState();
}

function m_renderChips() {
    const container = document.getElementById('m-selected-chips');
    if (!container) return;
    container.innerHTML = m_state.paxSelected.map(p => `
        <div class="pax-chip" style="background:var(--gold-bg); border:1px solid var(--gold); padding:8px 14px; border-radius:20px; font-size:0.75rem; color:#fff; display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700;">${p.name.split(' ')[0]}</span>
            <i data-lucide="x" style="width:14px; cursor:pointer;" onclick="m_togglePaxSelection('${p.uid}')"></i>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
}

/* ── FLUXO DE IDA (OUTBOUND) ── */
async function m_startOutbound() {
    if (!window.isTracking || !window.lastLat || !window.lastLon) {
        return m_showToast("Ative o GPS antes de iniciar!", "error");
    }
    m_state.status = 'outbound';
    m_state.startTime = new Date().toISOString();

    // UUID Generator v4
    const sessionId = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );

    m_state.sessionId = sessionId;
    const sessionData = {
        id: sessionId,
        driver_id: window.currentVendorUid,
        driver_name: window.currentVendorName,
        status: 'outbound',
        meeting_location_name: m_state.location?.name || '',
        meeting_location_address: m_state.location?.address || '',
        meeting_location_lat: m_state.location?.lat || 0,
        meeting_location_lng: m_state.location?.lng || 0,
        vehicle_type: m_state.vehicleType || 'carro',
        passengers: m_state.paxSelected.map(p => ({ uid: p.uid, name: p.name, boarded: false, signal_embark: false })),
        gps_track: [{
            type: 'start',
            label: 'INÍCIO VIAGEM',
            lat: window.lastLat,
            lng: window.lastLon,
            ts: new Date().toISOString()
        }],
        return_track: [],
        date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
    };

    try {
        const { error } = await window.supabase.from('meeting_sessions').upsert(sessionData);
        if (error) throw error;

        m_state.currentSession = sessionData;
        m_state.role = 'driver'; // Motorista que inicia
        m_saveState();
        m_resumeOutbound();
        if (typeof m_renderInbox === 'function') m_renderInbox();

        // 🚀 BROADCAST GLOBAL DO CONVITE
        if (m_inviteChannel) {
            m_inviteChannel.send({
                type: 'broadcast',
                event: 'new_invite',
                payload: { session: sessionData }
            });
        }
    } catch (e) {
        console.error("Erro ao iniciar rota:", e.message);
        m_showToast("Erro ao iniciar sessão", "error");
    }
}

async function m_startOutboundSolo() {
    console.log("🚀 Iniciando jornada solo para a reunião...");
    if (!window.isTracking || !window.lastLat || !window.lastLon) {
        return m_showToast("Ative o GPS antes de iniciar!", "error");
    }
    m_state.paxSelected = [];
    m_state.location = m_state.location || {}; // Garante que temos um destino
    m_startOutbound();
}

function m_renderOutboundList() {
    const container = document.getElementById('m-outbound-pax-list');
    if (!container || !m_state.currentSession) return;

    const paxes = m_state.currentSession.passengers || [];

    if (paxes.length === 0) {
        container.innerHTML = `
            <div style="padding:30px 10px; text-align:center; opacity:0.4; font-size:0.85rem;">
                Nenhum carona adicionado.
            </div>
        `;
        return;
    }

    container.innerHTML = paxes.map(p => {
        // Agora buscamos status real vindo do Radar de Status
        const status = (m_state.paxStatusMap || {})[p.uid] || { isOnline: false };
        const isOnline = status.isOnline;
        const isChecked = (p.waypoint !== false);
        const isCanceled = (p.canceled === true);

        return `
            <div class="pax-item-v2 ${isChecked ? 'checked' : ''} ${isCanceled ? 'pax-canceled' : ''}" style="position:relative; opacity: ${isCanceled ? '0.6' : '1'}">
                <input type="checkbox" ${isChecked ? 'checked' : ''} 
                       ${isCanceled ? 'disabled' : ''}
                       onchange="m_togglePaxWaypoint('${p.uid}', this.checked)"
                       style="width:20px; height:20px; accent-color:var(--gold); cursor:${isCanceled ? 'not-allowed' : 'pointer'};">
                
                <div style="flex:1;">
                    <div style="font-weight:800; color:#fff; font-size:0.95rem; display:flex; align-items:center; gap:8px;">
                        ${p.name.split(' ')[0]}
                        <div class="pax-status-dot ${isOnline ? 'active' : ''}"></div>
                    </div>
                    <div style="font-size:0.7rem; color:var(--muted); font-weight:700;">
                        ${isOnline ? 'GPS ATIVO' : 'GPS INATIVO'}
                        ${isCanceled ? '<br><span style="color:#ff4757; font-weight:950; text-transform:lowercase;">(cancelou)</span>' : ''}
                    </div>
                </div>

                <button class="pax-actions-btn" onclick="m_togglePaxMenu('${p.uid}')">
                    <i data-lucide="menu"></i>
                </button>

                <div data-menu-id="${p.uid}" class="pax-actions-menu">
                    ${!isCanceled ? `
                        <div class="pax-menu-item" onclick="m_openChatWith('${p.uid}', '${p.name}')">
                            <i data-lucide="message-square"></i> Abrir Chat
                        </div>
                        <div class="pax-menu-item" onclick="m_signalEmbark('${p.uid}')">
                            <i data-lucide="bell"></i> Sinal de Embarque
                        </div>
                    ` : ''}
                    <div class="pax-menu-item danger" onclick="m_removePaxFromSession('${p.uid}')" style="border-top:${!isCanceled ? '1px solid rgba(255,255,255,0.05)' : 'none'};">
                        <i data-lucide="trash-2"></i> Remover
                    </div>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

window.m_openChatWith = function (uid, name) {
    if (typeof showScreen === 'function') {
        window.activeConvo = { id: uid, name: name };
        showScreen('chat');
    }
};

function m_resumeOutbound() {
    m_state.role = 'driver';
    m_showView('m-view-outbound');
    const destName = document.getElementById('m-outbound-dest-name');
    if (destName && m_state.location) destName.textContent = m_state.location.name;
    m_renderOutboundList();
    m_startGpsPolling();
    m_subscribeToSession();
    m_startMemberStatusRadar();
}

/* ── GERENCIAMENTO DE CARONAS ON-THE-GO ── */

window.m_openAddPaxModal = function () {
    console.log("🔍 Abrindo busca de carona...");

    // ✅ VALIDAÇÃO DE CAPACIDADE DO VEÍCULO
    const currentPassengers = (m_state.currentSession?.passengers || []).filter(p => !p.canceled);
    const vehicleType = m_state.currentSession?.vehicle_type || m_state.vehicleType || 'carro';
    const maxPax = vehicleType === 'moto' ? 1 : 4;

    if (currentPassengers.length >= maxPax) {
        const label = vehicleType === 'moto' ? 'moto (1 carona)' : 'carro (4 caronas)';
        m_showToast(`Capacidade máxima atingida! Sua ${label} já está cheia.`, 'error');
        return;
    }

    const modal = document.getElementById('m-modal-add-pax');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
        modal.classList.remove('hidden');

        const input = document.getElementById('m-add-pax-input');
        if (input) {
            input.value = '';
            setTimeout(() => input.focus(), 300);
        }
        const results = document.getElementById('m-add-pax-results');
        if (results) results.innerHTML = '';
    }
};

window.m_searchAddPax = async function (query) {
    const resultsArea = document.getElementById('m-add-pax-results');
    if (!resultsArea) return;

    if (query.length < 2) {
        resultsArea.innerHTML = '';
        return;
    }

    try {
        const { data, error } = await window.supabase
            .from('vendedores')
            .select('uid, name, status')
            .neq('uid', window.currentVendorUid)
            .ilike('name', `%${query}%`)
            .limit(5);

        if (error) throw error;

        resultsArea.innerHTML = data.map(v => `
            <div class="pax-item-v2" style="cursor:pointer;" onclick="m_addPaxToSession('${v.uid}', '${v.name}')">
                <div class="pax-status-dot ${v.status === 'Online' ? 'active' : ''}"></div>
                <div style="flex:1;">
                    <div style="font-weight:700; font-size:0.9rem;">${v.name}</div>
                    <div style="font-size:0.75rem; opacity:0.6;">${v.status || 'Offline'}</div>
                </div>
                <i data-lucide="plus-circle" style="color:var(--gold); width:20px;"></i>
            </div>
        `).join('');
        lucide.createIcons();
    } catch (e) { console.error(e); }
};

window.m_addPaxToSession = async function (uid, name) {
    if (!m_state.sessionId) return;

    // Verifica se já existe
    const exists = m_state.currentSession?.passengers?.some(p => p.uid === uid);
    if (exists) return m_showToast("Este colega já está na lista!", "info");

    // ✅ SEGUNDA BARREIRA: Valida capacidade antes de gravar
    const activePax = (m_state.currentSession?.passengers || []).filter(p => !p.canceled);
    const vehicleType = m_state.currentSession?.vehicle_type || m_state.vehicleType || 'carro';
    const maxPax = vehicleType === 'moto' ? 1 : 4;
    if (activePax.length >= maxPax) {
        const label = vehicleType === 'moto' ? 'moto (máx. 1 carona)' : 'carro (máx. 4 caronas)';
        closeModal('m-modal-add-pax');
        return m_showToast(`Capacidade máxima do ${label} já foi atingida!`, 'error');
    }

    const newPax = { uid, name, boarded: false, signal_embark: false, waypoint: true };
    const newList = [...(m_state.currentSession?.passengers || []), newPax];

    try {
        const { error } = await window.supabase
            .from('meeting_sessions')
            .update({ passengers: newList })
            .eq('id', m_state.sessionId);

        if (error) throw error;

        m_showToast(`${name.split(' ')[0]} adicionado!`, "success");
        closeModal('m-modal-add-pax');

        // O Realtime atualizará o m_state.currentSession e chamará o render, mas forçamos localmente também
        if (m_state.currentSession) {
            m_state.currentSession.passengers = newList;
            m_renderOutboundList();
            m_renderReturnList();
        }

        // 🚀 AVISO GLOBAL: Envia broadcast para o passageiro ser redirecionado na hora
        // Se m_inviteChannel não estiver pronto, tentamos iniciá-lo rapidinho
        if (!m_inviteChannel) m_listenForInvites();

        if (m_inviteChannel) {
            console.log("📡 Enviando broadcast de convite para novos passageiros...");
            m_inviteChannel.send({
                type: 'broadcast',
                event: 'new_invite',
                payload: { session: { ...m_state.currentSession, id: m_state.sessionId } }
            });
        }
    } catch (e) {
        console.error("Erro ao adicionar carona:", e);
        m_showToast("Erro ao adicionar carona", "error");
    }
};

window.m_removePaxFromSession = async function (uid) {
    if (!m_state.sessionId || !m_state.currentSession) return;

    m_openConfirmModal(
        "Remover Carona",
        "Deseja realmente remover este colega da carona?",
        async () => {
            const newList = m_state.currentSession.passengers.filter(p => p.uid !== uid);
            try {
                const { error } = await window.supabase
                    .from('meeting_sessions')
                    .update({ passengers: newList })
                    .eq('id', m_state.sessionId);

                if (error) throw error;

                // 🚀 BROADCAST DE REMOÇÃO: Avisa o carona IMEDIATAMENTE
                if (m_sessionChannel) {
                    m_sessionChannel.send({
                        type: 'broadcast',
                        event: 'pax_removed',
                        payload: { uid: uid }
                    });
                }

                m_state.currentSession.passengers = newList; // Atualiza localmente imediato
                m_showToast("Carona removida.", "info");
                m_renderOutboundList();
                m_renderReturnList();
            } catch (e) { console.error(e); }
        }
    );
};

window.m_signalEmbark = async function (paxUid) {
    if (!m_state.sessionId || !m_state.currentSession) return;

    console.log("🔔 Enviando sinal de embarque para:", paxUid);
    const newList = m_state.currentSession.passengers.map(p => {
        if (p.uid === paxUid) return { ...p, signal_embark: true };
        return p;
    });

    try {
        const { error } = await window.supabase
            .from('meeting_sessions')
            .update({ passengers: newList })
            .eq('id', m_state.sessionId);

        if (error) throw error;

        // Envia broadcast rápido
        if (m_sessionChannel) {
            m_sessionChannel.send({
                type: 'broadcast',
                event: 'embark_signal',
                payload: { targetUid: paxUid }
            });
        }

        m_showToast("Sinal de embarque enviado!", "success");
        m_togglePaxMenu(paxUid);
    } catch (e) { console.error(e); }
};

window.m_togglePaxWaypoint = function (uid, isChecked) {
    if (!m_state.currentSession) return;
    const pax = m_state.currentSession.passengers.find(p => p.uid === uid);
    if (pax) {
        pax.waypoint = isChecked;
        m_renderOutboundList(); // Atualiza UI (sem precisar de DB agora, usaremos no Gerar Caminho)
    }
};

window.m_togglePaxMenu = function (uid) {
    const allMenus = document.querySelectorAll('.pax-actions-menu');
    const target = document.querySelector(`.pax-actions-menu[data-menu-id="${uid}"]`) || document.getElementById('menu-' + uid);

    if (target) {
        // Fecha os outros e alterna este
        allMenus.forEach(m => { if (m !== target) m.classList.remove('show'); });
        target.classList.toggle('show');
    } else {
        console.warn("   -> Menu não encontrado para:", uid);
    }
};

let m_sessionChannel = null;
function m_subscribeToSession() {
    if (!m_state.sessionId) return;
    if (m_sessionChannel) window.supabase.removeChannel(m_sessionChannel);

    console.log("👂 Sintonizando canal da sessão:", m_state.sessionId);
    m_sessionChannel = window.supabase
        .channel(`session_${m_state.sessionId}`, { config: { broadcast: { self: true } } })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'meeting_sessions', filter: `id=eq.${m_state.sessionId}` }, payload => {
            console.log("🔄 Update via Banco recebido", payload.new.id);
            const data = payload.new;
            if (!data) return;
            m_state.currentSession = data;

            // LÓGICA DE EMBARQUE PARA PASSAGEIRO (VIA BANCO)
            if (m_state.role === 'pax') {
                const myUid = window.currentVendorUid;
                const passengers = data.passengers || [];
                const myInfo = passengers.find(p => p.uid === myUid);

                // SE EU NÃO ESTOU MAIS NA LISTA -> Fui removido pelo motorista
                if (!myInfo) {
                    console.log("🚫 [Detectado] Fui removido desta carona.");
                    m_showToast("O motorista removeu você da lista de caronas.", "error");
                    m_cleanupSession();
                    if (typeof showScreen === 'function') showScreen('reuniao');
                    return;
                }

                if (myInfo.signal_embark) {
                    console.log("🔔 SINAL DE EMBARQUE DETECTADO NO DB!");
                    const modal = document.getElementById('m-modal-embark');
                    if (modal) {
                        modal.style.display = 'flex';
                        modal.classList.add('show');
                        modal.classList.remove('hidden');
                    }
                }

                if (myInfo.boarded) {
                    m_state.status = 'at_meeting';
                    m_saveState();
                    m_init();
                }
            }

            m_renderOutboundList();
            if (typeof m_renderInbox === 'function') m_renderInbox();

            // Detecta sinal de DESEMBARQUE (Motorista -> Passageiro)
            if (m_state.role === 'pax') {
                const myUid = window.currentVendorUid;
                const myInfo = data.passengers?.find(p => p.uid === myUid);

                if (myInfo && myInfo.signal_dropoff && !myInfo.dropped_off) {
                    console.log("📍 [DESEMBARQUE] Motorista solicitou confirmação.");
                    const modal = document.getElementById('m-modal-dropoff');
                    if (modal) {
                        modal.style.display = 'flex';
                        modal.classList.add('show');
                        modal.classList.remove('hidden');
                        if (window.lucide) lucide.createIcons();
                    }
                }
            }

            // Detecta motorista iniciando retorno -> avisa passageiro
            if (data.status === 'inbound') {
                const myUid = window.currentVendorUid;
                const myInfo = data.passengers?.find(p => p.uid === myUid);
                // Se eu estou na lista e ainda não desembarquei/cancelei, sou puxado para a tela de retorno
                if (myInfo && !myInfo.dropped_off && !myInfo.canceled) {
                    console.log("🔄 Fui adicionado ao retorno! Redirecionando...");
                    m_state.status = 'pax_returning';
                    m_state.role = 'pax';
                    m_state.sessionId = data.id;
                    m_state.currentSession = data;
                    m_saveState();
                    m_showView('m-view-pax-returning');
                    m_showToast("Um motorista iniciou um retorno com você...", "success");
                }
            }
        })
        .on('broadcast', { event: 'embark_signal' }, payload => {
            const myUid = window.currentVendorUid;
            if (payload.payload.targetUid === myUid) {
                console.log("🚀 Broadcast de EMBARQUE recebido");
                const modal = document.getElementById('m-modal-embark');
                if (modal) {
                    modal.style.display = 'flex';
                    modal.classList.add('show');
                    modal.classList.remove('hidden');
                }
            }
        })
        .on('broadcast', { event: 'ride_canceled' }, payload => {
            console.log("🚫 [Realtime] Viagem cancelada pelo motorista");
            m_showToast("O motorista cancelou a viagem.", "error");
            m_cleanupSession();
        })
        .on('broadcast', { event: 'pax_canceled' }, async payload => {
            const paxUid = payload.payload.uid;
            console.log("👤 [BROADCAST] Passageiro cancelou:", paxUid);

            if (m_state.role === 'driver' && m_state.currentSession) {
                // Força atualização LOCAL imediata (Independente do banco agora)
                m_state.currentSession.passengers = m_state.currentSession.passengers.map(p => {
                    if (p.uid === paxUid) return { ...p, canceled: true, waypoint: false };
                    return p;
                });

                m_renderOutboundList();
                m_showToast("Um carona cancelou a viagem agora!", "warning");

                // Persiste no banco para garantir
                try {
                    await window.supabase.from('meeting_sessions')
                        .update({ passengers: m_state.currentSession.passengers })
                        .eq('id', m_state.sessionId);
                } catch (e) { console.error("Erro ao persistir cancelamento via motorista:", e); }
            }
        })
        .on('broadcast', { event: 'pax_removed' }, payload => {
            const myUid = window.currentVendorUid;
            if (payload.payload.uid === myUid) {
                console.log("🚫 [BROADCAST] Fui removido pelo motorista.");
                m_showToast("Motorista cancelou... aguarde outro motorista para o retorno.", "warning");
                m_cleanupSession();
                if (typeof showScreen === 'function') showScreen('reuniao');
            }
        })
        .subscribe();
}

// Fim da função m_subscribeToSession

window.m_paxConfirmPresence = async function (confirmed) {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const myUid = window.currentVendorUid;
    const newList = m_state.currentSession.passengers.map(p => {
        if (p.uid === myUid) return { ...p, boarded: confirmed, signal_embark: false };
        return p;
    });
    try {
        await window.supabase.from('meeting_sessions').update({ passengers: newList }).eq('id', m_state.sessionId);
        if (confirmed) {
            m_showToast("Embarque confirmado! A caminho da reunião.", "success");
            closeModal('m-modal-embark');
            // Vai para a tela de 'A caminho' não para 'Na Reunião'
            m_state.status = 'pax_onboard';
            m_state.role = 'pax';
            m_saveState();
            m_showView('m-view-pax-onboard');
            const msg = document.getElementById('m-pax-onboard-msg');
            if (msg && m_state.currentSession) msg.textContent = `Com ${m_state.currentSession.driver_name || 'seu motorista'}`;
            m_subscribeToSession();
            m_startPaxOnboardRadar();
        } else {
            m_showToast("Aguardando motorista...", "info");
            closeModal('m-modal-embark');
        }
    } catch (e) { console.error(e); }
};

// Confirmação de PRESENÇA na reunião (quando chega ao local)
window.m_paxConfirmMeetingPresence = async function () {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const myUid = window.currentVendorUid;
    const newList = m_state.currentSession.passengers.map(p => {
        if (p.uid === myUid) return { ...p, confirmed_presence: true };
        return p;
    });
    try {
        await window.supabase.from('meeting_sessions').update({ passengers: newList }).eq('id', m_state.sessionId);
        m_state.currentSession.passengers = newList;

        m_saveState();
        if (m_state.paxOnboardInterval) clearInterval(m_state.paxOnboardInterval);

        // Volta para a tela inicial mas mantém o radar de convites ativos
        m_cleanupSession();
        m_showToast("Presença confirmada! Aguarde um motorista para o retorno...", "success");
    } catch (e) { console.error(e); }
};

// Radar GPS para passageiro embarcado (detecta chegada ao local da reunião)
function m_startPaxOnboardRadar() {
    console.log("📡 Radar do Passageiro Ativo (onboard)");
    if (m_state.paxOnboardInterval) clearInterval(m_state.paxOnboardInterval);
    m_state.paxOnboardInterval = setInterval(() => {
        if (m_state.status !== 'pax_onboard') return clearInterval(m_state.paxOnboardInterval);
        const sess = m_state.currentSession;
        if (!sess || !sess.meeting_location_lat || !window.lastLat) return;

        const dist = m_haversine(window.lastLat, window.lastLon, sess.meeting_location_lat, sess.meeting_location_lng);
        const distEl = document.getElementById('m-pax-onboard-dist');
        if (distEl) distEl.textContent = dist < 1 ? `${(dist * 1000).toFixed(0)}m` : `${dist.toFixed(2)}km`;

        const confirmArea = document.getElementById('m-pax-confirm-area');
        const hint = document.getElementById('m-pax-onboard-hint');
        if (dist <= 0.30) {
            // Chegou! Mostra botão de confirmar
            if (confirmArea) { confirmArea.classList.remove('hidden'); confirmArea.style.display = 'block'; }
            if (hint) hint.style.display = 'none';
        } else {
            if (confirmArea) confirmArea.classList.add('hidden');
            if (hint) hint.style.display = 'block';
        }
    }, 10000);
}
window.m_togglePaxWaitingMenu = function () {
    const menu = document.getElementById('pax-waiting-dropdown');
    if (menu) menu.classList.toggle('show');
};

// Fecha menus ao clicar fora
document.addEventListener('click', (e) => {
    if (!e.target.closest('.pax-actions-btn')) {
        document.querySelectorAll('.pax-actions-menu').forEach(m => m.classList.remove('show'));
    }
    if (!e.target.closest('.btn-pax-menu-trigger')) {
        const pmd = document.getElementById('pax-waiting-dropdown');
        if (pmd) pmd.classList.remove('show');
    }
});

function m_startDistanceRadar() {
    console.log("📡 Radar de Distância Ativo");
    if (m_state.radarInterval) clearInterval(m_state.radarInterval);

    m_state.radarInterval = setInterval(async () => {
        if (!m_state.sessionId || !m_state.currentSession || m_state.status !== 'pax_waiting') {
            return clearInterval(m_state.radarInterval);
        }

        const { data: driver } = await window.supabase
            .from('usuarios') // Corrigido de vendedores para usuarios
            .select('lat, lon')
            .eq('uid', m_state.currentSession.driver_id)
            .maybeSingle();

        if (driver && driver.lat && window.lastLat) {
            const dist = m_haversine(window.lastLat, window.lastLon, driver.lat, driver.lon);
            const radarEl = document.getElementById('m-pax-dist-radar');
            if (radarEl) radarEl.textContent = dist < 0.1 ? "CHEGANDO" : `${dist.toFixed(1)} km`;
        }
    }, 10000);
}

// Radar de Status (Para o Motorista ver se os caronas estão online)
function m_startMemberStatusRadar() {
    console.log("📡 Radar de Status dos Membros Ativo");
    if (m_state.memberStatusInterval) clearInterval(m_state.memberStatusInterval);

    m_state.memberStatusInterval = setInterval(async () => {
        if (!m_state.sessionId || m_state.role !== 'driver') {
            return clearInterval(m_state.memberStatusInterval);
        }

        const paxes = m_state.currentSession?.passengers || [];
        if (paxes.length === 0) return;

        const uids = paxes.map(p => p.uid);

        try {
            const { data: users, error } = await window.supabase
                .from('usuarios')
                .select('uid, last_update')
                .in('uid', uids);

            if (error) throw error;

            const map = {};
            const now = new Date().getTime();

            users.forEach(u => {
                const last = u.last_update ? new Date(u.last_update).getTime() : 0;
                // Online se atualizou nos últimos 90 segundos
                map[u.uid] = { isOnline: (now - last) < 90000 };
            });

            m_state.paxStatusMap = map;
            m_renderOutboundList();
        } catch (e) {
            console.warn("Erro ao buscar status dos caronas:", e.message);
        }
    }, 10000);
}

function m_cleanupSession() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    if (m_state.radarInterval) clearInterval(m_state.radarInterval);
    if (m_sessionChannel) window.supabase.removeChannel(m_sessionChannel);
    m_state.role = null;
    m_state.location = null;
    m_state.vehicleType = 'carro';
    m_state.paxSelected = [];
    m_state.checkpoints = [];
    m_state.passengersData = {};
    m_state.status = 'idle';
    m_state.startTime = null;
    m_state.sessionId = null;
    m_state.currentSession = null;
    localStorage.removeItem('unirotas_m_v2_state');
    m_showView('m-view-role');
    const modal = document.getElementById('m-modal-embark');
    if (modal) modal.classList.remove('show');
}

function m_checkForEmbarkModal(data) {
    const myUid = window.currentVendorUid;
    const myInfo = data.passengers ? data.passengers.find(p => p.uid === myUid) : null;

    if (myInfo && myInfo.signal_embark && !myInfo.boarded) {
        console.log("🚪 Sinal via Banco: Abrindo modal");
        const modal = document.getElementById('m-modal-embark');
        if (modal) modal.classList.add('show');
    }

    if (data.status === 'at_meeting' && myInfo && myInfo.boarded && !myInfo.confirmed_presence) {
        const modalPresence = document.getElementById('m-modal-presence-carona');
        if (modalPresence) modalPresence.classList.add('show');

        // Também mostra o botão fixo na tela para redundância
        const arrivalArea = document.getElementById('m-pax-arrival-area');
        if (arrivalArea) arrivalArea.classList.remove('hidden');
    }
}

// PASSAGEIRO CONFIRMA PRESENÇA NA REUNIÃO (VALIDA GPS)
async function m_paxConfirmPresence() {
    if (!m_state.sessionId || !m_state.currentSession) return;

    m_openConfirmModal(
        "Confirmar Presença",
        "Confirmar sua presença no local da reunião?\n(Isso encerrará o chat desta carona)",
        async () => {
            const loc = m_state.currentSession;
            const dist = m_haversine(window.lastLat, window.lastLon, loc.meeting_location_lat, loc.meeting_location_lng);

            // Conferência de distância (limite de 300 metros para tolerância de GPS)
            if (dist > 0.30) {
                return m_showToast('Você precisa estar no local da reunião para confirmar!', 'error');
            }

            const myUid = window.currentVendorUid;
            const updatedList = JSON.parse(JSON.stringify(m_state.currentSession.passengers)).map(p => {
                if (p.uid === myUid) return { ...p, confirmed_presence: true, arrival_ts: new Date().toISOString() };
                return p;
            });

            try {
                await window.supabase.from('meeting_sessions').update({ passengers: updatedList }).eq('id', m_state.sessionId);
                closeModal('m-modal-presence-carona');

                // Limpa a área do botão redundante
                const arrivalArea = document.getElementById('m-pax-arrival-area');
                if (arrivalArea) arrivalArea.classList.add('hidden');

                // LIMPEZA DO CHAT (Carona -> Motorista)
                await m_cleanupChatAfterMeeting(m_state.currentSession.driver_id);

                m_cleanupSession();
                m_showToast("Presença confirmada! Aguarde um motorista para o retorno...", "success");
            } catch (e) { console.error(e); }
        }
    );
}

// FAXINA NO BANCO DE DADOS: Remove mensagens entre motorista e carona após confirmação
async function m_cleanupChatAfterMeeting(partnerUid) {
    if (!partnerUid) return;
    const myUid = window.currentVendorUid;
    console.log(`🧹 [CLEANUP] Faxinando chat: ${myUid} <-> ${partnerUid}`);

    try {
        const { error } = await window.supabase.from('mensagens')
            .delete()
            .or(`and(vendor_uid.eq.${myUid},receiver_uid.eq.${partnerUid}),and(vendor_uid.eq.${partnerUid},receiver_uid.eq.${myUid})`);

        if (error) throw error;

        console.log("✅ Chat limpo com sucesso.");
        if (typeof m_renderInbox === 'function') m_renderInbox();
    } catch (e) {
        console.error("❌ Falha na faxina do chat:", e);
    }
}



function m_paxCancelRide() {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const myUid = window.currentVendorUid;

    m_openConfirmModal(
        "Cancelar Carona",
        "Deseja realmente cancelar sua carona?",
        async () => {
            try {
                const session = m_state.currentSession;
                const updatedList = session.passengers.map(p => {
                    if (p.uid === myUid) return { ...p, canceled: true, waypoint: false };
                    return p;
                });

                // 1. Garante que temos um canal ativo para o broadcast
                if (!m_sessionChannel) {
                    console.log("📡 Canal não encontrado, sintonizando antes de cancelar...");
                    m_subscribeToSession();
                }

                // Pequeno delay para garantir sintonização se necessário
                setTimeout(async () => {
                    // 2. BROADCAST PARA O MOTORISTA (Prioridade Máxima para UI)
                    if (m_sessionChannel) {
                        console.log("🚀 Enviando broadcast de cancelamento IMEDIATO...");
                        m_sessionChannel.send({
                            type: 'broadcast',
                            event: 'pax_canceled',
                            payload: { uid: myUid }
                        });
                    }

                    // 3. ATUALIZA O BANCO (Persistência)
                    console.log("📤 Atualizando banco de dados...");
                    await window.supabase.from('meeting_sessions').update({ passengers: updatedList }).eq('id', m_state.sessionId);

                    // 4. Limpeza e Redirecionamento
                    await window.supabase.from('mensagens').delete().eq('vendor_uid', myUid);
                    m_showToast("Carona cancelada com sucesso.", "error");

                    setTimeout(() => {
                        m_cleanupSession();
                        if (typeof showScreen === 'function') showScreen('reuniao');
                    }, 500);
                }, m_sessionChannel ? 0 : 500);

            } catch (e) {
                console.error("Erro no cancelamento:", e);
                m_showToast("Erro ao cancelar carona.", "error");
            }
        }
    );
}

function m_openDriverChat() {
    m_togglePaxWaitingMenu();
    if (typeof showScreen === 'function') {
        showScreen('chat');
        const s = m_state.currentSession;
        if (s && s.driver_id && typeof m_openConvo === 'function') {
            m_openConvo(s.driver_id, s.driver_name || 'Motorista');
        }
    }
}

/* ── GPS LOOP ── */
let m_gpsInterval = null;
function m_startGpsPolling() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    m_syncGpsLoop();
    m_gpsInterval = setInterval(m_syncGpsLoop, 15000);
}

async function m_syncGpsLoop() {
    console.log("🛰️ [m_syncGpsLoop] Sincronizando GPS e verificando distância...");

    // 1. Sincroniza Passageiros (se houver)
    const uids = m_state.paxSelected.map(p => p.uid);
    if (uids.length > 0) {
        try {
            const { data } = await window.supabase.from('vendedores').select('*').in('uid', uids);
            if (data) {
                data.forEach(v => {
                    const p = m_state.paxSelected.find(x => x.uid === v.uid);
                    if (p) {
                        p.lat = v.lat || p.lat; p.lng = v.lng || p.lng;
                        const ts = v.last_active || v.updated_at;
                        p.isOnline = ts ? (Date.now() - new Date(ts).getTime() < GPS_TIMEOUT_MS) : false;
                    }
                });
            }
            m_renderOutboundList();
        } catch (e) { console.error("Erro ao sincronizar passageiros:", e); }
    }

    // 2. Verifica distância do PRÓPRIO usuário ao local da reunião
    if (m_state.location && m_state.location.lat && window.lastLat) {
        const dist = m_haversine(window.lastLat, window.lastLon, m_state.location.lat, m_state.location.lng);
        console.log(`📏 Distância do destino: ${dist.toFixed(3)} km`);

        // Botão para Motorista (Outbound)
        const btnOutbound = document.getElementById('m-btn-arrived-outbound');
        if (btnOutbound) {
            if (dist <= 0.30 && m_state.status === 'outbound') {
                btnOutbound.classList.remove('hidden');
                btnOutbound.style.display = 'flex';
            } else {
                btnOutbound.classList.add('hidden');
                btnOutbound.style.display = 'none';
            }
        }

        // Botão para Individual (Solo)
        const btnIndiv = document.getElementById('m-btn-indiv-confirm');
        if (btnIndiv) {
            // No modo solo, a tela pode ser a de individual
            if (dist <= 0.30 && m_state.status === 'idle' && m_state.location?.id) {
                btnIndiv.classList.remove('hidden');
                btnIndiv.style.display = 'flex';
            } else {
                // Se o status mudar ou estiver longe, poderíamos esconder, mas individual geralmente é estático até clicar
                // Vamos apenas garantir que apareça quando chegar.
                if (dist <= 0.30) {
                    btnIndiv.classList.remove('hidden');
                    btnIndiv.style.display = 'flex';
                }
            }
        }
    }
}

/* ── GERAL ── */
async function m_confirmPresence() {
    const dist = m_haversine(window.lastLat, window.lastLon, m_state.location?.lat, m_state.location?.lng);
    if (dist > 0.30) return m_showToast('Você precisa estar no local (limite 300m)!', 'error');
    try {
        await window.supabase.from('meeting_sessions').insert({
            driver_name: window.currentVendorName, driver_id: window.currentVendorUid,
            role: 'individual', date: new Date().toISOString().split('T')[0],
            checkpoints: [{ lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString(), label: 'PRESENÇA' }]
        });
        m_showToast('Presença confirmada!', 'success');
        m_state.status = 'at_meeting';
        m_saveState();
        m_showView('m-view-at-meeting');
    } catch (e) { console.error(e); }
}

let m_realtimeInitialized = false;
function m_initRealtimeListeners() {
    if (!window.currentVendorUid || m_realtimeInitialized) return;
    m_realtimeInitialized = true;

    window.supabase.channel('public:participants')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vendedores' }, () => {
            if (m_state.status === 'outbound' || m_state.status === 'return' || m_state.status === 'inbound') m_syncGpsLoop();
        })
        .subscribe();
}

window.closeModal = function (id) {
    const el = document.getElementById(id);
    if (el) {
        el.classList.remove('show');
        el.classList.add('hidden');
        el.style.display = 'none';
    }
};

async function m_confirmArrival() {
    if (!m_state.sessionId || !m_state.currentSession) return;

    m_openConfirmModal(
        "Confirmar Chegada",
        "Confirmar chegada na reunião?\n(Isso encerrará os chats com seus caronas)",
        async () => {
            m_state.status = 'at_meeting';
            const newCheckpoint = {
                type: 'meeting',
                label: 'REUNIÃO',
                lat: window.lastLat,
                lng: window.lastLon,
                ts: new Date().toISOString()
            };

            try {
                // Salva o ponto de reunião no gps_track existente
                const track = m_state.currentSession?.gps_track || [];
                track.push(newCheckpoint);

                await window.supabase.from('meeting_sessions').update({
                    status: 'at_meeting',
                    gps_track: track
                }).eq('id', m_state.sessionId);

                // MOTORISTA LIMPA CHAT COM TODOS OS CARONAS
                const passengers = m_state.currentSession.passengers || [];
                for (const pax of passengers) {
                    await m_cleanupChatAfterMeeting(pax.uid);
                }

                m_saveState();
                m_showView('m-view-at-meeting');
                if (m_gpsInterval) clearInterval(m_gpsInterval);
                m_showToast("Chegada confirmada e chats limpos!", "success");
            } catch (e) { console.error(e); }
        }
    );
}

function m_abortJourney() {
    if (m_sessionChannel) {
        m_sessionChannel.send({
            type: 'broadcast',
            event: 'ride_canceled',
            payload: { reason: 'driver_aborted' }
        });
    }
    m_cleanupSession();
    m_showToast("Viagem cancelada.", "info");
}

function m_openReturnModal() {
    m_startReturnJourney();
}
window.m_openReturnModal = m_openReturnModal;

/* ── FLUXO DE RETORNO (RETURN) ── */
async function m_startReturnJourney() {
    if (!m_state.sessionId) return;
    m_state.status = 'inbound';

    const returnPoint = {
        type: 'return_start',
        label: 'INÍCIO RETORNO',
        lat: window.lastLat,
        lng: window.lastLon,
        ts: new Date().toISOString()
    };

    try {
        const rTrack = m_state.currentSession?.return_track || [];
        rTrack.push(returnPoint);

        // Zera a lista de passageiros para o retorno ser preenchido do zero
        await window.supabase.from('meeting_sessions').update({
            status: 'inbound',
            return_track: rTrack,
            passengers: [] // Lista vazia para o retorno
        }).eq('id', m_state.sessionId);

        m_state.currentSession.passengers = [];
        m_state.currentSession.status = 'inbound';
        m_state.paxSelected = []; // Começa a lista de rota do zero para o retorno
        m_saveState();
        m_resumeReturn();
        m_showToast("Retorno iniciado! Adicione quem irá retornar com você.", "info");
    } catch (e) { console.error("Erro ao iniciar retorno:", e); }
}

function m_resumeReturn() {
    m_showView('m-view-return');
    m_startGpsPolling();
    m_renderReturnList();
}

function m_renderReturnList() {
    const container = document.getElementById('m-return-pax-list');
    if (!container) return;
    const pList = m_state.currentSession?.passengers || [];

    if (pList.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:20px; opacity:0.5; font-size:0.8rem;">Adicione colegas para o retorno...</div>`;
        return;
    }

    container.innerHTML = pList.map(p => {
        const dropped = p.dropped_off;
        const canceled = p.canceled;
        const isSelected = m_state.paxSelected.some(ps => ps.uid === p.uid);

        return `
            <div class="pax-item-v2" style="position:relative; opacity: ${dropped || canceled ? '0.6' : '1'}">
                <div style="display:flex; align-items:center; gap:12px; flex:1;">
                    ${!dropped && !canceled ? `
                        <input type="checkbox" class="pax-checkbox" 
                               ${isSelected ? 'checked' : ''} 
                               onchange="m_togglePaxSelection('${p.uid}', '${p.name}', 0, 0)">
                    ` : '<div style="width:20px"></div>'}
                    <div style="flex:1;">
                        <div style="font-weight:800; color:#fff; font-size:0.95rem; display:flex; align-items:center; gap:8px;">
                            ${p.name.split(' ')[0]}
                            ${dropped ? '<i data-lucide="check-circle-2" style="width:14px; color:var(--success);"></i>' : ''}
                        </div>
                        <div style="font-size:0.7rem; color:${canceled ? 'var(--danger)' : (dropped ? 'var(--success)' : 'var(--gold)')}; font-weight:700;">
                            ${canceled ? 'CANCELOU' : (dropped ? 'DESEMBARCADO' : 'EM TRÂNSITO')}
                        </div>
                    </div>
                </div>

                <button class="pax-actions-btn" onclick="m_togglePaxMenu('${p.uid}_ret')">
                    <i data-lucide="menu"></i>
                </button>

                <div data-menu-id="${p.uid}_ret" class="pax-actions-menu">
                    ${!dropped && !canceled ? `
                        <div class="pax-menu-item" onclick="m_requestDropoff('${p.uid}')">
                            <i data-lucide="log-out"></i> Confirmar Desembarque
                        </div>
                    ` : ''}
                    <div class="pax-menu-item danger" onclick="m_removePaxFromSession('${p.uid}')">
                        <i data-lucide="trash-2"></i> Remover
                    </div>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

async function m_requestDropoff(uid) {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const newList = m_state.currentSession.passengers.map(p => {
        if (p.uid === uid) return { ...p, signal_dropoff: true };
        return p;
    });

    try {
        await window.supabase.from('meeting_sessions').update({ passengers: newList }).eq('id', m_state.sessionId);
        m_state.currentSession.passengers = newList;
        m_showToast("Sinal de desembarque enviado!", "info");
        m_renderReturnList();
    } catch (e) { console.error(e); }
}

window.m_paxConfirmDropoff = async function () {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const myUid = window.currentVendorUid;
    const newList = m_state.currentSession.passengers.map(p => {
        if (p.uid === myUid) return { ...p, dropped_off: true, dropoff_ts: new Date().toISOString(), dropoff_lat: window.lastLat, dropoff_lng: window.lastLon };
        return p;
    });

    try {
        await window.supabase.from('meeting_sessions').update({ passengers: newList }).eq('id', m_state.sessionId);
        closeModal('m-modal-dropoff');
        m_cleanupSession();
        m_showToast("Reunião encerrada, tenha um bom descanso!", "success");
    } catch (e) { console.error(e); }
};

window.m_paxRejectDropoff = function () {
    closeModal('m-modal-dropoff');
    m_showToast("Ok, desembarque recusado.", "info");
};

async function m_confirmDropoff(uid) {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const updatedList = JSON.parse(JSON.stringify(m_state.currentSession.passengers)).map(p => {
        if (p.uid === uid) return { ...p, dropped_off: true, dropoff_ts: new Date().toISOString() };
        return p;
    });
    try {
        await window.supabase.from('meeting_sessions').update({ passengers: updatedList }).eq('id', m_state.sessionId);
        m_state.currentSession.passengers = updatedList;
        m_renderReturnList();
        m_showToast("Desembarque confirmado!", "success");
    } catch (e) { console.error(e); }
}

async function m_finalizeAll() {
    if (!m_state.sessionId || !m_state.currentSession) return;

    // Verificar se todos desembarcaram (exceto cancelados)
    const passengers = m_state.currentSession.passengers || [];
    const inTransit = passengers.filter(p => !p.dropped_off && !p.canceled);

    if (inTransit.length > 0) {
        return m_showToast(`Ainda há ${inTransit.length} carona(s) no veículo. Confirme o desembarque de todos antes de finalizar!`, "error");
    }

    m_openConfirmModal(
        "Chegar em Casa?",
        "Isso encerrará sua jornada de hoje e enviará o relatório. Confirmar?",
        async () => {
            // Calcula KM final
            const track = [...(m_state.currentSession?.gps_track || []), ...(m_state.currentSession?.return_track || [])];
            let totalKm = 0;
            if (track.length > 1) {
                for (let i = 1; i < track.length; i++) {
                    totalKm += m_haversine(track[i - 1].lat, track[i - 1].lng, track[i].lat, track[i].lng);
                }
            }

            const endPoint = {
                type: 'end',
                label: 'FIM JORNADA',
                lat: window.lastLat,
                lng: window.lastLon,
                ts: new Date().toISOString()
            };

            try {
                const rTrack = m_state.currentSession?.return_track || [];
                rTrack.push(endPoint);

                await window.supabase.from('meeting_sessions').update({
                    finalized_at: new Date().toISOString(),
                    status: 'finalized',
                    total_km: totalKm,
                    return_track: rTrack
                }).eq('id', m_state.sessionId);

                m_abortJourney(); // Limpa estado local
                m_showToast("Jornada finalizada com sucesso! Bom descanso.", "success");
            } catch (e) { console.error(e); }
        }
    );
}

let lastGpsRecord = 0;
window.recordGpsPoint = async function (lat, lon) {
    if (!m_state.sessionId || m_state.role !== 'driver') return;

    // Throttle: Grava no banco apenas a cada 30 segundos
    const now = Date.now();
    if (now - lastGpsRecord < 30000) return;
    lastGpsRecord = now;

    console.log("📍 [recordGpsPoint] Persistindo breadcrumb no Supabase...");

    try {
        const { data, error: fetchError } = await window.supabase
            .from('meeting_sessions')
            .select('gps_track, return_track, status')
            .eq('id', m_state.sessionId)
            .maybeSingle();

        if (fetchError || !data) return;

        const isReturn = (data.status === 'inbound');
        const point = { lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lon.toFixed(6)), ts: new Date().toISOString() };

        if (isReturn) {
            const arr = Array.isArray(data.return_track) ? data.return_track : [];
            arr.push(point);
            await window.supabase.from('meeting_sessions').update({ return_track: arr }).eq('id', m_state.sessionId);
        } else {
            const arr = Array.isArray(data.gps_track) ? data.gps_track : [];
            arr.push(point);
            await window.supabase.from('meeting_sessions').update({ gps_track: arr }).eq('id', m_state.sessionId);
        }
    } catch (e) {
        console.error("Erro ao gravar ponto GPS:", e);
    }
}

function m_generateBestRoute() {
    console.log("🗺️ Gerando melhor caminho...");

    if (!window.isTracking || !window.lastLat || !window.lastLon) {
        return m_showToast("GPS desativado. Ative-o para gerar o melhor caminho!", "error");
    }

    const sess = m_state.currentSession;
    if (!sess) return m_showToast("Sessão não iniciada.", "error");

    const destLat = sess.meeting_location_lat;
    const destLng = sess.meeting_location_lng;

    if (!destLat || !destLng) return m_showToast("Local de destino não definido.", "error");

    const origin = `${window.lastLat},${window.lastLon}`;
    const dest = `${destLat},${destLng}`;

    const travelMode = sess.vehicle_type === 'moto' ? 'two_wheeler' : 'driving';

    // FILTRAGEM INTELIGENTE DE WAYPOINTS
    let waypoints = "";
    if (sess.passengers && sess.passengers.length > 0) {
        const routePaxes = sess.passengers.filter(p => {
            // Regra: Deve estar marcado (waypoint !== false) e o GPS deve estar ativo (isOnline)
            const sp = m_state.paxSelected.find(x => x.uid === p.uid);
            return (p.waypoint !== false) && sp && sp.isOnline && !p.boarded;
        });

        if (routePaxes.length > 0) {
            const points = routePaxes.map(p => {
                const sp = m_state.paxSelected.find(x => x.uid === p.uid);
                return `${sp.lat},${sp.lng}`;
            });
            waypoints = "&waypoints=" + points.join("|");
        }
    }

    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${waypoints}&travelmode=${travelMode}`;

    window.open(url, '_blank');
}
window.m_togglePaxWaitingMenu = function () {
    const menu = document.getElementById('pax-waiting-dropdown');
    if (menu) menu.classList.toggle('show');
};

// Listener Universal de Menu e Cliques Fora
document.addEventListener('click', (e) => {
    // Fecha menus de carona do motorista
    if (!e.target.closest('.pax-actions-btn')) {
        document.querySelectorAll('.pax-actions-menu').forEach(m => m.classList.remove('show'));
    }
    // Fecha menu do passageiro
    if (!e.target.closest('.btn-pax-menu-trigger')) {
        const pmd = document.getElementById('pax-waiting-dropdown');
        if (pmd) pmd.classList.remove('show');
    }
});

window.m_openChatWith = function (uid, name) {
    if (typeof showScreen === 'function') showScreen('chat');
    if (typeof m_openConvo === 'function') m_openConvo(uid, name);
};

window.m_cancelRideByPax = async function () {
    m_openConfirmModal(
        "Cancelar Carona",
        "Deseja cancelar seu pedido de carona?",
        async () => {
            const myUid = window.currentVendorUid;
            const session = m_state.currentSession;
            if (!session) return;
            const newList = session.passengers.filter(p => p.uid !== myUid);
            try {
                await window.supabase.from('meeting_sessions').update({ passengers: newList }).eq('id', m_state.sessionId);
                m_showToast("Carona cancelada.", "info");
                m_cleanupSession();
            } catch (e) { console.error(e); }
        }
    );
};

window.m_resumePaxWaiting = function () {
    m_showView('m-view-pax-waiting');
    const msg = document.getElementById('m-pax-waiting-msg');
    if (msg && m_state.currentSession) {
        msg.textContent = `Carona com ${m_state.currentSession.driver_name || 'Colega'}`;
    }
    m_subscribeToSession();
    m_startDistanceRadar();
    m_startGpsPolling(); // Inicia transmissão de sinal de vida do passageiro
};

/* ── FIM DO ARQUIVO ── */

window.m_generateBestReturnRoute = async function () {
    if (!m_state.sessionId || !m_state.currentSession) return;
    m_showToast("Calculando rota de retorno...", "info");

    try {
        const myUid = window.currentVendorUid;
        const selectedUids = m_state.paxSelected.map(p => p.uid);

        // 1. Busca endereços de todos (Motorista + Caronas Selecionados)
        const allUids = [myUid, ...selectedUids];
        const { data: users, error } = await window.supabase
            .from('usuarios')
            .select('uid, address, nome')
            .in('uid', allUids);

        if (error) throw error;

        const driverInfo = users.find(u => u.uid === myUid);
        const paxesInfoArr = users.filter(u => u.uid !== myUid);

        // 2. Definir Pontos
        // Início: Local da reunião
        const origin = m_state.location?.address || m_state.location?.name || "Local atual";
        // Fim: Endereço do motorista
        const destination = driverInfo?.address || "Minha Casa";

        // Waypoints: Endereços dos caronas marcados (que tenham endereço preenchido)
        const waypoints = paxesInfoArr
            .map(p => p.address)
            .filter(addr => addr && addr.trim() !== '')
            .join('|');

        // 3. Montar URL do Google Maps
        let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
        if (waypoints) {
            url += `&waypoints=${encodeURIComponent(waypoints)}`;
        }

        window.open(url, '_blank');
    } catch (e) {
        console.error("Erro ao gerar rota de retorno:", e);
        m_showToast("Erro ao buscar endereços para a rota.", "error");
    }
};
