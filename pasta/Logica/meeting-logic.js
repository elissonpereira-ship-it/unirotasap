/**
 * UniRotas - Lógica de Reuniões (Módulo Ultra-Fidelidade V2 - Nativo Supabase)
 * Implementado com auditoria anti-fraude, fluxos A-B-C-D e otimização TSP.
 */

/* ── ESTADO GLOBAL ── */
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
        console.log("🔍 Buscando colega:", q);
        const myUid = window.currentVendorUid || localStorage.getItem('sb-ajconwarkeunpixqngnq-auth-token')?.user?.id;

        // Busca multi-campo
        let { data, error } = await window.supabase
            .from('usuarios')
            .select('uid, name, cpf')
            .or(`name.ilike.%${q}%,cpf.ilike.%${q}%`)
            .limit(10);

        if (error) {
            console.error("❌ Erro Supabase:", error);
            throw error;
        }

        // Filtra eu mesmo manualmente para garantir
        const filtered = data ? data.filter(u => u.uid !== myUid) : [];
        console.log("✅ Resultados encontrados:", filtered.length);

        container.style.display = 'block';
        container.classList.remove('hidden');

        if (filtered.length === 0) {
            container.innerHTML = `
                <div style="padding:20px; text-align:center; color:var(--muted); font-size:0.8rem;">
                    <i data-lucide="user-x" style="width:24px; margin-bottom:10px; opacity:0.5;"></i>
                    <div>Nenhum colega encontrado com "${q}"</div>
                </div>
            `;
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
        console.error("🚨 Falha crítica na busca:", e);
        container.innerHTML = `<p style="color:var(--danger); padding:15px; font-size:0.8rem;">Erro na busca. Tente novamente.</p>`;
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
        <div class="pax-chip" style="background:var(--gold-bg); border:1px solid var(--gold); padding:8px 14px; border-radius:20px; font-size:0.75rem; color:#fff; display:flex; align-items:center; gap:8px; animation: fadeIn 0.3s ease;">
            <span style="font-weight:700;">${p.name.split(' ')[0]}</span>
            <i data-lucide="x" style="width:14px; cursor:pointer; color:var(--gold);" onclick="m_togglePaxSelection('${p.uid}')"></i>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
}

/* ── FLUXO DE IDA (OUTBOUND) ── */
function m_startOutbound() {
    m_state.status = 'outbound';
    m_state.startTime = new Date().toISOString();
    m_state.checkpoints = [{ type: 'start', label: 'PARTIDA', lat: window.lastLat, lng: window.lastLon, ts: m_state.startTime }];
    m_saveState();
    m_resumeOutbound();
}

function m_resumeOutbound() {
    m_showView('m-view-outbound');
    const destName = document.getElementById('m-outbound-dest-name');
    if (destName) destName.textContent = m_state.location?.name || 'Destino';
    m_startGpsPolling();
}

let m_gpsInterval = null;
function m_startGpsPolling() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    m_syncGpsLoop();
    m_gpsInterval = setInterval(m_syncGpsLoop, 15000);
}

async function m_syncGpsLoop() {
    const now = Date.now();
    try {
        const uids = m_state.paxSelected.map(p => p.uid);
        if (uids.length === 0) return;

        // USA SELECT(*) PARA EVITAR ERRO 400 SE ALGUMA COLUNA ESPECÍFICA NÃO EXISTIR
        const { data, error } = await window.supabase
            .from('vendedores')
            .select('*')
            .in('uid', uids);

        if (error) {
            console.error("❌ [GPS RADAR] Erro Supabase:", error.message);
            return;
        }

        console.log("📡 GPS RADAR - Dados do Banco:", data);

        if (data && data.length > 0) {
            data.forEach(v => {
                const p = m_state.paxSelected.find(x => x.uid === v.uid);
                if (p) {
                    // Tenta encontrar as coordenadas em qualquer nome de coluna comum
                    p.lat = v.lat || v.latitude || v.lat_coord || p.lat;
                    p.lng = v.lon || v.longitude || v.lng_coord || v.lng || p.lng;

                    // Tenta encontrar o tempo de atividade
                    const ts = v.lastActive || v.last_active || v.updated_at || v.last_sync;
                    if (ts) {
                        const diff = now - new Date(ts).getTime();
                        p.isOnline = (diff < GPS_TIMEOUT_MS);
                        console.log(`🔍 Radar: ${p.name} está ${p.isOnline ? 'ONLINE' : 'OFFLINE'} (atraso: ${Math.round(diff / 1000)}s)`);
                    } else {
                        p.isOnline = false;
                        console.log(`⚠️ Radar: ${p.name} não possui timestamp de atividade.`);
                    }
                }
            });
        }

        m_renderOutboundList();

    } catch (e) {
        console.error("🚨 [GPS RADAR] Falha crítica:", e);
    }
}

function m_renderOutboundList() {
    const container = document.getElementById('m-outbound-pax-list');
    if (!container) return;

    container.innerHTML = m_state.paxSelected.map(p => {
        const gpsColor = p.isOnline ? 'var(--success)' : 'var(--muted)';
        const gpsIcon = p.isOnline ? 'check-circle' : 'circle';
        const isEmbarked = (m_state.passengersData[p.uid]?.status === 'boarded');

        // SÓ MOSTRA O CHECKBOX SE O GPS ESTIVER ATIVO
        const checkbox = p.isOnline
            ? `<input type="checkbox" ${p.target ? 'checked' : ''} onchange="m_toggleTarget('${p.uid}')" style="width:20px; height:20px; accent-color:var(--gold); cursor:pointer;">`
            : `<div style="width:20px; height:20px; display:flex; align-items:center; justify-content:center;"><i data-lucide="slash" style="width:12px; opacity:0.3;"></i></div>`;

        return `
            <div class="driver-item" style="border-left: 3px solid ${isEmbarked ? 'var(--success)' : 'var(--border)'}; opacity: ${p.isOnline ? '1' : '0.7'}">
                <div style="display:flex; align-items:center; gap:12px; flex:1;">
                    ${checkbox}
                    <div>
                        <div class="d-name">${p.name}</div>
                        <div style="font-size:0.6rem; color:${gpsColor}; font-weight:800; display:flex; align-items:center; gap:4px;">
                            <i data-lucide="${gpsIcon}" style="width:10px;"></i> ${p.isOnline ? 'GPS ATIVO' : 'GPS INATIVO'}
                        </div>
                    </div>
                </div>
                <button class="header-btn" onclick="m_embarkRequest('${p.uid}')" ${isEmbarked ? 'disabled' : ''}>
                    <i data-lucide="${isEmbarked ? 'user-check' : 'log-in'}" style="color:${isEmbarked ? 'var(--success)' : 'var(--gold)'}"></i>
                </button>
            </div>
        `;
    }).join('');

    // Check arrival distance
    const dist = m_haversine(window.lastLat, window.lastLon, m_state.location?.lat, m_state.location?.lng);
    const btn = document.getElementById('m-btn-arrived-outbound');
    if (dist < 0.20) btn?.classList.remove('hidden');
    else btn?.classList.add('hidden');

    if (window.lucide) lucide.createIcons();
}

function m_toggleTarget(uid) {
    const p = m_state.paxSelected.find(x => x.uid === uid);
    if (p) {
        p.target = !p.target;
        m_saveState();
    }
}

async function m_embarkRequest(uid) {
    m_showToast(`Enviando convite...`, 'info');

    // Notificação via Tabela de Realtime ou Mensagens
    await window.supabase.from('notifications').insert({
        target_uid: uid,
        sender_uid: window.currentVendorUid,
        sender_name: window.currentVendorName,
        type: 'embark',
        data: { lat: window.lastLat, lng: window.lastLon },
        handled: false
    });
}

/* ── ALGORITMO DE OTIMIZAÇÃO (NEAREST NEIGHBOR) ── */
async function m_generateBestRoute(isForReturn = false) {
    let currentLat = window.lastLat;
    let currentLng = window.lastLon;
    const waypoints = [];

    // FILTRAGEM RIGOROSA: Alvo selecionado E com GPS Ativo
    let pool = [...m_state.paxSelected.filter(p => p.target && p.isOnline)];

    if (pool.length === 0 && !isForReturn) {
        return m_showToast("Nenhum carona com GPS ATIVO selecionado.", "error");
    }

    while (pool.length > 0) {
        let bestIdx = 0, minDist = Infinity;
        pool.forEach((p, i) => {
            const d = m_haversine(currentLat, currentLng, p.lat, p.lng);
            if (d < minDist) { minDist = d; bestIdx = i; }
        });
        const next = pool.splice(bestIdx, 1)[0];
        if (next.lat) waypoints.push(`${next.lat},${next.lng}`);
        currentLat = next.lat || currentLat;
        currentLng = next.lng || currentLng;
    }

    const dest = isForReturn ? await m_getHome() : m_state.location?.address;
    if (!dest) return m_showToast('Destino não definido.', 'error');

    const url = `https://www.google.com/maps/dir/?api=1&origin=Current+Location&destination=${encodeURIComponent(dest)}&waypoints=${encodeURIComponent(waypoints.join('|'))}&travelmode=driving`;
    window.open(url, '_blank');
}

async function m_getHome() {
    try {
        const { data } = await window.supabase
            .from('usuarios')
            .select('addr_rua, addr_num, addr_cidade')
            .eq('uid', window.currentVendorUid)
            .maybeSingle();
        if (data) return `${data.addr_rua}, ${data.addr_num}, ${data.addr_cidade}`;
    } catch (e) { console.error(e); }
    return "Home";
}

async function m_confirmArrival() {
    m_state.status = 'at_meeting';
    m_state.checkpoints.push({ type: 'arrival', label: 'REUNIÃO', lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString() });
    m_saveState();
    m_showView('m-view-at-meeting');
    if (m_gpsInterval) clearInterval(m_gpsInterval);
}

/* ── FLUXO DE RETORNO ── */
function m_openReturnModal() {
    const modal = document.getElementById('m-modal-return-setup');
    if (modal) modal.classList.add('show');
}

function m_setupReturn(mode) {
    if (mode === 'new') {
        m_state.paxSelected = [];
        m_state.status = 'idle';
        m_saveState();
        m_showView('m-view-search');
    } else {
        m_state.status = 'return';
        m_saveState();
        m_resumeReturn();
    }
    const modal = document.getElementById('m-modal-return-setup');
    if (modal) modal.classList.remove('show');
}

function m_resumeReturn() {
    m_showView('m-view-return');
    m_renderReturnList();
    m_startGpsPolling();
}

function m_renderReturnList() {
    const container = document.getElementById('m-return-pax-list');
    if (!container) return;
    container.innerHTML = m_state.paxSelected.map(p => {
        const isDone = (m_state.passengersData[p.uid]?.status === 'completed');
        return `
            <div class="driver-item">
                <div style="font-weight:700; flex:1;">${p.name}</div>
                <button class="action-btn success" onclick="m_dropoffRequest('${p.uid}')" ${isDone ? 'disabled' : ''} style="width: auto; padding: 10px 15px;">
                    ${isDone ? '✓ ENTREGUE' : 'DESEMBARCAR'}
                </button>
            </div>
        `;
    }).join('');

    const allHome = m_state.paxSelected.every(p => m_state.passengersData[p.uid]?.status === 'completed');
    const btnHome = document.getElementById('m-btn-arrived-home');
    if (allHome && btnHome) btnHome.classList.remove('hidden');
    else if (btnHome) btnHome.classList.add('hidden');

    if (window.lucide) lucide.createIcons();
}

async function m_dropoffRequest(uid) {
    await window.supabase.from('notifications').insert({
        target_uid: uid,
        sender_uid: window.currentVendorUid,
        type: 'dropoff',
        ts: Date.now(),
        handled: false
    });
    m_showToast("Solicitação de desembarque enviada.", "info");
}

async function m_finalizeAll() {
    m_state.checkpoints.push({ type: 'finish', label: 'CASA', lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString() });

    let km = 0;
    for (let i = 0; i < m_state.checkpoints.length - 1; i++) {
        km += m_haversine(m_state.checkpoints[i].lat, m_state.checkpoints[i].lng, m_state.checkpoints[i + 1].lat, m_state.checkpoints[i + 1].lng);
    }

    const val = m_state.vehicleType === 'carro' ? KM_VALUE_CAR : KM_VALUE_MOTO;
    const history = {
        driver_id: window.currentVendorUid,
        driver_name: window.currentVendorName,
        meeting_location_name: m_state.location?.name,
        total_km: km,
        reimbursement: (km * val),
        date: new Date().toISOString().split('T')[0],
        checkpoints: m_state.checkpoints,
        passengers: Object.values(m_state.passengersData)
    };

    try {
        await window.supabase.from('meeting_sessions').insert(history);
        m_abortJourney(); // Usa a lógica de limpeza para resetar tudo
        m_showToast('Viagem Finalizada!', 'success');
    } catch (e) {
        console.error("Erro ao salvar história:", e);
        m_showToast("Erro ao salvar dados finais.", "error");
    }
}

/* ── CANCELAMENTO E RESET ── */
function m_abortJourney() {
    if (m_gpsInterval) clearInterval(m_gpsInterval);
    m_state = {
        role: null,
        location: null,
        vehicleType: 'carro',
        paxSelected: [],
        checkpoints: [],
        passengersData: {},
        status: 'idle',
        startTime: null
    };
    localStorage.removeItem('unirotas_m_v2_state');
    m_showView('m-view-role');
    m_showToast("Viagem cancelada.", "info");
}

function m_startOutboundSolo() {
    m_state.paxSelected = [];
    m_startOutbound();
}

/* ── INDIVIDUAL ── */
async function m_confirmPresence() {
    const dist = m_haversine(window.lastLat, window.lastLon, m_state.location?.lat, m_state.location?.lng);
    if (dist > 0.20) return m_showToast('Você precisa estar no local da reunião!', 'error');

    try {
        await window.supabase.from('meeting_sessions').insert({
            driver_name: window.currentVendorName,
            driver_id: window.currentVendorUid,
            role: 'individual',
            meeting_location_name: m_state.location?.name,
            total_km: 0,
            date: new Date().toISOString().split('T')[0],
            checkpoints: [{ lat: window.lastLat, lng: window.lastLon, ts: new Date().toISOString(), label: 'PRESENÇA INDIVIDUAL' }]
        });
        m_showToast('Presença confirmada!', 'success');
        m_showView('m-view-at-meeting');
    } catch (e) { console.error(e); }
}

/* ── REALTIME (NOTIFICAÇÕES E STATUS) ── */
let curDriver = null;
function m_initRealtimeListeners() {
    if (!window.currentVendorUid) return;

    // Escuta Notificações (Embarque/Desembarque)
    window.supabase
        .channel('public:notifications')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `target_uid=eq.${window.currentVendorUid}` }, payload => {
            const n = payload.new;
            if (!n.handled) {
                curDriver = n.sender_uid;
                if (n.type === 'embark') {
                    const modal = document.getElementById('m-modal-embark');
                    if (modal) modal.classList.add('show');
                    if (window.lucide) lucide.createIcons();
                } else if (n.type === 'dropoff') {
                    m_paxComplete('completed');
                }
            }
        })
        .subscribe();

    // Escuta Respostas dos Caronas (para o Motorista)
    window.supabase
        .channel('public:participants')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vendedores' }, payload => {
            // Se o motorista estiver na ida, atualiza a lista se alguém mudar status
            if (m_state.status === 'outbound' || m_state.status === 'return') {
                m_syncGpsLoop();
            }
        })
        .subscribe();
}

async function m_paxConfirmEmbark() {
    try {
        // Atualiza status do passageiro para o motorista ver
        const { error } = await window.supabase
            .from('usuarios')
            .update({ meeting_status: 'boarded', current_driver: curDriver })
            .eq('uid', window.currentVendorUid);

        if (error) throw error;

        // Marca notificação como lida
        await window.supabase.from('notifications').update({ handled: true }).eq('target_uid', window.currentVendorUid).eq('sender_uid', curDriver);

        const modal = document.getElementById('m-modal-embark');
        if (modal) modal.classList.remove('show');
        m_showToast('Embarque confirmado!', 'success');
    } catch (e) {
        console.error(e);
    }
}

async function m_paxComplete(status) {
    try {
        await window.supabase
            .from('usuarios')
            .update({ meeting_status: status, current_driver: null })
            .eq('uid', window.currentVendorUid);

        await window.supabase.from('notifications').update({ handled: true }).eq('target_uid', window.currentVendorUid).eq('type', 'dropoff');
        m_showToast('Viagem concluída!', 'info');
    } catch (e) { console.error(e); }
}

window.closeModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('show');
};