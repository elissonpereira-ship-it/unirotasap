'use strict';

// ── CONSTANTES ────────────────────────────────────────────────────
const VEHICLE_CAPACITY = { carro: 4, moto: 1 };
const REIMBURSEMENT_RATE = { carro: 0.90, moto: 0.40 };
const PRESENCE_RADIUS_M = 150;
const RETURN_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutos
const AUTO_HOME_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

// ── ESTADO ────────────────────────────────────────────────────────
let currentMeetingRole = null;   // 'driver' | 'passenger' | 'individual'
let selectedPassengers = [];     // [{uid, name, address, lat, lng, ...}]
let driverVehicleType = 'carro';
let driverRealRoute = [];     // pontos GPS acumulados durante viagem
let meetingLocationData = null;   // {id, name, address, lat, lng, region}
let currentDriverUid = null;   // UID do motorista (visão carona)

let pickupListListener = null;
let driverInfoListener = null;
let passengerStateListener = null;
let availablePaxListener = null;
let roomCounts = {};

let returnTimerId = null;   // timer do countdown de retorno
let autoHomeTimerId = null;   // timer de auto-finalização

// ── HAVERSINE ─────────────────────────────────────────────────────
function _dist(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _haversineKm(pts) {
    let km = 0;
    for (let i = 1; i < pts.length; i++)
        km += _dist(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng) / 1000;
    return km;
}

// ── CONFIRM DIALOG ────────────────────────────────────────────────
function showConfirmDialog(title, sub, confirmLabel = 'Sim', cancelLabel = 'Não') {
    return new Promise(resolve => {
        document.getElementById('_cd')?.remove();
        const m = document.createElement('div');
        m.id = '_cd';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:6000;display:flex;align-items:flex-end;justify-content:center;padding:20px;backdrop-filter:blur(10px);';
        m.innerHTML = `<div style="width:100%;max-width:480px;background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:28px 24px;">
            <div style="font-size:1.1rem;font-weight:700;text-align:center;margin-bottom:8px;">${title}</div>
            <div style="font-size:0.82rem;color:var(--muted);text-align:center;margin-bottom:22px;">${sub}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <button id="_cd-no"  style="padding:14px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">${cancelLabel}</button>
                <button id="_cd-yes" style="padding:14px;border-radius:12px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:var(--danger);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">${confirmLabel}</button>
            </div></div>`;
        document.body.appendChild(m);
        document.getElementById('_cd-no').onclick = () => { m.remove(); resolve(false); };
        document.getElementById('_cd-yes').onclick = () => { m.remove(); resolve(true); };
    });
}

// ── NAVEGAÇÃO ─────────────────────────────────────────────────────
function showMeetingView(viewId) {
    document.getElementById('meeting-chat-alert')?.remove();
    ['meeting-role-select', 'meeting-location-select', 'meeting-passenger-waiting',
        'meeting-passenger-selected', 'meeting-driver-select', 'meeting-driver-route',
        'meeting-driver-return', 'meeting-individual']
        .forEach(v => document.getElementById(v)?.classList.add('hidden'));
    document.getElementById(viewId)?.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

// ── HARD RESET ────────────────────────────────────────────────────
async function MeetingHardReset() {
    // Cancela timers ativos
    if (returnTimerId) { clearTimeout(returnTimerId); returnTimerId = null; }
    if (autoHomeTimerId) { clearTimeout(autoHomeTimerId); autoHomeTimerId = null; }

    const db = supabase.database();
    if (pickupListListener && currentVendorUid)
        db.ref(`meeting/driverPickups/${currentVendorUid}`).off('value', pickupListListener);
    if (driverInfoListener && currentDriverUid)
        db.ref(`vendedores/${currentDriverUid}`).off('value', driverInfoListener);
    if (passengerStateListener && currentVendorUid)
        db.ref(`meeting/participants/${currentVendorUid}`).off('value', passengerStateListener);
    if (availablePaxListener)
        db.ref('meeting/participants').off('value', availablePaxListener);

    pickupListListener = driverInfoListener = passengerStateListener = availablePaxListener = null;
    currentMeetingRole = currentDriverUid = meetingLocationData = null;
    selectedPassengers = driverRealRoute = [];
    driverVehicleType = 'carro';

    ['btn-individual-confirm', 'btn-passenger-confirm-presence', 'btn-driver-confirm-presence']
        .forEach(id => { const b = document.getElementById(id); if (b) { b.classList.add('hidden'); b.disabled = true; } });
    ['individual-confirmed', 'passenger-reunion-status', 'driver-meeting-in-progress',
        'passenger-boarding-card', 'passenger-return-card']
        .forEach(id => document.getElementById(id)?.classList.add('hidden'));
    ['driver-pickup-list', 'driver-dropoff-list']
        .forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });

    if (currentVendorUid) {
        try {
            const s = await db.ref(`meeting/participants/${currentVendorUid}`).once('value');
            const p = s.val();
            if (p && p.status !== 'finished' && p.phase !== 'done')
                await db.ref(`meeting/participants/${currentVendorUid}`).remove();
        } catch (_) { }
    }
}

// ── CARREGAR TELA ─────────────────────────────────────────────────
function loadMeetingScreen() {
    if (!currentVendorUid) { setTimeout(loadMeetingScreen, 600); return; }
    supabase.database().ref(`meeting/participants/${currentVendorUid}`).once('value')
        .then(snap => {
            const d = snap.val();
            if (d && d.role && d.status !== 'finished' && d.phase !== 'done')
                d.locationId ? restoreMeetingState(d) : selectRole(d.role);
            else showMeetingView('meeting-role-select');
        })
        .catch(() => showMeetingView('meeting-role-select'));
}

// ── RESTAURAR ESTADO ──────────────────────────────────────────────
function restoreMeetingState(d) {
    currentMeetingRole = d.role;
    if (d.vehicleType) driverVehicleType = d.vehicleType;
    if (d.locationName) {
        meetingLocationData = {
            id: d.locationId, name: d.locationName,
            address: d.locationAddress || '', lat: d.lat, lng: d.lng, region: d.region || ''
        };
    }
    if (d.role === 'passenger') {
        if (!d.driverUid || d.embarkStatus === 'waiting' || d.embarkStatus === 'confirmed') {
            showMeetingView('meeting-passenger-waiting');
            const isConfirmed = d.embarkStatus === 'confirmed';
            document.getElementById('btn-passenger-confirm-location')?.classList.toggle('hidden', isConfirmed);
            document.getElementById('passenger-embark-confirmed-msg')?.classList.toggle('hidden', !isConfirmed);
        } else {
            showMeetingView('meeting-passenger-selected');
            listenForDriverInfo(d.driverUid);
            _passengerUI(d.embarkStatus, d.driverName);
        }
    } else if (d.role === 'driver') {
        if (d.phase === 'return' || d.phase === 'return_pending') { showMeetingView('meeting-driver-return'); loadDropoffList(); startAutoHomeTimer(); }
        else if (d.phase === 'meeting') { showMeetingView('meeting-driver-route'); showDriverMeetingInProgress(); loadPickupList(); }
        else { showMeetingView('meeting-driver-route'); loadPickupList(); }
    } else if (d.role === 'individual') {
        showMeetingView('meeting-individual');
        const el = document.getElementById('individual-location-details');
        if (el && d.locationName) el.innerHTML = `<strong>${d.locationName}</strong><br>${d.locationAddress || ''}`;
        if (d.presenceConfirmed) {
            document.getElementById('btn-individual-confirm')?.classList.add('hidden');
            document.getElementById('individual-confirmed')?.classList.remove('hidden');
        }
    }
}

function _passengerUI(status, dName) {
    const el = document.getElementById('passenger-embark-status');
    const wr = document.getElementById('passenger-driver-chat-wrap');
    const map = {
        invitePending: 'Motorista confirmou sua vaga. Aguarde no local combinado.',
        accepted_ride: `✓ Viagem confirmada com ${dName || 'Motorista'}! Aguarde no ponto de embarque.`,
        boarding_pending: '⏳ Motorista chegou! Confirme o embarque abaixo.',
        boarded: `✅ A bordo com ${dName || 'Motorista'}! Destino: reunião.`,
    };
    if (el) el.innerHTML = `<div>${map[status] || 'Acompanhe o trajeto.'}</div>`;
    if (wr) wr.style.display = (['accepted_ride', 'boarded'].includes(status)) ? 'flex' : 'none';
}

// ── SELEÇÃO DE PAPEL ──────────────────────────────────────────────
async function selectRole(role) {
    await MeetingHardReset();
    currentMeetingRole = role;
    showMeetingView('meeting-location-select');
    loadMeetingLocationsForSelection();
}

// ── LOCAIS DISPONÍVEIS ────────────────────────────────────────────
async function loadMeetingLocationsForSelection() {
    const c = document.getElementById('meeting-locations-suggestion-list');
    if (!c) return;
    c.innerHTML = '<div class="empty-state"><p>Carregando locais...</p></div>';
    try {
        const [uSnap, lSnap] = await Promise.all([
            supabase.database().ref(`usuarios/${currentVendorUid}`).once('value'),
            supabase.database().ref('meeting/locations').once('value'),
        ]);
        const ud = uSnap.val() || {};
        const locs = lSnap.val() || {};
        const city = (ud.address?.cidade || ud.city || '').toLowerCase();
        const reg = city.includes('rio') ? 'RJ' : 'ES';
        const list = Object.entries(locs).filter(([, l]) => !l.region || l.region === reg);

        if (!list.length) {
            c.innerHTML = `<div class="empty-state"><i data-lucide="info"></i><p>Sem locais para ${reg}.</p></div>`;
            lucide.createIcons(); return;
        }
        c.innerHTML = '';
        list.forEach(([id, loc]) => {
            const div = document.createElement('div');
            div.style.cssText = 'background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all 0.2s;margin-bottom:10px;';
            div.onmouseover = () => div.style.borderColor = 'var(--gold)';
            div.onmouseout = () => div.style.borderColor = 'var(--border)';
            div.onclick = () => confirmMeetingLocation(id, loc);
            div.innerHTML = `<div>
                <div style="font-weight:700;font-size:0.9rem;">${loc.name}</div>
                <div style="font-size:0.75rem;color:var(--muted);margin-top:4px;">${loc.address || ''}</div>
            </div><i data-lucide="chevron-right" style="color:var(--gold);width:18px;height:18px;flex-shrink:0;"></i>`;
            c.appendChild(div);
        });
        lucide.createIcons();
    } catch (e) { c.innerHTML = `<p style="color:var(--danger);padding:20px;">Erro: ${e.message}</p>`; }
}

// ── CONFIRMAR LOCAL ───────────────────────────────────────────────
async function confirmMeetingLocation(locId, loc) {
    if (!currentMeetingRole || !currentVendorUid) return;
    if (loc.lat == null || loc.lng == null) {
        showToast('Local sem coordenadas. Contacte o gestor.', 'error'); return;
    }
    meetingLocationData = { id: locId, ...loc };

    // Para carona: captura GPS atual como ponto de embarque
    const embarkLat = (currentMeetingRole === 'passenger' && lastLat) ? lastLat : null;
    const embarkLng = (currentMeetingRole === 'passenger' && lastLon) ? lastLon : null;

    const pd = {
        uid: currentVendorUid, name: currentVendorName, role: currentMeetingRole,
        vehicleType: driverVehicleType, embarkStatus: 'waiting', joinedAt: Date.now(),
        locationId: locId, locationName: loc.name, locationAddress: loc.address || '',
        region: loc.region || '', lat: loc.lat, lng: loc.lng,
        embarkLat, embarkLng,
        phase: 'idle', presenceConfirmed: false, status: 'active',
    };
    try {
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).set(pd);
        showToast(`Local: ${loc.name}`, 'success');

        if (currentMeetingRole === 'passenger') {
            showMeetingView('meeting-passenger-waiting');
            const isConfirmed = pd.embarkStatus === 'confirmed';
            document.getElementById('btn-passenger-confirm-location')?.classList.toggle('hidden', isConfirmed);
            document.getElementById('passenger-embark-confirmed-msg')?.classList.toggle('hidden', !isConfirmed);
            // Alerta ao carona para não mudar de lugar
            _showPassengerLocationAlert(embarkLat, embarkLng);
        } else if (currentMeetingRole === 'driver') {
            document.getElementById('btn-driver-confirm-presence')?.classList.remove('hidden');
            document.getElementById('driver-meeting-in-progress')?.classList.add('hidden');
            setDriverVehicle(driverVehicleType);
            showMeetingView('meeting-driver-select');
            selectedPassengers = [];
            updateSeatIndicator();
            loadAvailablePassengers();
        } else {
            document.getElementById('btn-individual-confirm')?.classList.remove('hidden');
            document.getElementById('individual-confirmed')?.classList.add('hidden');
            const el = document.getElementById('individual-location-details');
            if (el) el.innerHTML = `<strong>${loc.name}</strong><br>${loc.address || ''}`;
            showMeetingView('meeting-individual');
        }
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── ALERTA DE LOCAL FIXO PARA CARONA ─────────────────────────────
function _showPassengerLocationAlert(lat, lng) {
    const existing = document.getElementById('passenger-location-alert');
    if (existing) existing.remove();
    if (!lat) return;
    const alert = document.createElement('div');
    alert.id = 'passenger-location-alert';
    alert.style.cssText = `background:rgba(191,154,86,0.12);border:1px solid var(--gold);
        border-radius:14px;padding:14px 16px;margin:12px 0;display:flex;gap:12px;align-items:flex-start;`;
    alert.innerHTML = `
        <span style="font-size:1.2rem;flex-shrink:0;">📍</span>
        <div>
            <div style="font-weight:700;font-size:0.85rem;color:var(--gold);">Local de embarque registrado</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:4px;line-height:1.4;">
                Sua posição atual foi salva. <strong style="color:var(--text);">Aguarde exatamente neste local.</strong>
                O motorista será guiado até aqui.
            </div>
        </div>`;
    const waiting = document.getElementById('meeting-passenger-waiting');
    if (waiting) waiting.prepend(alert);
}

// ── VEÍCULO ───────────────────────────────────────────────────────
function setDriverVehicle(type) {
    driverVehicleType = type;
    const gold = '2px solid var(--gold)', norm = '2px solid var(--border)';
    const cEl = document.getElementById('vehicle-opt-carro'), mEl = document.getElementById('vehicle-opt-moto');
    if (cEl) cEl.style.border = type === 'carro' ? gold : norm;
    if (mEl) mEl.style.border = type === 'moto' ? gold : norm;
    const max = VEHICLE_CAPACITY[type] || 4;
    const capEl = document.getElementById('capacity-limit'); if (capEl) capEl.textContent = max;
    if (selectedPassengers.length > max) {
        selectedPassengers = selectedPassengers.slice(0, max);
        showToast(`Capacidade ajustada: ${max}`, 'info');
    }
    updateSeatIndicator();
    const c = document.getElementById('selected-count'); if (c) c.textContent = selectedPassengers.length;
    const b = document.getElementById('btn-start-driver-route'); if (b) b.disabled = !selectedPassengers.length;
    if (window.lucide) lucide.createIcons();
}

function updateSeatIndicator() {
    const c = document.getElementById('seat-indicator'); if (!c) return;
    const cap = VEHICLE_CAPACITY[driverVehicleType] || 4;
    let html = `<div class="seat driver-seat" title="Motorista"><i data-lucide="user" style="width:14px;"></i></div>`;
    for (let i = 1; i <= 4; i++) {
        if (i > cap) html += `<div class="seat" style="opacity:0.15;cursor:not-allowed;"></div>`;
        else if (i <= selectedPassengers.length) html += `<div class="seat taken" title="${selectedPassengers[i - 1]?.name || 'Carona'}"><i data-lucide="user-check" style="width:14px;color:var(--gold)"></i></div>`;
        else html += `<div class="seat empty"></div>`;
    }
    c.innerHTML = html;
    if (window.lucide) lucide.createIcons({ root: c });
}

// ── CARONAS DISPONÍVEIS ───────────────────────────────────────────
async function loadAvailablePassengers() {
    const mySnap = await supabase.database().ref(`meeting/participants/${currentVendorUid}`).once('value');
    const myLocId = mySnap.val()?.locationId;
    const list = document.getElementById('available-passengers-list');
    if (list) list.innerHTML = '<div class="empty-state"><p>Carregando...</p></div>';

    if (availablePaxListener) supabase.database().ref('meeting/participants').off('value', availablePaxListener);

    availablePaxListener = supabase.database().ref('meeting/participants').on('value', snap => {
        const all = snap.val() || {};
        const waiting = Object.values(all).filter(p =>
            p.role === 'passenger' && 
            (p.embarkStatus === 'waiting' || p.embarkStatus === 'confirmed') &&
            p.uid !== currentVendorUid && p.locationId === myLocId
        );
        if (!list) return;
        list.innerHTML = '';
        if (!waiting.length) {
            list.innerHTML = `<div class="empty-state"><i data-lucide="users"></i><p>Nenhum carona aguardando.</p>
                <button class="action-btn info" onclick="startDriverAlone()" style="margin-top:12px;">
                    <i data-lucide="arrow-right"></i> Seguir sem caronas</button></div>`;
            if (window.lucide) lucide.createIcons(); return;
        }
        waiting.forEach(p => {
            const sel = selectedPassengers.some(s => s.uid === p.uid);
            let dist = '';
            // Usa embarkLat se disponível, senão lat/lng do participante
            const pLat = p.embarkLat || p.lat;
            const pLng = p.embarkLng || p.lng;
            if (pLat && typeof lastLat !== 'undefined' && lastLat)
                dist = `<span class="dist-tag">${Math.round(_dist(lastLat, lastLon, pLat, pLng))}m</span>`;
            const div = document.createElement('div');
            div.className = `driver-item${sel ? ' selected' : ''}`;
            div.id = `pax-${p.uid}`;
            div.innerHTML = `<div>
                <div class="d-name">${p.name} ${dist}</div>
                <div class="d-sub">Aguardando carona</div>
            </div><i data-lucide="${sel ? 'check-circle' : 'circle'}" class="d-check" id="chk-${p.uid}" style="opacity:${sel ? 1 : 0.25}"></i>`;
            div.onclick = () => _togglePax(p);
            list.appendChild(div);
        });
        if (window.lucide) lucide.createIcons();
    });
}

function _togglePax(p) {
    const idx = selectedPassengers.findIndex(s => s.uid === p.uid);
    const max = VEHICLE_CAPACITY[driverVehicleType] || 4;
    if (idx >= 0) {
        selectedPassengers.splice(idx, 1);
        document.getElementById(`pax-${p.uid}`)?.classList.remove('selected');
        const c = document.getElementById(`chk-${p.uid}`);
        if (c) { c.setAttribute('data-lucide', 'circle'); c.style.opacity = '0.25'; }
    } else {
        if (selectedPassengers.length >= max) { showToast(`Máximo ${max} carona(s).`, 'error'); return; }
        selectedPassengers.push(p);
        document.getElementById(`pax-${p.uid}`)?.classList.add('selected');
        const c = document.getElementById(`chk-${p.uid}`);
        if (c) { c.setAttribute('data-lucide', 'check-circle'); c.style.opacity = '1'; }
    }
    const co = document.getElementById('selected-count'); if (co) co.textContent = selectedPassengers.length;
    const b = document.getElementById('btn-start-driver-route'); if (b) b.disabled = !selectedPassengers.length;
    updateSeatIndicator();
    if (window.lucide) lucide.createIcons();
}

async function autoSuggestPassengers() {
    if (!lastLat) { showToast('GPS inativo.', 'error'); return; }
    const btn = document.getElementById('btn-auto-suggest'), orig = btn?.innerHTML;
    if (btn) { btn.innerHTML = 'Calculando...'; btn.disabled = true; }
    try {
        const [aSnap, mSnap] = await Promise.all([
            supabase.database().ref('meeting/participants').once('value'),
            supabase.database().ref(`meeting/participants/${currentVendorUid}`).once('value'),
        ]);
        const locId = mSnap.val()?.locationId, max = VEHICLE_CAPACITY[driverVehicleType] || 4;
        let w = Object.values(aSnap.val() || {}).filter(p =>
            p.role === 'passenger' && 
            (p.embarkStatus === 'waiting' || p.embarkStatus === 'confirmed') &&
            p.locationId === locId && p.uid !== currentVendorUid &&
            (p.embarkLat || p.lat)
        );
        if (!w.length) { showToast('Sem caronas com GPS.', 'info'); return; }
        // Ordena pelo mais próximo do local de embarque confirmado
        w.forEach(p => p._d = _dist(lastLat, lastLon, p.embarkLat || p.lat, p.embarkLng || p.lng));
        w.sort((a, b) => a._d - b._d);
        selectedPassengers = w.slice(0, max);
        loadAvailablePassengers();
        updateSeatIndicator();
        const co = document.getElementById('selected-count'); if (co) co.textContent = selectedPassengers.length;
        const b = document.getElementById('btn-start-driver-route'); if (b) b.disabled = false;
        showToast(`${selectedPassengers.length} caronas sugeridos.`, 'success');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
    finally { if (btn) { btn.innerHTML = orig; btn.disabled = false; } }
}

// ── INICIAR ROTA ──────────────────────────────────────────────────
async function startDriverRoute() {
    if (!selectedPassengers.length) {
        showToast('Selecione caronas ou use "Seguir sem caronas".', 'error'); return;
    }
    await _initRoute(selectedPassengers);
}
async function startDriverAlone() { await _initRoute([]); }

async function _initRoute(passengers) {
    driverRealRoute = [];
    // Registra ponto inicial (casa do motorista)
    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'start', lat: lastLat, lng: lastLon, label: '🏠 Saída de casa', timestamp: Date.now() });

    // ── Rota Prevista ─────────────────────────────────────────────
    // Gerada agora com base nos pontos de embarque CONFIRMADOS dos caronas
    const pred = [];
    if (lastLat && lastLon)
        pred.push({ lat: lastLat, lng: lastLon, label: '🏠 Casa do motorista' });

    // Caronas (ida) — usa embarkLat se disponível (posição real de embarque)
    for (const p of passengers) {
        if (p.uid === currentVendorUid) continue;
        try {
            const s = await supabase.database().ref(`meeting/participants/${p.uid}`).once('value');
            const pd = s.val();
            const pLat = pd?.embarkLat || pd?.lat;
            const pLng = pd?.embarkLng || pd?.lng;
            if (pLat && pLng) pred.push({ lat: pLat, lng: pLng, label: `🔵 ${p.name} (embarque)` });
        } catch (_) { }
    }

    // Local de reunião
    if (meetingLocationData?.lat)
        pred.push({ lat: meetingLocationData.lat, lng: meetingLocationData.lng, label: `📍 ${meetingLocationData.name}` });

    // Caronas (retorno) — mesmo ponto de embarque = ponto de desembarque
    for (const p of [...passengers].reverse()) {
        if (p.uid === currentVendorUid) continue;
        try {
            const s = await supabase.database().ref(`meeting/participants/${p.uid}`).once('value');
            const pd = s.val();
            const pLat = pd?.embarkLat || pd?.lat;
            const pLng = pd?.embarkLng || pd?.lng;
            if (pLat && pLng) pred.push({ lat: pLat, lng: pLng, label: `🟡 ${p.name} (desembarque)` });
        } catch (_) { }
    }
    if (lastLat && lastLon)
        pred.push({ lat: lastLat, lng: lastLon, label: '🏠 Casa do motorista (chegada)' });

    const meetDate = new Date().toISOString().split('T')[0];

    // Salva rota prevista no banco — gestor vê imediatamente
    await supabase.database().ref(`meeting/history/${meetDate}/${currentVendorUid}`).set({
        driverName: currentVendorName, driverUid: currentVendorUid,
        vehicleType: driverVehicleType,
        predictedRoute: pred.filter(p => p.lat != null),
        passengerCount: passengers.length,
        startedAt: Date.now(), date: meetDate,
        status: 'in_progress',
    });

    await supabase.database().ref(`meeting/participants/${currentVendorUid}`)
        .update({ vehicleType: driverVehicleType, phase: 'route' });

    // Notifica caronas selecionados
    for (const p of passengers) {
        if (p.uid === currentVendorUid) continue;
        await Promise.all([
            supabase.database().ref(`meeting/notifications/${p.uid}`).set({
                type: 'pickup_request', driverUid: currentVendorUid,
                driverName: currentVendorName, handled: false, timestamp: Date.now()
            }),
            supabase.database().ref(`meeting/participants/${p.uid}`)
                .update({ driverUid: currentVendorUid, embarkStatus: 'invitePending' }),
            supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${p.uid}`).set({
                uid: p.uid, name: p.name, address: p.address || '',
                lat: p.embarkLat || p.lat || null, lng: p.embarkLng || p.lng || null,
                status: 'invitePending', order: passengers.indexOf(p)
            }),
        ]);
    }

    if (availablePaxListener) {
        supabase.database().ref('meeting/participants').off('value', availablePaxListener);
        availablePaxListener = null;
    }

    if (!passengers.length) {
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'meeting' });
        showMeetingView('meeting-driver-route');
        const c = document.getElementById('driver-pickup-list');
        if (c) c.innerHTML = '<div class="empty-state"><i data-lucide="car"></i><p>Indo sozinho. Siga ao local da reunião.</p></div>';
        document.getElementById('btn-driver-confirm-presence')?.classList.remove('hidden');
        showToast('Rota iniciada (sem caronas).', 'success');
    } else {
        showMeetingView('meeting-driver-route');
        loadPickupList();
        showToast('Rota iniciada! Aguardando confirmações dos caronas.', 'success');
    }

    // Inicia rastreamento da rota real (acumula pontos GPS a cada 30s)
    _startRealRouteTracking();
}

// ── RASTREAMENTO DA ROTA REAL ─────────────────────────────────────
let _routeTrackInterval = null;
function _startRealRouteTracking() {
    if (_routeTrackInterval) clearInterval(_routeTrackInterval);
    _routeTrackInterval = setInterval(() => {
        if (!lastLat || !lastLon) return;
        const last = driverRealRoute[driverRealRoute.length - 1];
        // Só registra se moveu mais de 50m desde o último ponto
        if (last && _dist(last.lat, last.lng, lastLat, lastLon) < 50) return;
        driverRealRoute.push({ type: 'waypoint', lat: lastLat, lng: lastLon, timestamp: Date.now() });
    }, 30000); // 30 segundos
}
function _stopRealRouteTracking() {
    if (_routeTrackInterval) { clearInterval(_routeTrackInterval); _routeTrackInterval = null; }
}

// ── CANCELAR ROTA (MOTORISTA) ─────────────────────────────────────
async function cancelDriver() {
    const ok = await showConfirmDialog('Cancelar?', 'Todos os caronas serão notificados.');
    if (!ok) return;
    _stopRealRouteTracking();
    for (const p of selectedPassengers) {
        if (p.uid === currentVendorUid) continue;
        await supabase.database().ref(`meeting/participants/${p.uid}`).update({ embarkStatus: 'waiting', driverUid: null });
        await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${p.uid}`).remove();
        await supabase.database().ref(`meeting/notifications/${p.uid}`).set({
            type: 'driverCancelled', driverName: currentVendorName, handled: false, timestamp: Date.now()
        });
    }
    if (availablePaxListener) { supabase.database().ref('meeting/participants').off('value', availablePaxListener); availablePaxListener = null; }
    if (pickupListListener) { supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).off('value', pickupListListener); pickupListListener = null; }
    await supabase.database().ref(`meeting/participants/${currentVendorUid}`).remove();
    currentMeetingRole = null; selectedPassengers = [];
    showMeetingView('meeting-role-select');
    showToast('Participação cancelada.', 'error');
}
const cancelDriverRoute = cancelDriver;

// ── LISTA DE EMBARQUE ─────────────────────────────────────────────
function loadPickupList() {
    if (pickupListListener)
        supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).off('value', pickupListListener);
    const c = document.getElementById('driver-pickup-list');
    const STATUS_LABEL = {
        invitePending: 'Aguardando aceite',
        accepted_ride: 'Confirmou ✓',
        boarding_pending: 'Chegou — Embarcando',
        boarded: 'A bordo ✓',
        refused: 'Recusou',
        not_boarded: 'Não embarcou'
    };
    const BADGE = {
        invitePending: 'waiting', accepted_ride: 'waiting',
        boarding_pending: 'waiting', boarded: 'picked',
        refused: 'refused', not_boarded: 'refused'
    };

    pickupListListener = supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`)
        .on('value', snap => {
            const raw = snap.val(), pks = raw ? Object.values(raw) : [];
            if (!c) return;
            c.innerHTML = '';
            if (!pks.length) {
                c.innerHTML = '<div class="empty-state"><p>Sem caronas na lista.</p></div>';
                document.getElementById('btn-driver-confirm-presence')?.classList.remove('hidden');
                return;
            }
            const done = pks.every(p => ['boarded', 'refused', 'not_boarded'].includes(p.status));
            document.getElementById('btn-driver-confirm-presence')?.classList.toggle('hidden', !done);

            pks.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(p => {
                const canPick = p.status === 'accepted_ride';
                const isPending = p.status === 'invitePending';
                const div = document.createElement('div');
                div.className = 'passenger-item';
                div.id = `pu-${p.uid}`;
                div.innerHTML = `
                    <div style="flex:1">
                        <div class="p-name">${p.name}</div>
                        <div class="p-addr">${p.address || ''}</div>
                        <div class="p-actions">
                            <button class="p-btn-small chat" id="dot-chat-${p.uid}"
                                onclick="openMeetingChat('${p.uid}','${p.name}')">
                                <i data-lucide="message-circle" style="display:inline;width:12px;height:12px"></i> Chat
                            </button>
                            ${canPick ? `
                            <button class="p-btn-small pickup" onclick="driverRequestBoarding('${p.uid}','${p.name}')">
                                <i data-lucide="map-pin" style="display:inline;width:12px;height:12px"></i> Embarque
                            </button>` : ''}
                            ${(canPick || isPending) ? `
                            <button class="p-btn-small drop" style="background:rgba(239,68,68,0.1);"
                                onclick="driverMarkNoShow('${p.uid}','${p.name}')">
                                <i data-lucide="user-x" style="display:inline;width:12px;height:12px"></i> Furo
                            </button>` : ''}
                        </div>
                    </div>
                    <span class="p-status-badge ${BADGE[p.status] || 'waiting'}">${STATUS_LABEL[p.status] || 'Aguardando'}</span>`;
                c.appendChild(div);
                listenForMeetingChatMessages(p.uid);
            });
            if (window.lucide) lucide.createIcons();
            updateUniversalPresence();
        });
}

async function driverRequestBoarding(pUid, pName) {
    // Registra ponto de embarque na rota real
    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'pickup', lat: lastLat, lng: lastLon, label: `🔵 ${pName} — local de embarque`, timestamp: Date.now() });
    await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ status: 'boarding_pending' });
    await supabase.database().ref(`meeting/notifications/${pUid}`).set({
        type: 'boardingrequest', driverUid: currentVendorUid,
        driverName: currentVendorName, handled: false, timestamp: Date.now()
    });
    showToast(`Notificação de embarque enviada para ${pName}.`, 'success');
}

// ── NO-SHOW (FURO DO CARONA) ──────────────────────────────────────
async function driverMarkNoShow(pUid, pName) {
    const ok = await showConfirmDialog(
        '⚠️ Confirmar Furo?',
        `${pName} não apareceu no ponto de embarque?`,
        'Sim, confirmar furo', 'Cancelar'
    );
    if (!ok) return;

    // Remove carona da lista
    await supabase.database().ref(`meeting/notifications/${pUid}`).set({
        type: 'noShow', driverName: currentVendorName, handled: false, timestamp: Date.now()
    });
    await supabase.database().ref(`meeting/participants/${pUid}`).update({ driverUid: null, embarkStatus: 'waiting' });
    await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).remove();

    // Registra no histórico para o gestor
    const today = new Date().toISOString().split('T')[0];
    await supabase.database().ref(`meeting/history/${today}/${currentVendorUid}/noShows/${pUid}`).set({
        name: pName, timestamp: Date.now()
    });
    // Notifica gestor com alerta de furo
    await supabase.database().ref(`meeting/gestor_alerts`).push({
        type: 'no_show',
        driverUid: currentVendorUid, driverName: currentVendorName,
        passengerUid: pUid, passengerName: pName,
        timestamp: Date.now(), date: today
    });

    showToast(`${pName} removido. Gestor notificado.`, 'info');
}

// ── PRESENÇA ──────────────────────────────────────────────────────
async function updateUniversalPresence() {
    if (!meetingLocationData?.lat || !lastLat) return;
    try {
        const ph = await supabase.database().ref(`meeting/participants/${currentVendorUid}/phase`).once('value');
        if (['meeting', 'return', 'return_pending', 'done'].includes(ph.val())) return;
    } catch (_) { }
    const near = _dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) < PRESENCE_RADIUS_M;
    const map = { individual: 'btn-individual-confirm', passenger: 'btn-passenger-confirm-presence', driver: 'btn-driver-confirm-presence' };
    const b = document.getElementById(map[currentMeetingRole]);
    if (!b) return;
    b.classList.toggle('hidden', !near);
    b.disabled = !near;
    b.style.opacity = near ? '1' : '0.5';
}

async function individualConfirmPresence() {
    if (!meetingLocationData || !lastLat) { showToast('GPS inativo.', 'error'); return; }
    if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) {
        showToast('Aproxime-se do local.', 'error'); return;
    }
    try {
        const today = new Date().toISOString().split('T')[0];
        await supabase.database().ref(`meeting/attendance/${today}/${currentVendorUid}`).set({
            name: currentVendorName, role: 'individual', locationId: meetingLocationData.id,
            locationName: meetingLocationData.name, region: meetingLocationData.region || '', confirmedAt: Date.now()
        });
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ presenceConfirmed: true, phase: 'done' });
        document.getElementById('btn-individual-confirm')?.classList.add('hidden');
        document.getElementById('individual-confirmed')?.classList.remove('hidden');
        showToast('Presença confirmada!', 'success');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

function cancelIndividual() {
    supabase.database().ref(`meeting/participants/${currentVendorUid}`).remove();
    currentMeetingRole = null;
    showMeetingView('meeting-role-select');
}

async function passengerConfirmPresence() {
    if (!meetingLocationData || !lastLat) { showToast('GPS inativo.', 'error'); return; }
    if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) {
        showToast('Aproxime-se do local.', 'error'); return;
    }
    try {
        const today = new Date().toISOString().split('T')[0];
        await supabase.database().ref(`meeting/attendance/${today}/${currentVendorUid}`).set({
            name: currentVendorName, role: 'passenger', driverUid: currentDriverUid || 'none',
            locationId: meetingLocationData.id, locationName: meetingLocationData.name,
            region: meetingLocationData.region || '', confirmedAt: Date.now()
        });
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ presenceConfirmed: true });
        document.getElementById('btn-passenger-confirm-presence')?.classList.add('hidden');
        document.getElementById('passenger-reunion-status')?.classList.remove('hidden');
        showToast('Presença confirmada!', 'success');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function driverConfirmPresence() {
    if (!meetingLocationData || !lastLat) { showToast('GPS inativo.', 'error'); return; }
    if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) {
        showToast('Aproxime-se do local.', 'error'); return;
    }
    try {
        if (lastLat && lastLon)
            driverRealRoute.push({ type: 'meeting', lat: lastLat, lng: lastLon, label: '📍 Chegada à reunião', timestamp: Date.now() });
        const today = new Date().toISOString().split('T')[0];
        await supabase.database().ref(`meeting/attendance/${today}/${currentVendorUid}`).set({
            name: currentVendorName, role: 'driver', vehicleType: driverVehicleType,
            locationId: meetingLocationData.id, locationName: meetingLocationData.name,
            region: meetingLocationData.region || '', confirmedAt: Date.now()
        });
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'meeting', presenceConfirmed: true });
        document.getElementById('btn-driver-confirm-presence')?.classList.add('hidden');
        showDriverMeetingInProgress();
        showToast('Presença confirmada!', 'success');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

function showDriverMeetingInProgress() {
    document.getElementById('driver-meeting-in-progress')?.classList.remove('hidden');
    document.getElementById('btn-driver-confirm-presence')?.classList.add('hidden');
}

// ── ENCERRAR REUNIÃO → RETORNO ────────────────────────────────────
async function endMeeting() {
    const ok = await showConfirmDialog(
        'Encerrar Reunião?',
        'Será enviado pedido de retorno para todos os seus caronas.'
    );
    if (!ok) return;
    await _sendReturnRequests();
}

async function _sendReturnRequests() {
    try {
        showLoading(true);
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'return_pending' });

        const snap = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
        const pickups = snap.val() || {};
        const boarded = Object.values(pickups).filter(p => p.status === 'boarded');

        for (const p of boarded) {
            await supabase.database().ref(`meeting/participants/${p.uid}`).update({ returnStatus: 'pending' });
            await supabase.database().ref(`meeting/notifications/${p.uid}`).set({
                type: 'returnConfirm', driverUid: currentVendorUid,
                driverName: currentVendorName, handled: false, timestamp: Date.now()
            });
        }

        showMeetingView('meeting-driver-return');
        loadDropoffList();
        if (boarded.length > 0) {
            startReturnCountdown();
            showToast(`Solicitação enviada para ${boarded.length} carona(s).`, 'success');
        } else {
            // Sem caronas: vai direto para retorno
            await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'return' });
            showToast('Nenhum carona a bordo. Pode retornar.', 'info');
            document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden');
        }
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
    finally { showLoading(false); }
}

// ── REENVIAR SOLICITAÇÃO DE RETORNO ───────────────────────────────
async function resendReturnRequest() {
    const snap = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
    const pickups = snap.val() || {};
    const pending = Object.values(pickups).filter(p => p.status === 'boarded');
    if (!pending.length) { showToast('Sem caronas pendentes.', 'info'); return; }
    for (const p of pending) {
        await supabase.database().ref(`meeting/notifications/${p.uid}`).set({
            type: 'returnConfirm', driverUid: currentVendorUid,
            driverName: currentVendorName, handled: false, timestamp: Date.now()
        });
    }
    showToast(`Reenvio feito para ${pending.length} carona(s).`, 'success');
    // Reinicia o countdown
    startReturnCountdown();
}

// ── COUNTDOWN DE RETORNO (5 min) ──────────────────────────────────
function startReturnCountdown() {
    if (returnTimerId) clearTimeout(returnTimerId);
    document.getElementById('return-countdown-banner')?.remove();

    const banner = document.createElement('div');
    banner.id = 'return-countdown-banner';
    banner.style.cssText = `background:rgba(191,154,86,0.15);border:1px solid var(--gold);
        border-radius:12px;padding:12px 16px;margin-bottom:14px;`;

    let remaining = RETURN_TIMEOUT_MS / 1000;
    const render = () => {
        const m = Math.floor(remaining / 60), s = remaining % 60;
        banner.innerHTML = `
            <div style="font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:6px;">
                ⏱️ Aguardando caronas — ${m}:${String(s).padStart(2, '0')}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button onclick="startReturnRouteNow()" style="flex:1;padding:10px;background:var(--gold);
                    border:none;border-radius:10px;color:var(--bg);font-weight:700;font-size:0.82rem;cursor:pointer;">
                    🚀 Iniciar Agora
                </button>
                <button onclick="resendReturnRequest()" style="padding:10px 14px;background:rgba(255,255,255,0.06);
                    border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:0.78rem;cursor:pointer;">
                    🔁 Reenviar
                </button>
            </div>`;
    };
    render();

    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) clearInterval(interval);
        else render();
    }, 1000);

    const dropoffContainer = document.getElementById('driver-dropoff-list');
    if (dropoffContainer) {
        const old = document.getElementById('return-countdown-banner');
        if (old) old.remove();
        dropoffContainer.prepend(banner);
    }

    returnTimerId = setTimeout(() => {
        clearInterval(interval);
        document.getElementById('return-countdown-banner')?.remove();
        showToast('Tempo esgotado. Iniciando retorno com quem confirmou.', 'info');
        startReturnRouteNow();
    }, RETURN_TIMEOUT_MS);
}

// ── INICIAR RETORNO AGORA ─────────────────────────────────────────
async function startReturnRouteNow() {
    if (returnTimerId) { clearTimeout(returnTimerId); returnTimerId = null; }
    document.getElementById('return-countdown-banner')?.remove();

    const snap = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
    const pickups = snap.val() || {};

    // Remove quem não aceitou o retorno
    for (const pUid in pickups) {
        const pSnap = await supabase.database().ref(`meeting/participants/${pUid}`).once('value');
        const pData = pSnap.val();
        if (!pData || pData.returnStatus !== 'accepted') {
            await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).remove();
        }
    }

    await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'return' });

    // Registra ponto de partida do retorno
    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'return_start', lat: lastLat, lng: lastLon, label: '🔄 Início do retorno', timestamp: Date.now() });

    showToast('Trajeto de retorno iniciado!', 'success');

    // Abre Google Maps com rota de retorno
    openDriverMapRoute(true);

    // Inicia timer de auto-finalização (2h)
    startAutoHomeTimer();

    loadDropoffList();
}

// ── AUTO-FINALIZAÇÃO ──────────────────────────────────────────────
function startAutoHomeTimer() {
    if (autoHomeTimerId) clearTimeout(autoHomeTimerId);
    autoHomeTimerId = setTimeout(async () => {
        // Verifica se o motorista ainda não finalizou
        try {
            const snap = await supabase.database().ref(`meeting/participants/${currentVendorUid}`).once('value');
            const phase = snap.val()?.phase;
            if (phase !== 'done' && phase !== 'finished') {
                showToast('Finalizando automaticamente por inatividade.', 'info');
                await driverArrivedHome();
            }
        } catch (_) { }
    }, AUTO_HOME_TIMEOUT_MS);
}

// ── LISTA DE DESEMBARQUE ──────────────────────────────────────────
async function loadDropoffList() {
    const snap = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
    const pks = Object.values(snap.val() || {}).filter(p => p.status === 'boarded');
    const c = document.getElementById('driver-dropoff-list'); if (!c) return;

    // Remove banner do countdown ao recarregar
    const banner = document.getElementById('return-countdown-banner');

    c.innerHTML = '';
    if (banner) c.appendChild(banner);

    if (!pks.length) {
        document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden');
        c.innerHTML += '<div class="empty-state"><p>Nenhum passageiro a bordo.</p></div>';
        return;
    }

    const allDone = pks.every(p => p.dropoffStatus === 'confirmed' || p.dropoffStatus === 'forced');
    if (allDone) document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden');

    pks.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(p => {
        const done = p.dropoffStatus === 'confirmed' || p.dropoffStatus === 'forced';
        const div = document.createElement('div');
        div.className = 'passenger-item';
        div.id = `do-${p.uid}`;
        div.innerHTML = `
            <div style="flex:1">
                <div class="p-name">${p.name}</div>
                <div class="p-actions">${!done ? `
                    <button class="p-btn-small pickup" onclick="driverDropOff('${p.uid}','${p.name}')">
                        <i data-lucide="map-pin"></i> Desembarque
                    </button>
                    <button class="p-btn-small drop" style="background:rgba(239,68,68,0.15);"
                        onclick="driverForceDropOff('${p.uid}','${p.name}')">
                        <i data-lucide="alert-triangle"></i> Forçar
                    </button>` : ''}
                </div>
            </div>
            <span class="p-status-badge ${done ? 'dropped' : 'waiting'}">
                ${done ? (p.dropoffStatus === 'forced' ? 'Forçado' : 'Desembarcou') : 'A entregar'}
            </span>`;
        c.appendChild(div);
    });
    if (window.lucide) lucide.createIcons();
}

async function driverDropOff(pUid, pName) {
    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'dropoff', lat: lastLat, lng: lastLon, label: `🟡 ${pName} desembarcou`, timestamp: Date.now() });
    await supabase.database().ref(`meeting/notifications/${pUid}`).set({
        type: 'dropoff_request', driverUid: currentVendorUid,
        driverName: currentVendorName, handled: false, timestamp: Date.now()
    });
    showToast(`Notificação enviada para ${pName}.`, 'success');
    setTimeout(() => loadDropoffList(), 5000);
}

async function driverForceDropOff(pUid, pName) {
    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'dropoff_forced', lat: lastLat, lng: lastLon, label: `⚠️ ${pName} desembarque forçado`, timestamp: Date.now() });
    await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ dropoffStatus: 'forced' });
    await supabase.database().ref(`meeting/participants/${pUid}`).update({ embarkStatus: 'finished', status: 'finished' });
    showToast(`Forçado: ${pName}.`, 'info');
    setTimeout(() => loadDropoffList(), 500);
}

// ── CHEGOU EM CASA ────────────────────────────────────────────────
async function driverArrivedHome() {
    _stopRealRouteTracking();
    if (autoHomeTimerId) { clearTimeout(autoHomeTimerId); autoHomeTimerId = null; }

    const snap = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
    const pks = snap.val() || {};
    const pending = Object.values(pks).filter(p => p.status === 'boarded' && !p.dropoffStatus);

    if (pending.length) {
        const ok = await showConfirmDialog(
            `${pending.length} passageiro(s) ainda a bordo`,
            'Forçar desembarque e finalizar viagem?'
        );
        if (!ok) return;
        for (const p of pending) await driverForceDropOff(p.uid, p.name);
    }

    if (lastLat && lastLon)
        driverRealRoute.push({ type: 'end', lat: lastLat, lng: lastLon, label: '🏠 Chegou em casa', timestamp: Date.now() });

    // Calcula km real
    const validRoute = driverRealRoute.filter(p => p.lat && p.lng);
    let km = _haversineKm(validRoute);
    const rate = REIMBURSEMENT_RATE[driverVehicleType] || 0.90;
    const reimb = km * rate;
    const today = new Date().toISOString().split('T')[0];

    await supabase.database().ref(`meeting/history/${today}/${currentVendorUid}`).update({
        passengers: pks,
        vehicleType: driverVehicleType,
        realRoute: driverRealRoute,
        totalKm: parseFloat(km.toFixed(2)),
        reimbursement: parseFloat(reimb.toFixed(2)),
        completedAt: Date.now(),
        date: today,
        status: 'completed',
    });

    await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ status: 'finished', phase: 'done' });
    await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).remove();

    showToast(`Finalizado! ${km.toFixed(1)} km · R$ ${reimb.toFixed(2)}`, 'success');

    // Mostra resumo da viagem por 5 segundos antes de resetar
    _showTripSummary(km, reimb);

    driverRealRoute = []; selectedPassengers = []; currentMeetingRole = null;
    if (typeof loadEconomyStats === 'function') loadEconomyStats();
}

function _showTripSummary(km, reimb) {
    const existing = document.getElementById('trip-summary-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'trip-summary-banner';
    banner.style.cssText = `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
        background:var(--surface);border:1px solid var(--gold);border-radius:20px;
        padding:20px 28px;z-index:5000;text-align:center;min-width:260px;
        box-shadow:0 8px 30px rgba(0,0,0,0.5);animation:slideUp 0.3s ease;`;
    banner.innerHTML = `
        <div style="font-size:1.5rem;margin-bottom:8px;">🏁</div>
        <div style="font-weight:800;font-size:1rem;margin-bottom:4px;">Viagem Concluída!</div>
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">
            ${km.toFixed(1)} km percorridos
        </div>
        <div style="font-size:1.4rem;font-weight:800;color:var(--gold);">
            R$ ${reimb.toFixed(2)}
        </div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">a ser reembolsado</div>`;
    document.body.appendChild(banner);
    setTimeout(() => {
        banner.style.transition = 'opacity 0.5s';
        banner.style.opacity = '0';
        setTimeout(() => { banner.remove(); showMeetingView('meeting-role-select'); }, 500);
    }, 5000);
}

// ── GOOGLE MAPS ───────────────────────────────────────────────────
async function openDriverMapRoute(isReturn = false) {
    if (!lastLat || !lastLon) { showToast('GPS inativo.', 'error'); return; }
    if (!meetingLocationData?.lat) { showToast('Local não definido.', 'error'); return; }

    let origin, dest, wps = [];

    if (!isReturn) {
        origin = `${lastLat},${lastLon}`;
        dest = `${meetingLocationData.lat},${meetingLocationData.lng}`;
        const s = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
        for (const [uid, p] of Object.entries(s.val() || {})) {
            if (['boarded', 'refused', 'not_boarded'].includes(p.status)) continue;
            // Usa ponto de embarque confirmado do carona
            const ps = await supabase.database().ref(`meeting/participants/${uid}`).once('value');
            const pd = ps.val();
            const lat = pd?.embarkLat || pd?.lat;
            const lng = pd?.embarkLng || pd?.lng;
            if (lat && lng) wps.push(`${lat},${lng}`);
        }
    } else {
        origin = `${meetingLocationData.lat},${meetingLocationData.lng}`;
        dest = `${lastLat},${lastLon}`; // Casa do motorista
        const s = await supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
        for (const [uid, p] of Object.entries(s.val() || {})) {
            if (p.status !== 'boarded') continue;
            if (p.dropoffStatus === 'confirmed' || p.dropoffStatus === 'forced') continue;
            const ps = await supabase.database().ref(`meeting/participants/${uid}`).once('value');
            const pd = ps.val();
            const lat = pd?.embarkLat || pd?.lat;
            const lng = pd?.embarkLng || pd?.lng;
            if (lat && lng) wps.push(`${lat},${lng}`);
        }
    }

    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
    if (wps.length) url += `&waypoints=${wps.join('|')}`;
    window.open(url, '_blank');
}

// ── FLUXO DO CARONA ───────────────────────────────────────────────
function cancelPassengerWaiting() {
    showConfirmDialog('Sair da fila?', 'Você perderá a vaga de carona.').then(async ok => {
        if (!ok) return;
        const s = await supabase.database().ref(`meeting/participants/${currentVendorUid}`).once('value');
        const d = s.val();
        if (d?.driverUid) {
            await supabase.database().ref(`meeting/driverPickups/${d.driverUid}/${currentVendorUid}`).remove();
            await supabase.database().ref(`meeting/notifications/${d.driverUid}`).set({
                type: 'passengerCancelled', passengerUid: currentVendorUid,
                passengerName: currentVendorName, handled: false, timestamp: Date.now()
            });
        }
        if (passengerStateListener) {
            supabase.database().ref(`meeting/participants/${currentVendorUid}`).off('value', passengerStateListener);
            passengerStateListener = null;
        }
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).remove();
        currentMeetingRole = currentDriverUid = null;
        showMeetingView('meeting-role-select');
        showToast('Participação cancelada.', 'error');
    });
}

async function passengerConfirmBoarding() {
    try {
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ embarkStatus: 'boarded' });
        if (currentDriverUid)
            await supabase.database().ref(`meeting/driverPickups/${currentDriverUid}/${currentVendorUid}`).update({ status: 'boarded' });
        document.getElementById('passenger-boarding-card')?.classList.add('hidden');
        const el = document.getElementById('passenger-embark-status');
        if (el) el.innerHTML = `<div style="color:var(--success);font-weight:700">✅ Você está no carro!</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:4px;">Aguarde chegar ao local da reunião para confirmar presença.</div>`;
        showToast('Embarque confirmado!', 'success');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function passengerAcceptReturn(accepted) {
    try {
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({
            returnStatus: accepted ? 'accepted' : 'declined'
        });
        document.getElementById('passenger-return-card')?.classList.add('hidden');
        if (accepted) {
            showToast('Retorno confirmado! O motorista vai te buscar.', 'success');
        } else {
            showToast('Você voltará por conta própria. Boa sorte!', 'info');
            // Finaliza participação do carona
            setTimeout(async () => {
                await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update({ status: 'finished', phase: 'done' });
                currentMeetingRole = null;
                showMeetingView('meeting-role-select');
            }, 2000);
        }
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

function listenForDriverInfo(driverUid) {
    currentDriverUid = driverUid;
    if (driverInfoListener) supabase.database().ref(`vendedores/${driverUid}`).off('value', driverInfoListener);
    driverInfoListener = supabase.database().ref(`vendedores/${driverUid}`).on('value', snap => {
        const d = snap.val(); if (!d) return;
        const n = document.getElementById('passenger-driver-name');
        if (n) n.textContent = `Motorista: ${d.name || driverUid}`;
        if (d.lat && lastLat) {
            const dist = _dist(lastLat, lastLon, d.lat, d.lon || d.lng);
            const eta = Math.round((dist / 1000) / 40 * 60);
            const e = document.getElementById('passenger-eta-text');
            if (e) e.textContent = `🚗 ${Math.round(dist)}m — ~${eta} min`;
        }
    });

    if (passengerStateListener)
        supabase.database().ref(`meeting/participants/${currentVendorUid}`).off('value', passengerStateListener);
    passengerStateListener = supabase.database().ref(`meeting/participants/${currentVendorUid}`).on('value', snap => {
        const d = snap.val(); if (!d) return;
        const wr = document.getElementById('passenger-driver-chat-wrap');
        const st = document.getElementById('passenger-embark-status');
        switch (d.embarkStatus) {
            case 'invitePending': case 'selected':
                showMeetingView('meeting-passenger-selected');
                if (wr) wr.style.display = 'none';
                if (st) st.innerHTML = '<div>Motorista está a caminho. Aguarde no ponto de embarque.</div>';
                break;
            case 'accepted_ride':
                showMeetingView('meeting-passenger-selected');
                if (wr) wr.style.display = 'flex';
                if (st) st.innerHTML = `<div style="color:var(--gold);font-weight:700">✓ Vaga confirmada!</div>
                    <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">Aguarde no local de embarque cadastrado.</div>`;
                break;
            case 'boarding_pending':
                document.getElementById('passenger-boarding-card')?.classList.remove('hidden');
                if (st) st.innerHTML = `<div style="color:var(--info);font-weight:700">⏳ Motorista chegou!</div>
                    <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">Confirme o embarque abaixo.</div>`;
                break;
            case 'boarded':
                showMeetingView('meeting-passenger-selected');
                if (wr) wr.style.display = 'flex';
                document.getElementById('passenger-boarding-card')?.classList.add('hidden');
                if (st) st.innerHTML = `<div style="color:var(--success);font-weight:700">✅ A bordo!</div>
                    <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">No carro de ${d.driverName || 'Motorista'}.</div>`;
                updateUniversalPresence(); break;
            case 'waiting':
                if (currentMeetingRole === 'passenger') {
                    currentDriverUid = null;
                    showMeetingView('meeting-passenger-waiting');
                    showToast('Motorista cancelou. Aguardando outro.', 'error');
                } break;
            case 'finished': currentMeetingRole = null; showMeetingView('meeting-role-select'); break;
        }
    });
    listenForMeetingChatMessages(driverUid);
}

// ── NOTIFICAÇÕES ──────────────────────────────────────────────────
function listenForMeetingNotifications(uid) {
    supabase.database().ref(`meeting/notifications/${uid}`).on('value', async snap => {
        const d = snap.val(); if (!d || d.handled) return;
        switch (d.type) {
            case 'pickup_request':
                if (currentMeetingRole !== 'driver') {
                    showMeetingView('meeting-passenger-selected');
                    listenForDriverInfo(d.driverUid);
                    await supabase.database().ref(`meeting/participants/${uid}`)
                        .update({ driverUid: d.driverUid, driverName: d.driverName, embarkStatus: 'accepted_ride' });
                    await supabase.database().ref(`meeting/driverPickups/${d.driverUid}/${uid}`)
                        .update({ status: 'accepted_ride' });
                    _notify(d.driverName, 'Motorista confirmou sua vaga! Aguarde no ponto de embarque.', 'meeting', { uid: d.driverUid, name: d.driverName });
                } break;
            case 'boardingrequest':
                showToast(`${d.driverName} chegou! Confirme o embarque.`, 'info');
                document.getElementById('passenger-boarding-card')?.classList.remove('hidden');
                break;
            case 'returnConfirm':
                showToast('Motorista quer te levar de volta. Confirme!', 'info');
                document.getElementById('passenger-return-card')?.classList.remove('hidden');
                updateUniversalPresence();
                break;
            case 'return_started':
                showToast('Reunião encerrada. Prepare-se para o retorno.', 'info');
                document.getElementById('passenger-return-card')?.classList.remove('hidden');
                updateUniversalPresence();
                break;
            case 'dropoff_request':
                showToast('Você chegou ao destino? Confirme o desembarque.', 'info');
                updateUniversalPresence();
                break;
            case 'driverCancelled':
                showToast(`Motorista ${d.driverName} cancelou.`, 'error');
                currentDriverUid = null; showMeetingView('meeting-passenger-waiting');
                break;
            case 'noShow':
                showToast('Motorista marcou você como ausente.', 'error');
                currentMeetingRole = null; showMeetingView('meeting-role-select');
                break;
        }
        await supabase.database().ref(`meeting/notifications/${uid}`).update({ handled: true });
    });
}

function _notify(sender, text, type, data) {
    if (typeof showGlobalNotification === 'function')
        showGlobalNotification(sender, text, type, data);
}

// ── CHAT ──────────────────────────────────────────────────────────
let meetingChatPartnerUid = null;

function listenForMeetingChatMessages(pUid) {
    const today = new Date().toISOString().split('T')[0];
    const rk = today + '_' + [currentVendorUid, pUid].sort().join('_');
    supabase.database().ref(`meeting/chats/${rk}`).on('value', snap => {
        const all = snap.val() ? Object.values(snap.val()) : [];
        const n = all.length, prev = roomCounts[rk] || 0;
        if (n > prev) {
            const last = all[n - 1];
            if (last.senderUid !== currentVendorUid) {
                const open = document.getElementById('meeting-chat-modal')?.style.display === 'flex' && meetingChatPartnerUid === pUid;
                if (!open) {
                    _notify(last.senderName, last.text, 'meeting', { uid: pUid, name: last.senderName });
                    document.getElementById(`dot-chat-${pUid}`)?.classList.add('active');
                    if (pUid === currentDriverUid) document.getElementById('btn-passenger-chat-driver')?.classList.add('active');
                }
            }
        }
        roomCounts[rk] = n;
        if (meetingChatPartnerUid === pUid) _renderChat(all);
    });
}

function _renderChat(msgs) {
    const c = document.getElementById('meeting-chat-messages'); if (!c) return;
    c.innerHTML = '';
    msgs.forEach(m => {
        const me = m.senderUid === currentVendorUid;
        const b = document.createElement('div');
        b.style.cssText = `max-width:80%;padding:10px 14px;border-radius:16px;font-size:0.88rem;
            line-height:1.45;word-wrap:break-word;align-self:${me ? 'flex-end' : 'flex-start'};
            background:${me ? 'var(--gold)' : 'var(--surface2)'};color:${me ? 'var(--bg)' : 'var(--text)'};
            ${me ? 'border-bottom-right-radius:4px;' : 'border-bottom-left-radius:4px;'}`;
        b.innerHTML = `<div>${m.text}</div>
            <span style="font-size:0.6rem;opacity:0.6;margin-top:4px;display:block;text-align:right;">
                ${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>`;
        c.appendChild(b);
    });
    c.scrollTop = c.scrollHeight;
}

function openMeetingChat(pUid, pName) {
    meetingChatPartnerUid = pUid;
    document.getElementById(`dot-chat-${pUid}`)?.classList.remove('active');
    if (pUid === currentDriverUid) document.getElementById('btn-passenger-chat-driver')?.classList.remove('active');
    const t = document.getElementById('meeting-chat-title'); if (t) t.textContent = '💬 ' + pName;
    document.getElementById('meeting-chat-modal').style.display = 'flex';
    document.getElementById('meeting-chat-messages').innerHTML = '';
    document.getElementById('meeting-chat-input').value = '';
    listenForMeetingChatMessages(pUid);
    if (window.lucide) lucide.createIcons();
}

async function sendMeetingChatMessage() {
    const input = document.getElementById('meeting-chat-input');
    const text = input?.value.trim();
    if (!text || !meetingChatPartnerUid) return;
    const today = new Date().toISOString().split('T')[0];
    const rk = today + '_' + [currentVendorUid, meetingChatPartnerUid].sort().join('_');
    await supabase.database().ref(`meeting/chats/${rk}`).push({
        senderUid: currentVendorUid, senderName: currentVendorName, text, timestamp: Date.now()
    });
    if (input) input.value = '';
}

function closeMeetingChat() {
    meetingChatPartnerUid = null;
    document.getElementById('meeting-chat-modal').style.display = 'none';
    document.getElementById('meeting-chat-alert')?.remove();
    roomCounts = {};
}

function openMeetingChatWithDriver() {
    if (!currentDriverUid) { showToast('Motorista não identificado.', 'error'); return; }
    const n = document.getElementById('passenger-driver-name')?.textContent?.replace('Motorista: ', '') || 'Motorista';
    openMeetingChat(currentDriverUid, n);
}

// ── HISTÓRICO DO VENDEDOR ─────────────────────────────────────────
async function loadMyMeetingHistory() {
    const c = document.getElementById('my-meeting-history-list'); if (!c) return;
    c.innerHTML = '<div class="empty-state"><p>Carregando...</p></div>';
    try {
        const [hSnap, aSnap] = await Promise.all([
            supabase.database().ref('meeting/history').once('value'),
            supabase.database().ref('meeting/attendance').once('value'),
        ]);
        const hist = hSnap.val() || {}, att = aSnap.val() || {}, items = [];

        Object.entries(hist).forEach(([date, drivers]) => {
            if (drivers[currentVendorUid]) {
                const d = drivers[currentVendorUid];
                const pax = d.passengers ? Object.values(d.passengers) : [];
                items.push({
                    date, role: 'driver',
                    km: d.totalKm, reimb: d.reimbursement,
                    vehicle: d.vehicleType || 'carro',
                    passengers: pax.filter(p => p.status === 'boarded' || p.dropoffStatus),
                    noShows: d.noShows ? Object.values(d.noShows) : [],
                    status: d.status || 'completed',
                });
            }
            Object.values(drivers).forEach(d => {
                const pax = d.passengers ? Object.values(d.passengers) : [];
                const me = pax.find(p => p.uid === currentVendorUid);
                if (me) items.push({ date, role: 'passenger', driverName: d.driverName });
            });
        });

        Object.entries(att).forEach(([date, people]) => {
            if (people[currentVendorUid]?.role === 'individual')
                items.push({ date, role: 'individual' });
        });

        if (!items.length) {
            c.innerHTML = '<div class="empty-state"><i data-lucide="history"></i><p>Nenhuma reunião ainda.</p></div>';
            if (window.lucide) lucide.createIcons(); return;
        }

        items.sort((a, b) => b.date.localeCompare(a.date));
        const LABEL = { driver: 'Motorista', passenger: 'Carona', individual: 'Individual' };
        const RATE = { carro: 0.90, moto: 0.40 };

        c.innerHTML = items.map(item => {
            const [y, m, d] = item.date.split('-');
            let det = '';
            if (item.role === 'driver') {
                const km = item.km ? parseFloat(item.km).toFixed(1) : 'N/A';
                const pay = item.reimb
                    ? `R$ ${parseFloat(item.reimb).toFixed(2)}`
                    : item.km ? `R$ ${(item.km * (RATE[item.vehicle] || 0.90)).toFixed(2)}` : 'N/A';
                const ico = item.vehicle === 'moto' ? '🏍️' : '🚗';
                det = `<div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
                    <span style="font-size:0.72rem;color:var(--gold);">${ico} ${km} km</span>
                    <span style="font-size:0.72rem;color:var(--success);">${pay}</span>
                </div>
                ${item.passengers?.length ? `<div class="mh-people">${item.passengers.map(p => `<span class="mh-person-tag">${p.name || 'Carona'}</span>`).join('')}</div>` : ''}
                ${item.noShows?.length ? `<div style="font-size:0.7rem;color:var(--danger);margin-top:4px;">⚠️ Furos: ${item.noShows.map(n => n.name).join(', ')}</div>` : ''}`;
            } else if (item.role === 'passenger') {
                det = `<div style="font-size:0.75rem;color:var(--muted);margin-top:6px;">Motorista: <strong>${item.driverName || '—'}</strong></div>`;
            }
            return `<div class="meeting-history-item">
                <div class="mh-header">
                    <span class="mh-badge ${item.role}">${LABEL[item.role]}</span>
                    <span class="mh-date">${d}/${m}/${y}</span>
                </div>${det}</div>`;
        }).join('');

        if (window.lucide) lucide.createIcons();
    } catch (e) { c.innerHTML = `<div class="empty-state"><p>Erro: ${e.message}</p></div>`; }
}

// ── ECONOMIA ──────────────────────────────────────────────────────
async function loadEconomyStats() {
    const rEl = document.getElementById('eco-rides'), kEl = document.getElementById('eco-km');
    if (!rEl || !kEl) return;
    try {
        const snap = await supabase.database().ref('meeting/history').once('value');
        const hist = snap.val() || {};
        let rides = 0, km = 0;
        Object.values(hist).forEach(day => {
            const mine = day[currentVendorUid];
            if (mine) {
                const pax = mine.passengers ? Object.values(mine.passengers) : [];
                rides += pax.filter(p => p.status === 'boarded' || p.dropoffStatus).length;
                km += parseFloat(mine.totalKm || 0);
            }
        });
        rEl.textContent = rides;
        kEl.innerHTML = `${km.toFixed(1)}<span class="eco-unit">km</span>`;
    } catch (_) { }
}

// ── UTILS / ACTIONS ──────────────────────────────────────────────
async function MeetingHardReset() {
    if (!currentVendorUid) return;
    try {
        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).remove();
        currentMeetingRole = null;
        selectedPassengers = [];
        driverRealRoute = [];
        meetingLocationData = null;
        currentDriverUid = null;
        if (pickupListListener) {
            supabase.database().ref(`meeting/driverPickups/${currentVendorUid}`).off('value', pickupListListener);
            pickupListListener = null;
        }
        _clearClocks();
    } catch (e) { console.error("Reset Error:", e); }
}

function _clearClocks() {
    if (returnTimerId) { clearInterval(returnTimerId); returnTimerId = null; }
    if (autoHomeTimerId) { clearTimeout(autoHomeTimerId); autoHomeTimerId = null; }
}

function setDriverVehicle(type) {
    driverVehicleType = type;
    const isMoto = (type === 'moto');
    const cEl = document.getElementById('vehicle-opt-carro');
    const mEl = document.getElementById('vehicle-opt-moto');
    if (cEl) {
        cEl.style.borderColor = isMoto ? 'var(--border)' : 'var(--gold)';
        cEl.style.background = isMoto ? 'transparent' : 'rgba(191,154,86,0.12)';
    }
    if (mEl) {
        mEl.style.borderColor = isMoto ? 'var(--gold)' : 'var(--border)';
        mEl.style.background = isMoto ? 'rgba(191,154,86,0.12)' : 'transparent';
    }
    const limit = document.getElementById('capacity-limit');
    if (limit) limit.textContent = isMoto ? '1' : '4';
    updateSeatIndicator();
}

function updateSeatIndicator() {
    const container = document.getElementById('seat-indicator');
    if (!container) return;
    const max = VEHICLE_CAPACITY[driverVehicleType] || 4;
    const count = selectedPassengers.length;
    let html = '<div class="seat driver-seat" title="Motorista"><i data-lucide="user" style="width:14px;"></i></div>';
    for (let i = 1; i <= 4; i++) {
        if (i <= max) {
            const isFilled = i <= count;
            html += `<div class="seat ${isFilled ? 'filled' : 'empty'}" id="seat-v${i}" title="Vaga ${i}">${isFilled ? '<i data-lucide="user-check" style="width:12px;"></i>' : ''}</div>`;
        } else {
            html += `<div class="seat locked" title="Bloqueado" style="opacity:0.2; background:rgba(255,255,255,0.05);"><i data-lucide="lock" style="width:10px;"></i></div>`;
        }
    }
    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

async function cancelPassengerWaiting() {
    if (await showConfirmDialog("Cancelar Participação", "Deseja realmente sair da fila de caronas?")) {
        await MeetingHardReset();
        showMeetingView('meeting-role-select');
    }
}

async function cancelIndividual() {
    if (await showConfirmDialog("Cancelar Reunião", "Sair do modo de participação individual?")) {
        await MeetingHardReset();
        showMeetingView('meeting-role-select');
    }
}

async function passengerConfirmEmbarkLocation() {
    if (!currentVendorUid) return;
    try {
        const btn = document.getElementById('btn-passenger-confirm-location');
        const msg = document.getElementById('passenger-embark-confirmed-msg');
        if (btn) btn.disabled = true;

        const updateData = {
            lat: lastLat || userLat,
            lng: lastLon || userLng,
            embarkLat: lastLat || userLat,
            embarkLng: lastLon || userLng,
            embarkName: currentVendorName,
            embarkStatus: 'confirmed'
        };

        await supabase.database().ref(`meeting/participants/${currentVendorUid}`).update(updateData);

        if (btn) btn.classList.add('hidden');
        if (msg) msg.classList.remove('hidden');
        showToast("Local de embarque confirmado!", "success");
    } catch (e) {
        console.error("Confirm Embark Error:", e);
        showToast("Erro ao confirmar local.", "error");
        const btn = document.getElementById('btn-passenger-confirm-location');
        if (btn) btn.disabled = false;
    }
}

// ── NOTIFICAÇÃO FLUTUANTE (fallback) ─────────────────────────────
if (typeof showGlobalNotification === 'undefined') {
    window.showGlobalNotification = function (sender, text, type, data) {
        const c = document.getElementById('floating-notification-container'); if (!c) return;
        const t = document.createElement('div');
        t.style.cssText = 'background:var(--surface);border:1px solid var(--gold-border);border-left:4px solid var(--gold);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 25px rgba(0,0,0,0.4);pointer-events:auto;cursor:pointer;margin-bottom:8px;';
        t.innerHTML = `<div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.82rem;color:var(--gold);margin-bottom:2px;">${sender}</div>
            <div style="font-size:0.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${text}</div>
        </div>`;
        t.onclick = () => {
            t.remove();
            if (type === 'support' && typeof showScreen === 'function') showScreen('chat');
            else if (data) openMeetingChat(data.uid, data.name);
        };
        c.appendChild(t);
        if (window.lucide) lucide.createIcons({ root: t });
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 4000);
    };
}

// EXPORTS GLOBAIS
window.passengerConfirmEmbarkLocation = passengerConfirmEmbarkLocation;
window.MeetingHardReset = MeetingHardReset;
window.showMeetingView = showMeetingView;
