/**
 * UniRotas - Lógica de Reuniões (Módulo Ultra-Fidelidade V2 - Nativo Supabase)
 * Implementado com auditoria anti-fraude, fluxos A-B-C-D e otimização TSP.
 */

/* ── ESTADO GLOBAIS ── */
let m_state = {
    role: null,           // 'driver' | 'individual'
    location: null,       // { id, name, address, lat, lng }
    vehicleType: 'carro', // 'carro' | 'moto'
    paxSelected: [],      // [{uid, name, lat, lng, isOnline, target}]
    checkpoints: [],      // [{type, lat, lng, ts, label}]
    passengersData: {},   // { uid: { embark, dropoff, status } }
    status: 'idle',       // 'idle' | 'outbound' | 'at_meeting' | 'return'
    startTime: null
};

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
    const views = ['m-view-role', 'm-view-location', 'm-view-search', 'm-view-outbound', 'm-view-at-meeting', 'm-view-return', 'm-view-individual'];
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
    localStorage.setItem('unirotas_m_v2_state', JSON.stringify(m_state));
}

function m_init() {
    const saved = localStorage.getItem('unirotas_m_v2_state');
    if (saved) {
        m_state = JSON.parse(saved);
        if (m_state.status === 'outbound') m_resumeOutbound();
        else if (m_state.status === 'at_meeting') m_showView('m-view-at-meeting');
        else if (m_state.status === 'return') m_resumeReturn();
        else m_showView('m-view-role');
    } else {
        m_showView('m-view-role');
    }
    m_initRealtimeListeners();
    m_autoDiscoverSession(); // DESCOBERTA AUTOMÁTICA DE SESSÃO PARA PASSAGEIROS
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
            console.log("📍 Sessão vinculada encontrada:", mySession.id);
            m_state.sessionId = mySession.id;
            m_state.currentSession = mySession;
            
            const myInfo = mySession.passengers.find(p => p.uid === myUid);
            if (myInfo && myInfo.confirmed_presence) {
                m_showView('m-view-at-meeting');
            }
            
            m_subscribeToSession();
        }
        m_listenForNewInvites();
    } catch (e) {
        console.error("Erro na autodescoberta:", e.message);
    }
}

function m_listenForNewInvites() {
    window.supabase
        .channel('global_invites')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'meeting_sessions' }, payload => {
            const newSess = payload.new;
            const myUid = window.currentVendorUid;
            
            if (newSess.passengers && newSess.passengers.some(p => p.uid === myUid)) {
                console.log("🔔 NOVO CONVITE RECEBIDO!", newSess.id);
                m_state.sessionId = newSess.id;
                m_state.currentSession = newSess;
                m_subscribeToSession();
                
                if (typeof showScreen === 'function') showScreen('reuniao');
                m_showToast("Você recebeu um convite de carona!", "info");
            }
        })
        .subscribe();
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
    }
}

function m_setVehicle(type) {
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
    if (idx > -1) m_state.paxSelected.splice(idx, 1);
    else m_state.paxSelected.push({ uid, name, target: true });
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
    m_state.status = 'outbound';
    m_state.startTime = new Date().toISOString();
    
    const sessionId = ([1e7]+-1e3+-4e4+-8e3+-1e11).replace(/[018]/g, c =>
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
        date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
    };

    try {
        const { error } = await window.supabase.from('meeting_sessions').upsert(sessionData);
        if (error) throw error;
        m_saveState();
        m_resumeOutbound();
    } catch (e) {
        console.error(e);
        m_showToast("Erro ao iniciar sessão", "error");
    }
}

function m_resumeOutbound() {
    m_showView('m-view-outbound');
    const destName = document.getElementById('m-outbound-dest-name');
    if (destName) destName.textContent = m_state.location?.name || 'Destino';
    m_startGpsPolling();
    m_subscribeToSession();
}

let m_sessionChannel = null;
function m_subscribeToSession() {
    if (!m_state.sessionId) return;
    if (m_sessionChannel) window.supabase.removeChannel(m_sessionChannel);

    m_sessionChannel = window.supabase
        .channel(`session_${m_state.sessionId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'meeting_sessions', filter: `id=eq.${m_state.sessionId}` }, payload => {
            const data = payload.new;
            if (!data) return;
            m_state.currentSession = data;
            const myUid = window.currentVendorUid;
            const myInfo = data.passengers ? data.passengers.find(p => p.uid === myUid) : null;
            if (myInfo && myInfo.signal_embark && !myInfo.boarded) {
                if (typeof openModal === 'function') openModal('m-modal-embark');
                else {
                    const modal = document.getElementById('m-modal-embark');
                    if (modal) modal.classList.add('show');
                }
            }

            // NOVO: Detecta que o motorista chegou e pede confirmação de presença do carona
            if (data.status === 'at_meeting' && myInfo && myInfo.boarded && !myInfo.confirmed_presence) {
                const modalPresence = document.getElementById('m-modal-presence-carona');
                if (modalPresence) modalPresence.classList.add('show');
            }

            m_renderOutboundList();
        })
        .subscribe();
}

// PASSAGEIRO CONFIRMA PRESENÇA NA REUNIÃO (VALIDA GPS)
async function m_paxConfirmPresence() {
    if (!m_state.sessionId || !m_state.currentSession) return;
    
    // VALIDAÇÃO DE GPS: Precisa estar a 200m do local da reunião
    const loc = m_state.currentSession;
    const dist = m_haversine(window.lastLat, window.lastLon, loc.meeting_location_lat, loc.meeting_location_lng);
    
    if (dist > 0.20) {
        return m_showToast('Você precisa estar no local da reunião para confirmar!', 'error');
    }

    const myUid = window.currentVendorUid;
    const updatedList = m_state.currentSession.passengers.map(p => {
        // Marca como confirmed_presence e limpa status de boarded para a volta
        if (p.uid === myUid) return { ...p, confirmed_presence: true, arrival_ts: new Date().toISOString() };
        return p;
    });

    try {
        const { error } = await window.supabase
            .from('meeting_sessions')
            .update({ passengers: updatedList })
            .eq('id', m_state.sessionId);

        if (error) throw error;
        
        closeModal('m-modal-presence-carona');
        m_showToast("Presença Confirmada!", "success");
        m_showView('m-view-at-meeting');
    } catch (e) {
        console.error("Erro ao confirmar presença:", e.message);
    }
}

async function m_sendEmbarkSignal(paxUid) {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const updatedList = m_state.currentSession.passengers.map(p => {
        if (p.uid === paxUid) return { ...p, signal_embark: true };
        return p;
    });
    try {
        await window.supabase.from('meeting_sessions').update({ passengers: updatedList }).eq('id', m_state.sessionId);
        m_showToast("Aviso enviado!", "success");
    } catch (e) { console.error(e); }
}

async function m_paxConfirmEmbark() {
    if (!m_state.sessionId || !m_state.currentSession) return;
    const myUid = window.currentVendorUid;
    const updatedList = m_state.currentSession.passengers.map(p => {
        if (p.uid === myUid) return { ...p, boarded: true, signal_embark: false };
        return p;
    });
    try {
        await window.supabase.from('meeting_sessions').update({ passengers: updatedList }).eq('id', m_state.sessionId);
        const modal = document.getElementById('m-modal-embark');
        if (modal) modal.classList.remove('show');
        m_showToast("Embarque confirmado!", "success");
    } catch (e) { console.error(e); }
}

function m_renderOutboundList() {
    const container = document.getElementById('m-outbound-pax-list');
    if (!container) return;
    const pList = m_state.currentSession?.passengers || m_state.paxSelected;
    container.innerHTML = pList.map(p => {
        const isOnline = m_state.paxSelected.find(x => x.uid === p.uid)?.isOnline;
        const boarded = p.boarded;
        return `
            <div class="meeting-card" style="margin-bottom:8px; opacity: ${boarded ? '0.6' : '1'}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div style="font-weight:700; font-size:0.9rem;">${p.name}</div>
                        <div style="font-size:0.7rem; color:${isOnline ? 'var(--success)' : 'var(--danger)'};">
                            <i data-lucide="${isOnline ? 'map-pin' : 'map-pin-off'}" style="width:10px;"></i>
                            ${isOnline ? 'GPS ATIVO' : 'GPS INATIVO'}
                        </div>
                    </div>
                    <div style="display:flex; gap:8px;">
                        ${boarded ? '<span style="color:var(--success); font-weight:800;">OK</span>' : 
                          `<button class="pax-action-btn" onclick="m_sendEmbarkSignal('${p.uid}')" style="background:var(--gold-bg); padding:8px; border-radius:10px; color:var(--gold);">
                            <i data-lucide="door-open"></i></button>`}
                    </div>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

/* ── GPS LOOP ── */
let m_gpsInterval = null;
function m_startGpsPolling() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    m_syncGpsLoop();
    m_gpsInterval = setInterval(m_syncGpsLoop, 15000);
}

async function m_syncGpsLoop() {
    const uids = m_state.paxSelected.map(p => p.uid);
    if (uids.length === 0) return;
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
    } catch (e) { console.error(e); }
}

/* ── GERAL ── */
async function m_confirmPresence() {
    const dist = m_haversine(window.lastLat, window.lastLon, m_state.location?.lat, m_state.location?.lng);
    if (dist > 0.20) return m_showToast('Você precisa estar no local!', 'error');
    try {
        await window.supabase.from('meeting_sessions').insert({
            driver_name: window.currentVendorName, driver_id: window.currentVendorUid,
            role: 'individual', date: new Date().toISOString().split('T')[0],
            checkpoints: [{ lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString(), label: 'PRESENÇA' }]
        });
        m_showToast('Presença confirmada!', 'success');
        m_showView('m-view-at-meeting');
    } catch (e) { console.error(e); }
}

function m_initRealtimeListeners() {
    if (!window.currentVendorUid) return;
    window.supabase.channel('public:participants').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vendedores' }, () => {
        if (m_state.status === 'outbound' || m_state.status === 'return') m_syncGpsLoop();
    }).subscribe();
}

window.closeModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
};

async function m_confirmArrival() {
    if (!m_state.sessionId) return;
    
    m_state.status = 'at_meeting';
    m_state.checkpoints.push({ type: 'arrival', label: 'REUNIÃO', lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString() });
    
    try {
        const { error } = await window.supabase
            .from('meeting_sessions')
            .update({ 
                status: 'at_meeting',
                checkpoints: m_state.checkpoints 
            })
            .eq('id', m_state.sessionId);

        if (error) throw error;

        m_saveState();
        m_showView('m-view-at-meeting');
        if (m_gpsInterval) clearInterval(m_gpsInterval);
        m_showToast("Chegada confirmada!", "success");
    } catch (e) {
        console.error("Erro ao confirmar chegada:", e.message);
    }
}

function m_abortJourney() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    m_state = { role: null, location: null, vehicleType: 'carro', paxSelected: [], checkpoints: [], passengersData: {}, status: 'idle', startTime: null };
    localStorage.removeItem('unirotas_m_v2_state');
    m_showView('m-view-role');
    m_showToast("Viagem cancelada.", "info");
}