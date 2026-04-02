/**
 * UNIROTAS — MEETING-LOGIC.JS v4.0 (Aperto de mão MESTRE)
 * Fluxo Inquebrável: driver / passenger / individual
 */
'use strict';

const PRESENCE_RADIUS_M = 150;
const DROPOFF_CONFIRM_MS = 3 * 60 * 1000;
const AUTO_HOME_MS = 2 * 60 * 60 * 1000;
const VEHICLE_CAPACITY = { carro: 4, moto: 1 };
const REIMBURSEMENT_RATE = { carro: 0.90, moto: 0.40 };

let currentMeetingRole = null;
let meetingLocationData = null;
let driverVehicleType = 'carro';
let driverPassengers = [];
let driverRealRoute = [];
let currentDriverUid = null;

let _passengerListener = null;
let _driverInfoListener = null;
let _routeTrackInterval = null;
let _autoHomeTimer = null;
let _dropoffTimers = {};
let _chatRoomCounts = {};
let _meetingChatPartner = null;

function _dist(lat1, lon1, lat2, lon2) { const R = 6371e3, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180, a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }
function _kmFromRoute(pts) { let k = 0; for (let i = 1; i < pts.length; i++)k += _dist(pts[i - 1].lat, pts[i - 1].lng ?? pts[i - 1].lon, pts[i].lat, pts[i].lng ?? pts[i].lon) / 1000; return k; }
function _today() { return new Date().toISOString().split('T')[0]; }
function _db() { return supabase.database(); }
function _fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'; }

// ── Diálogo de confirmação
function showConfirmDialog(title, body, yes = 'Confirmar', no = 'Cancelar') {
  return new Promise(resolve => {
    document.getElementById('_mcd')?.remove();
    const el = document.createElement('div'); el.id = '_mcd';
    el.style.cssText = 'position:fixed;inset:0;z-index:8000;display:flex;align-items:flex-end;justify-content:center;padding:20px;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);';
    el.innerHTML = `<div style="width:100%;max-width:460px;background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:28px 24px;"><div style="font-size:1rem;font-weight:700;text-align:center;margin-bottom:8px;color:var(--text);">${title}</div><div style="font-size:0.82rem;color:var(--muted);text-align:center;margin-bottom:22px;line-height:1.5;">${body}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"><button id="_mcd-no" style="padding:14px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">${no}</button><button id="_mcd-yes" style="padding:14px;border-radius:12px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:var(--danger);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">${yes}</button></div></div>`;
    document.body.appendChild(el);
    el.querySelector('#_mcd-no').onclick = () => { el.remove(); resolve(false); };
    el.querySelector('#_mcd-yes').onclick = () => { el.remove(); resolve(true); };
  });
}

// ── Modal de justificativa
function showJustifyDialog(title, placeholder) {
  return new Promise(resolve => {
    document.getElementById('_mjd')?.remove();
    const el = document.createElement('div'); el.id = '_mjd';
    el.style.cssText = 'position:fixed;inset:0;z-index:8000;display:flex;align-items:flex-end;justify-content:center;padding:20px;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);';
    el.innerHTML = `<div style="width:100%;max-width:460px;background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:28px 24px;"><div style="font-size:1rem;font-weight:700;text-align:center;margin-bottom:16px;">${title}</div><textarea id="_mjd-txt" placeholder="${placeholder}" style="width:100%;min-height:90px;background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:12px;color:var(--text);font-family:inherit;font-size:0.88rem;resize:none;outline:none;"></textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;"><button id="_mjd-no" style="padding:14px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">Cancelar</button><button id="_mjd-yes" style="padding:14px;border-radius:12px;background:var(--gold);border:none;color:var(--bg);font-family:inherit;font-size:0.9rem;font-weight:700;cursor:pointer;">Confirmar</button></div></div>`;
    document.body.appendChild(el);
    el.querySelector('#_mjd-no').onclick = () => { el.remove(); resolve(null); };
    el.querySelector('#_mjd-yes').onclick = () => { const t = el.querySelector('#_mjd-txt').value.trim(); el.remove(); resolve(t || '(sem justificativa)'); };
  });
}

// ── Navegação
function showMeetingView(viewId) {
  ['meeting-role-select', 'meeting-location-select', 'meeting-driver-search', 'meeting-driver-route', 'meeting-driver-return', 'meeting-passenger-waiting', 'meeting-passenger-active', 'meeting-individual']
    .forEach(v => document.getElementById(v)?.classList.add('hidden'));
  document.getElementById(viewId)?.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

// ── Reset completo
async function MeetingHardReset() {
  _stopRouteTracking();
  if (_autoHomeTimer) { clearTimeout(_autoHomeTimer); _autoHomeTimer = null; }
  Object.values(_dropoffTimers).forEach(t => clearTimeout(t));
  _dropoffTimers = {};
  const db = _db();
  if (_passengerListener && currentVendorUid) db.ref(`meeting/participants/${currentVendorUid}`).off('value', _passengerListener);
  if (_driverInfoListener && currentDriverUid) db.ref(`vendedores/${currentDriverUid}`).off('value', _driverInfoListener);
  _passengerListener = _driverInfoListener = null;
  currentMeetingRole = currentDriverUid = meetingLocationData = null;
  driverPassengers = driverRealRoute = [];
  driverVehicleType = 'carro';
  if (currentVendorUid) { try { const s = await db.ref(`meeting/participants/${currentVendorUid}`).once('value'); const p = s.val(); if (p && !['finished', 'done'].includes(p.phase)) await db.ref(`meeting/participants/${currentVendorUid}`).remove(); } catch (_) { } }
}

// ── Carregar tela inicial (se app atualizado)
function loadMeetingScreen() {
  if (!currentVendorUid) { setTimeout(loadMeetingScreen, 500); return; }
  _db().ref(`meeting/participants/${currentVendorUid}`).once('value').then(snap => {
    const d = snap.val();
    if (!d || ['finished', 'done'].includes(d.phase)) { showMeetingView('meeting-role-select'); return; }
    currentMeetingRole = d.role; driverVehicleType = d.vehicleType || 'carro';
    if (d.locationId) meetingLocationData = { id: d.locationId, name: d.locationName, address: d.locationAddress || '', lat: d.lat, lng: d.lng };
    _restoreState(d);
  }).catch(() => showMeetingView('meeting-role-select'));
}

function _restoreState(d) {
  if (d.role === 'driver') {
    if (d.phase === 'return') { showMeetingView('meeting-driver-return'); _loadDropoffList(); _startAutoHomeTimer(); }
    else if (d.phase === 'meeting') { showMeetingView('meeting-driver-route'); _showDriverAtMeeting(); }
    else { showMeetingView('meeting-driver-route'); _loadPickupList(); }
    _startRouteTracking();
  } else if (d.role === 'passenger') {
    if (!d.driverUid) { showMeetingView('meeting-individual'); }
    else { currentDriverUid = d.driverUid; showMeetingView('meeting-passenger-active'); _listenDriverInfo(d.driverUid); _renderPassengerStatus(d); }
  } else if (d.role === 'individual') {
    showMeetingView('meeting-individual'); _renderIndividualLocation();
    if (d.presenceConfirmed) _markIndividualConfirmed();
  }
}

// ── Seleção de papel (Apenas 2 telas)
async function selectRole(role) {
  await MeetingHardReset();
  currentMeetingRole = role;  // 'driver' ou 'individual'
  showMeetingView('meeting-location-select');
  _loadLocationsForSelection();
}

async function _loadLocationsForSelection() {
  const c = document.getElementById('meeting-locations-suggestion-list'); if (!c) return;
  c.innerHTML = '<div class="empty-state"><p>Carregando locais...</p></div>';
  try {
    const [uSnap, lSnap] = await Promise.all([_db().ref(`usuarios/${currentVendorUid}`).once('value'), _db().ref('meeting/locations').once('value')]);
    const ud = uSnap.val() || {}, locs = lSnap.val() || {};
    const city = (ud.address?.cidade || ud.city || '').toLowerCase();
    const reg = city.includes('rio') ? 'RJ' : 'ES';
    const list = Object.entries(locs).filter(([, l]) => !l.region || l.region === reg);
    if (!list.length) { c.innerHTML = `<div class="empty-state"><p>Sem locais para ${reg}.</p></div>`; return; }
    c.innerHTML = '';
    list.forEach(([id, loc]) => {
      const div = document.createElement('div');
      div.style.cssText = 'background:var(--glass);border:1px solid var(--border);border-radius:14px;padding:16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all 0.2s;margin-bottom:10px;';
      div.onmouseover = () => div.style.borderColor = 'var(--gold)'; div.onmouseout = () => div.style.borderColor = 'var(--border)';
      div.onclick = () => _confirmLocation(id, loc);
      div.innerHTML = `<div><div style="font-weight:700;font-size:0.92rem;">${loc.name}</div><div style="font-size:0.75rem;color:var(--muted);margin-top:3px;">${loc.address || ''}</div></div><i data-lucide="chevron-right" style="color:var(--gold);width:18px;height:18px;flex-shrink:0;"></i>`;
      c.appendChild(div);
    });
    if (window.lucide) lucide.createIcons();
  } catch (e) { c.innerHTML = `<p style="color:var(--danger);padding:20px;">Erro: ${e.message}</p>`; }
}

async function _confirmLocation(locId, loc) {
  if (!loc.lat || !loc.lng) { showToast('Local configurado sem GPS.', 'error'); return; }
  meetingLocationData = { id: locId, ...loc };
  const base = { uid: currentVendorUid, name: currentVendorName, role: currentMeetingRole, vehicleType: driverVehicleType, locationId: locId, locationName: loc.name, locationAddress: loc.address || '', lat: loc.lat, lng: loc.lng, region: loc.region || '', phase: 'idle', presenceConfirmed: false, status: 'active', joinedAt: Date.now() };
  await _db().ref(`meeting/participants/${currentVendorUid}`).set(base);
  showToast(`Local: ${loc.name}`, 'success');

  if (currentMeetingRole === 'driver') {
    showMeetingView('meeting-driver-search'); _initDriverSearch(); _startRouteTracking();
  } else {
    if (lastLat && lastLon) await _db().ref(`meeting/participants/${currentVendorUid}`).update({ embarkLat: lastLat, embarkLng: lastLon });
    showMeetingView('meeting-individual'); _renderIndividualLocation();
  }
}

// ── Motorista: Busca Inteligente (Super Lupa)
function _initDriverSearch() {
  const inp = document.getElementById('driver-search-input');
  if (inp) { inp.value = ''; inp.oninput = () => _searchPassengers(inp.value.trim()); }
  _renderPassengerChips();
}

async function _searchPassengers(query) {
  const c = document.getElementById('driver-search-results'); if (!c) return;
  if (!query || query.length < 2) { c.innerHTML = ''; return; }
  try {
    const snap = await _db().ref('usuarios').once('value');
    const users = snap.val() || {};
    const results = Object.values(users).filter(u => u.role !== 'admin' && u.uid !== currentVendorUid && !driverPassengers.some(p => p.uid === u.uid) && ((u.name || '').toLowerCase().includes(query.toLowerCase()) || (u.cpf || '').replace(/\D/g, '').includes(query.replace(/\D/g, '')))).slice(0, 6);
    c.innerHTML = '';
    if (!results.length) { c.innerHTML = `<div style="padding:12px;font-size:0.82rem;color:var(--muted);text-align:center;">Nenhum vendedor encontrado.</div>`; return; }
    results.forEach(u => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:12px;transition:background 0.15s;';
      div.onmouseover = () => div.style.background = 'rgba(255,255,255,0.04)'; div.onmouseout = () => div.style.background = 'transparent';
      div.innerHTML = `<div style="width:36px;height:36px;border-radius:50%;background:var(--gold-light);border:1px solid var(--gold-border);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;font-size:0.85rem;color:var(--gold);">${(u.name || '?')[0].toUpperCase()}</div><div><div style="font-weight:600;font-size:0.88rem;">${u.name || '—'}</div><div style="font-size:0.72rem;color:var(--muted);">CPF: ${u.cpf || '—'}</div></div>`;
      div.onclick = () => _addPassenger(u); c.appendChild(div);
    });
  } catch (e) { showToast('Erro na busca: ' + e.message, 'error'); }
}

function _addPassenger(u) {
  const max = VEHICLE_CAPACITY[driverVehicleType] || 4;
  if (driverPassengers.length >= max) { showToast(`Sua capacidade máxima é ${max}.`, 'error'); return; }
  if (driverPassengers.some(p => p.uid === u.uid)) { showToast('Já adicionado.', 'info'); return; }
  driverPassengers.push({ uid: u.uid, name: u.name });
  _renderPassengerChips();
  const inp = document.getElementById('driver-search-input'), res = document.getElementById('driver-search-results');
  if (inp) inp.value = ''; if (res) res.innerHTML = '';
  showToast(`${u.name} na lista de convites.`, 'success');
}
function _removePassenger(uid) { driverPassengers = driverPassengers.filter(p => p.uid !== uid); _renderPassengerChips(); }
window._removePassenger = _removePassenger;

function _renderPassengerChips() {
  const c = document.getElementById('driver-selected-chips'); if (!c) return;
  c.innerHTML = '';
  if (!driverPassengers.length) { c.innerHTML = `<span style="font-size:0.78rem;color:var(--muted);padding:8px 0;">Adicione alguém para oferecer carona.</span>`; return; }
  driverPassengers.forEach(p => {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:rgba(191,154,86,0.15);border:1px solid rgba(191,154,86,0.3);border-radius:20px;padding:6px 14px;margin:3px;';
    chip.innerHTML = `<span style="font-size:0.85rem;color:var(--gold);font-weight:600;">${p.name}</span><button onclick="_removePassenger('${p.uid}')" style="background:none;border:none;cursor:pointer;padding:0;display:flex;color:var(--muted);align-items:center;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>`;
    c.appendChild(chip);
  });
  if (window.lucide) lucide.createIcons({ root: c });
}

// ── Iniciar Carona (Envio de Convites do Motorista)
async function startDriverRoute() {
  showLoading(true);
  try {
    driverRealRoute = [];
    if (lastLat && lastLon) driverRealRoute.push({ type: 'start', lat: lastLat, lng: lastLon, label: 'Saída (Casa)', timestamp: Date.now() });
    const predicted = [];
    if (lastLat && lastLon) predicted.push({ lat: lastLat, lng: lastLon, label: '🏠 Casa Motorista' });
    for (const p of driverPassengers) {
      const s = await _db().ref(`meeting/participants/${p.uid}`).once('value'); const pd = s.val();
      const pLat = pd?.embarkLat || pd?.lat, pLng = pd?.embarkLng || pd?.lng;
      if (pLat && pLng) predicted.push({ lat: pLat, lng: pLng, label: `🔵 ${p.name}` });

      // MÁGICA 1: O MOTORISTA PASSA O DESTINO E INCLUI O CARONA AUTOMATICAMENTE (NOVO FLUXO DIRETO)
      await _db().ref(`meeting/notifications/${p.uid}`).set({ type: 'pickup_assigned', driverUid: currentVendorUid, driverName: currentVendorName, locId: meetingLocationData?.id, locName: meetingLocationData?.name, locLat: meetingLocationData?.lat, locLng: meetingLocationData?.lng, handled: false, timestamp: Date.now() });
      await _db().ref(`meeting/participants/${p.uid}`).update({ driverUid: currentVendorUid, driverName: currentVendorName, embarkStatus: 'accepted', role: 'passenger' });
      await _db().ref(`meeting/driverPickups/${currentVendorUid}/${p.uid}`).set({ uid: p.uid, name: p.name, lat: pLat || null, lng: pLng || null, status: 'accepted', order: driverPassengers.indexOf(p) });
    }
    if (meetingLocationData?.lat) predicted.push({ lat: meetingLocationData.lat, lng: meetingLocationData.lng, label: `📍 ${meetingLocationData.name}` });
    if (lastLat && lastLon) predicted.push({ lat: lastLat, lng: lastLon, label: '🏠 Casa Motorista (Volta)' });

    await _db().ref(`meeting/history/${_today()}/${currentVendorUid}`).set({ driverUid: currentVendorUid, driverName: currentVendorName, vehicleType: driverVehicleType, passengerCount: driverPassengers.length, predictedRoute: predicted, startedAt: Date.now(), date: _today(), status: 'in_progress' });
    await _db().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'route' });
    showMeetingView('meeting-driver-route'); _loadPickupList();
    showToast(driverPassengers.length ? 'Rota Ativada! Aguardando o "Sim" da galera.' : 'Rota iniciada sozinho!', 'success');
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
  finally { showLoading(false); }
}
async function startDriverAlone() { driverPassengers = []; await startDriverRoute(); }

// ── Lista de Embarque e Status no Painel do Motorista
function _loadPickupList() {
  const c = document.getElementById('driver-pickup-list');
  _db().ref(`meeting/driverPickups/${currentVendorUid}`).on('value', snap => {
    const raw = snap.val(), pks = raw ? Object.values(raw) : []; if (!c) return; c.innerHTML = '';
    if (!pks.length) { c.innerHTML = '<div class="empty-state"><p>Você optou por rodar sozinho.</p></div>'; document.getElementById('btn-driver-confirm-presence')?.classList.remove('hidden'); return; }

    const allDone = pks.every(p => ['boarded', 'no_show', 'rejected'].includes(p.status));
    document.getElementById('btn-driver-confirm-presence')?.classList.toggle('hidden', !allDone);

    const STATUS = { invited: { label: 'Aguardando aceite', badge: 'waiting' }, accepted: { label: 'A Caminho', badge: 'picked' }, boarding_pending: { label: 'Embarcando?', badge: 'waiting' }, boarded: { label: 'A bordo ✓', badge: 'picked' }, no_show: { label: 'Ausente', badge: 'refused' }, rejected: { label: 'Recusou', badge: 'refused' } };

    pks.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(p => {
      const s = STATUS[p.status] || { label: p.status, badge: 'waiting' };
      const div = document.createElement('div'); div.className = 'passenger-item';

      const canPick = p.status === 'accepted', canNoShow = ['invited', 'accepted', 'boarding_pending'].includes(p.status);
      div.innerHTML = `<div style="flex:1;"><div class="p-name">${p.name}</div><div class="p-actions" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;"><button class="p-btn-small chat" onclick="openMeetingChat('${p.uid}','${p.name}')"><i data-lucide="message-circle" style="display:inline;width:12px;"></i> Chat</button>${canPick ? `<button class="p-btn-small pickup" style="font-size:0.82rem;padding:8px 14px;background:var(--gold);color:var(--bg);border:none;" onclick="driverRequestBoarding('${p.uid}','${p.name}')"><i data-lucide="map-pin" style="display:inline;width:13px;"></i> Cheguei no Ponto</button>` : ''}${canNoShow ? `<button class="p-btn-small drop" style="background:rgba(239,68,68,0.12);" onclick="driverMarkNoShow('${p.uid}','${p.name}')">Faltou</button>` : ''}</div></div><span class="p-status-badge ${s.badge}">${s.label}</span>`;
      c.appendChild(div); _listenChatDot(p.uid);
    });
    if (window.lucide) lucide.createIcons(); updateUniversalPresence();
  });
}

async function driverRequestBoarding(pUid, pName) {
  if (lastLat && lastLon) driverRealRoute.push({ type: 'pickup', lat: lastLat, lng: lastLon, label: `${pName} embarque`, timestamp: Date.now() });
  await _db().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ status: 'boarding_pending' });
  await _db().ref(`meeting/participants/${pUid}`).update({ embarkStatus: 'boarding_pending' });
  await _db().ref(`meeting/notifications/${pUid}`).set({ type: 'boardingrequest', driverUid: currentVendorUid, driverName: currentVendorName, handled: false, timestamp: Date.now() });
  showToast(`Notificamos ${pName} que você está o aguardando.`, 'success');
}

async function driverMarkNoShow(pUid, pName) {
  const ok = await showConfirmDialog('Confirmar ausência?', `O(a) ${pName} não vai embarcar mais?`, 'Sim', 'Voltar'); if (!ok) return;
  await _db().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ status: 'no_show' });
  await _db().ref(`meeting/participants/${pUid}`).update({ driverUid: null, embarkStatus: 'waiting' });
  await _db().ref(`meeting/notifications/${pUid}`).set({ type: 'noShow', driverName: currentVendorName, handled: false, timestamp: Date.now() });
  showToast(`Informamos a gestão a ausência de ${pName}.`, 'info');
}

/* ────────────────────────────────────────────────────────
 * PRESENÇA NO LOCAL DA REUNIÃO
 * ──────────────────────────────────────────────────────── */
async function updateUniversalPresence() {
  if (!meetingLocationData?.lat || !lastLat) return;
  try { const s = await _db().ref(`meeting/participants/${currentVendorUid}/phase`).once('value'); if (['meeting', 'return', 'done', 'finished'].includes(s.val())) return; } catch (_) { }
  const near = _dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) < PRESENCE_RADIUS_M;
  const map = { driver: 'btn-driver-confirm-presence', passenger: 'btn-passenger-confirm-presence', individual: 'btn-individual-confirm' };
  const btn = document.getElementById(map[currentMeetingRole]); if (!btn) return;
  btn.classList.toggle('hidden', !near); btn.disabled = !near;
}

async function driverConfirmPresence() {
  if (!meetingLocationData || !lastLat) { showToast('GPS com sinal fraco.', 'error'); return; }
  if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) { showToast('Aproxime-se mais do destino.', 'warning'); return; }
  if (lastLat && lastLon) driverRealRoute.push({ type: 'meeting', lat: lastLat, lng: lastLon, label: 'Check-in Reunião', timestamp: Date.now() });
  await _db().ref(`meeting/attendance/${_today()}/${currentVendorUid}`).set({ name: currentVendorName, role: 'driver', vehicleType: driverVehicleType, locationId: meetingLocationData.id, locationName: meetingLocationData.name, confirmedAt: Date.now() });
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'meeting', presenceConfirmed: true });
  document.getElementById('btn-driver-confirm-presence')?.classList.add('hidden');
  _showDriverAtMeeting(); showToast('Reunião Atingida com Sucesso!', 'success');
}
function _showDriverAtMeeting() { document.getElementById('driver-meeting-in-progress')?.classList.remove('hidden'); document.getElementById('btn-driver-confirm-presence')?.classList.add('hidden'); }

async function passengerConfirmPresence() {
  if (!meetingLocationData || !lastLat) { showToast('Sem GPS forte no momento.', 'error'); return; }
  if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) { showToast('Aproxime-se mais do destino.', 'warning'); return; }
  await _db().ref(`meeting/attendance/${_today()}/${currentVendorUid}`).set({ name: currentVendorName, role: 'passenger', driverUid: currentDriverUid || 'none', locationId: meetingLocationData.id, locationName: meetingLocationData.name, confirmedAt: Date.now() });
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ presenceConfirmed: true });
  document.getElementById('btn-passenger-confirm-presence')?.classList.add('hidden');
  document.getElementById('passenger-reunion-status')?.classList.remove('hidden');
  showToast('Você Chegou! Presença marcada.', 'success');
}

async function individualConfirmPresence() {
  if (!meetingLocationData || !lastLat) { showToast('Esperando fixar GPS...', 'error'); return; }
  if (_dist(lastLat, lastLon, meetingLocationData.lat, meetingLocationData.lng) > PRESENCE_RADIUS_M) { showToast('Muito distante do local.', 'warning'); return; }
  await _db().ref(`meeting/attendance/${_today()}/${currentVendorUid}`).set({ name: currentVendorName, role: 'individual', locationId: meetingLocationData.id, locationName: meetingLocationData.name, confirmedAt: Date.now() });
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ presenceConfirmed: true, phase: 'done' });
  _markIndividualConfirmed(); showToast('Presença validada!', 'success');
}
function _markIndividualConfirmed() { document.getElementById('btn-individual-confirm')?.classList.add('hidden'); document.getElementById('individual-confirmed')?.classList.remove('hidden'); }

// ── RETORNO (Início da volta da reunião)
async function endMeeting() {
  const ok = await showConfirmDialog('A Reunião Acabou?', 'Você iniciará a rota para deixar os companheiros em casa.'); if (!ok) return;
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'return' });
  const snap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  for (const [uid, p] of Object.entries(snap.val() || {})) {
    if (p.status === 'boarded') await _db().ref(`meeting/notifications/${uid}`).set({ type: 'return_started', driverName: currentVendorName, handled: false, timestamp: Date.now() });
  }
  showMeetingView('meeting-driver-return'); _loadDropoffList(); openDriverMapRoute(true); _startAutoHomeTimer();
  showToast('Iniciando rastreamento de volta.', 'success');
}

async function _loadDropoffList() {
  const snap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  const pickups = Object.values(snap.val() || {}).filter(p => p.status === 'boarded');
  const c = document.getElementById('driver-dropoff-list'); if (!c) return; c.innerHTML = '';
  if (!pickups.length) { document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden'); c.innerHTML = '<div class="empty-state"><p>Você volta sozinho hoje.</p></div>'; return; }
  const allDone = pickups.every(p => ['confirmed', 'justified'].includes(p.dropoffStatus));
  if (allDone) document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden');

  pickups.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(p => {
    const done = ['confirmed', 'justified'].includes(p.dropoffStatus), pending = p.dropoffStatus === 'pending_confirm';
    const div = document.createElement('div'); div.className = 'passenger-item';
    div.innerHTML = `<div style="flex:1;"><div class="p-name">${p.name}</div>${p.dropoffStatus === 'justified' && p.justification ? `<div style="font-size:0.7rem;color:var(--gold);margin-top:3px;">📝 ${p.justification}</div>` : ''}<div class="p-actions" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${!done ? `<button class="p-btn-small pickup" style="font-size:0.82rem;padding:8px 14px;" onclick="driverDropOff('${p.uid}','${p.name}')"><i data-lucide="map-pin" style="display:inline;width:13px;"></i> Desembarcado!</button><button class="p-btn-small drop" style="background:rgba(251,191,36,0.12);color:#fbbf24;" onclick="driverJustifyDropoff('${p.uid}','${p.name}')"><i data-lucide="alert-triangle" style="display:inline;width:12px;"></i> Forçar</button>` : ''} ${pending ? `<span style="font-size:0.75rem;color:var(--gold);">Celular dele bipou.</span>` : ''}</div></div><span class="p-status-badge ${done ? 'dropped' : 'waiting'}">${done ? (p.dropoffStatus === 'justified' ? 'Justificado' : '✅ Entregue') : 'A Entregar'}</span>`;
    c.appendChild(div);
  });
  if (window.lucide) lucide.createIcons();
}

async function driverDropOff(pUid, pName) {
  if (lastLat && lastLon) driverRealRoute.push({ type: 'dropoff', lat: lastLat, lng: lastLon, label: `${pName} desembarque`, timestamp: Date.now() });
  await _db().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ dropoffStatus: 'pending_confirm' });
  await _db().ref(`meeting/notifications/${pUid}`).set({ type: 'dropoff_request', driverUid: currentVendorUid, driverName: currentVendorName, handled: false, timestamp: Date.now() });
  showToast(`Pedido de confirmação na tela de ${pName}...`, 'info');
  if (_dropoffTimers[pUid]) clearTimeout(_dropoffTimers[pUid]);
  _dropoffTimers[pUid] = setTimeout(async () => {
    const s = await _db().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}/dropoffStatus`).once('value');
    if (s.val() === 'pending_confirm') { showToast(`O(a) ${pName} não confirmou no celular dele. Use "Forçar" para continuar.`, 'warning'); }
  }, DROPOFF_CONFIRM_MS);
  setTimeout(() => _loadDropoffList(), 500);
}

async function driverJustifyDropoff(pUid, pName) {
  const reason = await showJustifyDialog(`Registro Alternativo - ${pName}`, 'Ex: Ele desceu e estava correndo...');
  if (!reason) return;
  if (_dropoffTimers[pUid]) { clearTimeout(_dropoffTimers[pUid]); delete _dropoffTimers[pUid]; }
  if (lastLat && lastLon) driverRealRoute.push({ type: 'dropoff_justified', lat: lastLat, lng: lastLon, label: `${pName} desembarque (Auditado)`, timestamp: Date.now() });
  await _db().ref(`meeting/driverPickups/${currentVendorUid}/${pUid}`).update({ dropoffStatus: 'justified', justification: reason, dropoffAt: Date.now(), dropoffLat: lastLat || null, dropoffLng: lastLon || null });
  await _db().ref(`meeting/participants/${pUid}`).update({ status: 'finished', phase: 'done' });
  showToast('Desembarque auditado pelo motorista.', 'success');
  setTimeout(() => _loadDropoffList(), 400);
}

async function driverArrivedHome() {
  _stopRouteTracking(); if (_autoHomeTimer) { clearTimeout(_autoHomeTimer); _autoHomeTimer = null; }
  Object.values(_dropoffTimers).forEach(t => clearTimeout(t)); _dropoffTimers = {};
  const snap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  const pending = Object.values(snap.val() || {}).filter(p => p.status === 'boarded' && !['confirmed', 'justified'].includes(p.dropoffStatus));
  if (pending.length) { const ok = await showConfirmDialog('Falta Gente no Carro!', 'Há passageiros que não computaram o desembarque. Deseja encerrar mesmo assim e jogar a responsabilidade pra você?'); if (!ok) return; for (const p of pending) await driverJustifyDropoff(p.uid, p.name); }

  if (lastLat && lastLon) driverRealRoute.push({ type: 'end', lat: lastLat, lng: lastLon, label: 'Fim Módulo: Lar', timestamp: Date.now() });
  const km = _kmFromRoute(driverRealRoute.filter(p => p.lat)), rate = REIMBURSEMENT_RATE[driverVehicleType] || 0.90, reimb = km * rate;

  const picksSnap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  await _db().ref(`meeting/history/${_today()}/${currentVendorUid}`).update({ passengers: picksSnap.val() || {}, vehicleType: driverVehicleType, realRoute: driverRealRoute, totalKm: parseFloat(km.toFixed(2)), reimbursement: parseFloat(reimb.toFixed(2)), completedAt: Date.now(), status: 'completed' });
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ phase: 'done', status: 'finished' });
  // Limpa o canal em tempo real para os proximos
  await _db().ref(`meeting/driverPickups/${currentVendorUid}`).remove();

  _showTripSummary(km, reimb);
  driverRealRoute = []; driverPassengers = []; currentMeetingRole = null;
  if (typeof loadEconomyStats === 'function') loadEconomyStats();
}

function _showTripSummary(km, reimb) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--surface);border:2px solid var(--success);border-radius:24px;padding:24px 32px;z-index:9000;text-align:center;min-width:240px;box-shadow:0 8px 40px rgba(0,0,0,0.7);';
  el.innerHTML = `<div style="font-size:2rem;margin-bottom:8px;">🏁</div><div style="font-weight:800;font-size:1.1rem;margin-bottom:4px;color:var(--success);">Missão Cumprida!</div><div style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">Deslocamento Total: ${km.toFixed(1)} km</div><div style="font-size:1.6rem;font-weight:800;color:var(--gold);">R$ ${reimb.toFixed(2)}</div><div style="font-size:0.75rem;color:white;margin-top:4px;">Adicionado aos cálculos</div>`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity 0.6s'; el.style.opacity = '0'; setTimeout(() => { el.remove(); showMeetingView('meeting-role-select'); }, 600); }, 5000);
}

async function openDriverMapRoute(isReturn = false) {
  if (!lastLat || !lastLon) { showToast('Problema com antena GPS.', 'error'); return; }
  if (!meetingLocationData?.lat) { showToast('O Destino não foi estabelecido!', 'error'); return; }
  const snap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  const pickups = snap.val() || {}; let origin, dest, wps = [];
  if (!isReturn) {
    origin = `${lastLat},${lastLon}`; dest = `${meetingLocationData.lat},${meetingLocationData.lng}`;
    for (const [uid, p] of Object.entries(pickups)) { if (['boarded', 'no_show', 'rejected'].includes(p.status)) continue; const ps = await _db().ref(`meeting/participants/${uid}`).once('value'); const pd = ps.val(); const lat = pd?.embarkLat || pd?.lat, lng = pd?.embarkLng || pd?.lng; if (lat && lng) wps.push(`${lat},${lng}`); }
  } else {
    origin = `${meetingLocationData.lat},${meetingLocationData.lng}`; dest = `${lastLat},${lastLon}`;
    for (const [uid, p] of Object.entries(pickups)) { if (p.status !== 'boarded') continue; if (['confirmed', 'justified'].includes(p.dropoffStatus)) continue; const ps = await _db().ref(`meeting/participants/${uid}`).once('value'); const pd = ps.val(); const lat = pd?.embarkLat || pd?.lat, lng = pd?.embarkLng || pd?.lng; if (lat && lng) wps.push(`${lat},${lng}`); }
  }
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
  if (wps.length) url += `&waypoints=${wps.join('|')}`; window.open(url, '_blank');
}

/* ────────────────────────────────────────────────────────
 * O LADO DO PASSAGEIRO: APERTO DE MÃO "HANDSHAKE" 🤜🤛
 * ──────────────────────────────────────────────────────── */
function _renderIndividualLocation() { const el = document.getElementById('individual-location-details'); if (el && meetingLocationData) el.innerHTML = `<strong>${meetingLocationData.name}</strong><br>${meetingLocationData.address || ''}`; }

function cancelIndividual() { _db().ref(`meeting/participants/${currentVendorUid}`).remove(); currentMeetingRole = null; showMeetingView('meeting-role-select'); }

async function cancelDriver() {
  const ok = await showConfirmDialog('Abortar Transporte?', 'Todos os seus caronas perderão a carona e serão notificados.'); if (!ok) return;
  _stopRouteTracking();
  const snap = await _db().ref(`meeting/driverPickups/${currentVendorUid}`).once('value');
  for (const [uid] of Object.entries(snap.val() || {})) { await _db().ref(`meeting/participants/${uid}`).update({ driverUid: null, embarkStatus: 'idle', role: 'individual' }); await _db().ref(`meeting/notifications/${uid}`).set({ type: 'driverCancelled', driverName: currentVendorName, handled: false, timestamp: Date.now() }); await _db().ref(`meeting/driverPickups/${currentVendorUid}/${uid}`).remove(); }
  await _db().ref(`meeting/participants/${currentVendorUid}`).remove();
  currentMeetingRole = null; driverPassengers = []; showMeetingView('meeting-role-select'); showToast('Você dissolveu o carro.', 'error');
}
const cancelDriverRoute = cancelDriver;

function _listenDriverInfo(driverUid) {
  currentDriverUid = driverUid;

  setTimeout(() => {
    const btnChat = document.getElementById('menu-driver-chat');
    if (btnChat) btnChat.style.display = 'flex';
    if (typeof _initPassengerFloatChat === 'function') _initPassengerFloatChat();

    const dashAlert = document.getElementById('dashboard-pickup-alert');
    if (dashAlert && !dashAlert.innerHTML.includes('Motorista à Caminho')) {
      dashAlert.innerHTML = `<div style="background: rgba(191,154,86,0.15); border: 1px solid var(--gold); border-radius: 14px; padding: 16px; display: flex; align-items: center; gap: 14px;"><div style="background:var(--gold); border-radius:50%; width:44px; height:44px; display:flex; align-items:center; justify-content:center; color:var(--bg); flex-shrink:0;"><i data-lucide="car" style="width:22px;height:22px;"></i></div><div><div style="font-size:0.8rem; color:var(--gold); font-weight:800; text-transform:uppercase;">🚗 Motorista à Caminho</div><div style="font-size:0.95rem; font-weight:600; margin-top:2px;">O seu motorista associado já está na sua rota.</div></div></div>`;
      if (window.lucide) lucide.createIcons();
    }
  }, 1000);

  if (_driverInfoListener) _db().ref(`vendedores/${driverUid}`).off('value', _driverInfoListener);
  _driverInfoListener = _db().ref(`vendedores/${driverUid}`).on('value', snap => {
    const d = snap.val(); if (!d) return;
    const el = document.getElementById('passenger-driver-name'); if (el) el.textContent = `No carro com: ${d.name || driverUid}`;
    if (d.lat && lastLat) { const dist = _dist(lastLat, lastLon, d.lat, d.lon || d.lng), eta = Math.round((dist / 1000) / 40 * 60); const et = document.getElementById('passenger-eta-text'); if (et) et.textContent = `${eta > 0 ? '🚗 Chega +/- em ' + eta + ' min' : 'Motorista muito perto!'}`; }
  });
  if (_passengerListener) _db().ref(`meeting/participants/${currentVendorUid}`).off('value', _passengerListener);
  _passengerListener = _db().ref(`meeting/participants/${currentVendorUid}`).on('value', snap => { const d = snap.val(); if (d) _renderPassengerStatus(d); });
}

function _renderPassengerStatus(d) {
  const st = document.getElementById('passenger-embark-status'), wr = document.getElementById('passenger-driver-chat-wrap');
  const MAP = { invited: 'Sua corrida está confirmada, o Motorista iniciou!', accepted: 'Aguarde o motorista onde acordaram.', boarding_pending: '⏳ Hora de entrar! Veja o carro e confirme o embarque.', boarded: `✅ Cinto posto, aproveite a viagem com a rádio do ${d.driverName || 'Motorista'}!` };
  if (st) st.innerHTML = `<div>${MAP[d.embarkStatus] || 'Pressione o cinto e segure firme.'}</div>`;
  if (wr) wr.style.display = ['accepted', 'boarded', 'boarding_pending'].includes(d.embarkStatus) ? 'block' : 'none';
  if (d.embarkStatus === 'boarding_pending') document.getElementById('passenger-boarding-card')?.classList.remove('hidden');
  if (d.embarkStatus === 'boarded') { document.getElementById('passenger-boarding-card')?.classList.add('hidden'); updateUniversalPresence(); }
  if (d.embarkStatus === 'idle' && currentMeetingRole === 'passenger') { currentDriverUid = null; showMeetingView('meeting-individual'); showToast('Você deixou o veículo.', 'info'); }
}

async function passengerConfirmBoarding() {
  if (lastLat && lastLon) await _db().ref(`meeting/participants/${currentVendorUid}`).update({ embarkLat: lastLat, embarkLng: lastLon, embarkStatus: 'boarded' });
  else await _db().ref(`meeting/participants/${currentVendorUid}`).update({ embarkStatus: 'boarded' });

  if (currentDriverUid) await _db().ref(`meeting/driverPickups/${currentDriverUid}/${currentVendorUid}`).update({ status: 'boarded' });
  document.getElementById('passenger-boarding-card')?.classList.add('hidden');
  const st = document.getElementById('passenger-embark-status');
  if (st) st.innerHTML = `<div style="color:var(--success);font-weight:700;">✅ Seguro dentro do carro!</div>`;
  showToast('Motorista recebeu seu aperto de cinto!', 'success');
}

async function cancelPassengerWaiting() {
  const ok = await showConfirmDialog('Desistir do Carro?', 'Tem certeza que quer voltar a ser Individual?'); if (!ok) return;
  const snap = await _db().ref(`meeting/participants/${currentVendorUid}`).once('value'); const d = snap.val();
  if (d?.driverUid) { await _db().ref(`meeting/driverPickups/${d.driverUid}/${currentVendorUid}`).update({ status: 'rejected' }); await _db().ref(`meeting/notifications/${d.driverUid}`).set({ type: 'passengerCancelled', passengerUid: currentVendorUid, passengerName: currentVendorName, handled: false, timestamp: Date.now() }); }
  if (_passengerListener) { _db().ref(`meeting/participants/${currentVendorUid}`).off('value', _passengerListener); _passengerListener = null; }
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ embarkStatus: 'idle', driverUid: null, driverName: null, role: 'individual' });
  currentMeetingRole = 'individual'; currentDriverUid = null; showMeetingView('meeting-individual'); showToast('Você vazou da carona.', 'warning');
}

/* ── CAIXA MAGICA DE CONVITES DO MOTORISTA (POPUP) ── */
let _meetingNotifLock = false;
function listenForMeetingNotifications(uid) {
  if (_meetingNotifLock) return;
  _meetingNotifLock = true;
  _db().ref(`meeting/notifications/${uid}`).on('value', async snap => {
    const d = snap.val(); if (!d || d.handled) return;

    switch (d.type) {
      case 'pickup_assigned':
        if (currentMeetingRole !== 'driver') {
          // FLUXO AUTOMÁTICO: Foi selecionado pelo motorista, não precisa confirmar.
          if (d.locId) meetingLocationData = { id: d.locId, name: d.locName, lat: d.locLat, lng: d.locLng };
          currentMeetingRole = 'passenger';
          showMeetingView('meeting-passenger-active');
          _listenDriverInfo(d.driverUid);

          // Exibir Painel Inicial
          const dashAlert = document.getElementById('dashboard-pickup-alert');
          if (dashAlert) {
            dashAlert.innerHTML = `<div style="background: rgba(191,154,86,0.15); border: 1px solid var(--gold); border-radius: 14px; padding: 16px; display: flex; align-items: center; gap: 14px;"><div style="background:var(--gold); border-radius:50%; width:44px; height:44px; display:flex; align-items:center; justify-content:center; color:var(--bg); flex-shrink:0;"><i data-lucide="car" style="width:22px;height:22px;"></i></div><div><div style="font-size:0.8rem; color:var(--gold); font-weight:800; text-transform:uppercase;">🚗 Motorista à Caminho</div><div style="font-size:0.95rem; font-weight:600; margin-top:2px;">O <b>${d.driverName}</b> adicionou você na rota.</div></div></div>`;
            if (window.lucide) lucide.createIcons();
          }

          // Mostrar chat no menu lateral
          document.getElementById('menu-driver-chat').style.display = 'flex';

          showToast(`Mochila nas costas! O motorista ${d.driverName} vem te buscar.`, 'success');
        }
        break;
      case 'boardingrequest': showToast(`🚨 O(a) ${d.driverName} chegou na base. CONFIRME SUA ENTRADA no app dele!`, 'warning'); document.getElementById('passenger-boarding-card')?.classList.remove('hidden'); break;
      case 'return_started': showToast('A chapa esfriou e o motorista ligou o carro de volta pra casa.', 'info'); document.getElementById('passenger-reunion-status')?.classList.add('hidden'); document.getElementById('passenger-return-card')?.classList.remove('hidden'); break;
      case 'dropoff_request': showToast('Sua garagem? Confirme no app para dar tranquilidade pro Motora!', 'info'); _showPassengerDropoffConfirm(d.driverUid); break;
      case 'driverCancelled': showToast(`💀 Seu Motorista (${d.driverName}) dissolveu a rota. Vá de Ônibus!`, 'error'); currentDriverUid = null; currentMeetingRole = 'individual'; showMeetingView('meeting-individual'); break;

      case 'chat_message':
        const isChatOpen = (document.getElementById('view-chat').style.display !== 'none' && !document.getElementById('view-chat').classList.contains('hidden'));

        // SEMPRE Injeta na caixa do Bate Papo (mesmo no Background)
        const cMsgs = document.getElementById('chat-messages');
        if (cMsgs) {
            const b = document.createElement('div');
            b.style.cssText = `max-width:80%; padding:10px 14px; border-radius:18px; margin-bottom:8px; align-self:flex-start; background:var(--surface2); color:var(--text); font-size:0.9rem;`;
            b.innerHTML = `<div>${d.text}</div><div style="font-size:0.65rem; color:var(--muted); margin-top:4px; text-align:right;">${_fmtTime(d.timestamp)}</div>`;
            cMsgs.appendChild(b);
            setTimeout(() => cMsgs.scrollTop = cMsgs.scrollHeight, 50);
        }

        if (!isChatOpen) {
          showToast(`💬 ${d.senderName}: ${d.text}`, 'info');
          const badge = document.getElementById('badge-driver-chat-qty');
          if (badge) { badge.style.display = 'flex'; badge.innerText = '!'; }
        }
        break;

      // ... notifications para motorista ...
      case 'passengerCancelled': if (currentMeetingRole === 'driver') showToast(`O Carona ${d.passengerName} fugiu da rota.`, 'error'); break;
    }

    await _db().ref(`meeting/notifications/${uid}`).update({ handled: true });
  });
}

function _showPassengerDropoffConfirm(driverUid) {
  if (document.getElementById('_dropoff-confirm-card')) return;
  const el = document.createElement('div'); el.id = '_dropoff-confirm-card';
  el.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);width:calc(100% - 40px);max-width:400px;background:var(--surface);border:2px solid var(--gold);border-radius:20px;padding:24px 24px;z-index:9000;box-shadow: 0 10px 40px rgba(0,0,0,0.6);';
  el.innerHTML = `<div style="font-weight:900;font-size:1.1rem;margin-bottom:8px;color:var(--gold);">🏁 É Você na sua Casa?</div><p style="font-size:0.85rem;color:var(--muted);margin-bottom:20px;line-height:1.5;">O motorista registrou que te entregou com segurança. Confirme pra liberar o cara!</p><button onclick="_passengerConfirmDropoff('${driverUid}')" style="width:100%;padding:16px;background:var(--success);border:none;border-radius:14px;color:white;font-weight:800;font-size:1.0rem;cursor:pointer;"><i data-lucide="check" style="display:inline;width:14px;"></i> CLARO, DESEMBARQUEI</button>`;
  document.body.appendChild(el); if (window.lucide) lucide.createIcons({ root: el });
}

async function _passengerConfirmDropoff(driverUid) {
  document.getElementById('_dropoff-confirm-card')?.remove();
  await _db().ref(`meeting/driverPickups/${driverUid}/${currentVendorUid}`).update({ dropoffStatus: 'confirmed', dropoffAt: Date.now(), dropoffLat: lastLat || null, dropoffLng: lastLon || null });
  await _db().ref(`meeting/participants/${currentVendorUid}`).update({ status: 'finished', phase: 'done' });
  showToast('Desembarque Lacrado! Cesto e cama.', 'success'); currentMeetingRole = null;
  setTimeout(() => showMeetingView('meeting-role-select'), 1500);
}
window._passengerConfirmDropoff = _passengerConfirmDropoff;

// ── Rastreador GPS Silencioso do Motorista
function _startRouteTracking() {
  if (_routeTrackInterval) return;
  _routeTrackInterval = setInterval(() => {
    if (!lastLat || !lastLon || currentMeetingRole !== 'driver') return;
    const last = driverRealRoute[driverRealRoute.length - 1];
    if (last && _dist(last.lat, last.lng ?? last.lon, lastLat, lastLon) < 50) return; // Só se mexer mais que 50 metros
    driverRealRoute.push({ type: 'waypoint', lat: lastLat, lng: lastLon, timestamp: Date.now() });
  }, 20000); // 20 seg resolve muito pro maps da gestao
}
function _stopRouteTracking() { if (_routeTrackInterval) { clearInterval(_routeTrackInterval); _routeTrackInterval = null; } }
function _startAutoHomeTimer() {
  if (_autoHomeTimer) clearTimeout(_autoHomeTimer);
  _autoHomeTimer = setTimeout(async () => { const s = await _db().ref(`meeting/participants/${currentVendorUid}/phase`).once('value'); if (!['done', 'finished'].includes(s.val())) { showToast('Tempo estourado. Finalizando turnos.', 'info'); await driverArrivedHome(); } }, AUTO_HOME_MS);
}

// ── Histórico, Chat e demais Helpers
function _listenChatDot(pUid) {
  // Obsoleta. Substituída pelo sistema de Push de Notificações.
}



function openDriverSpecificChat() {
  if (window.closeSidebar) window.closeSidebar();
  const btn = document.getElementById('badge-driver-chat-qty');
  if (btn) btn.style.display = 'none';
  openMeetingChatWithDriver();
}
window.openDriverSpecificChat = openDriverSpecificChat;
function openMeetingChatWithDriver() { if (!currentDriverUid) { showToast('Ele não fixou!', 'error'); return; } const n = document.getElementById('passenger-driver-name')?.textContent?.replace('No carro com: ', '') || 'Motorista'; openMeetingChat(currentDriverUid, n); }
function _notify(sender, text, type, data) { if (typeof showGlobalNotification === 'function') showGlobalNotification(sender, text, type, data); }

// ── Funções Re-Conectadas de Bate-Papo Efêmero

function openMeetingChat(targetUid, targetName) {
  if (!currentVendorUid) return;
  _meetingChatPartner = { uid: targetUid, name: targetName };

  document.getElementById('vendor-typing').style.display = 'none';
  const cMsgs = document.getElementById('chat-messages');
  if (!cMsgs.innerHTML.includes('Chat Exclusivo com')) {
    cMsgs.insertAdjacentHTML('afterbegin', `<div style="text-align:center;color:var(--gold);font-weight:bold;margin:10px 0;">Chat Exclusivo com ${targetName}</div><div style="text-align:center;color:var(--muted);font-size:0.75rem;margin-bottom:10px;">As mensagens sumirão após a viagem.</div>`);
  }
  showScreen('chat');
}
window.openMeetingChat = openMeetingChat;

async function sendChatMessage() {
  if (!_meetingChatPartner) {
    showToast('O Chat de Suporte fica em outra tela. Fale com a adm.', 'warning');
    return;
  }
  const inp = document.getElementById('chat-input');
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = '';

  // Mostra na tela imediatamente Local
  const cMsgs = document.getElementById('chat-messages');
  const b = document.createElement('div');
  b.style.cssText = `max-width:80%; padding:10px 14px; border-radius:18px; margin-bottom:8px; align-self:flex-end; background:var(--gold); color:var(--bg); font-size:0.9rem;`;
  b.innerHTML = `<div>${txt}</div><div style="font-size:0.65rem; color:rgba(0,0,0,0.5); margin-top:4px; text-align:right;">${_fmtTime(Date.now())}</div>`;
  cMsgs.appendChild(b);
  setTimeout(() => cMsgs.scrollTop = cMsgs.scrollHeight, 50);

  // Dispara via Push de Notificação
  await _db().ref(`meeting/notifications/${_meetingChatPartner.uid}`).set({
    type: 'chat_message',
    senderUid: currentVendorUid,
    senderName: currentVendorName,
    text: txt,
    handled: false,
    timestamp: Date.now()
  });
}
window.sendChatMessage = sendChatMessage;

console.log(' meeting-logic V4 Injetado (com Chat Exclusivo) ');
