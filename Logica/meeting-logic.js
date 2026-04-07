/* ── Estado global da lógica de reunião ── */
let currentMeetingLocation = null;   // { name, address, lat, lng }
let currentDriverRole = null;   // 'driver' | 'solo' | 'individual'
let currentMeetingId = null;   // ID da sessão no Supabase
let currentVehicleType = 'carro';
let selectedPassengers = [];
let isSoloMode = false;

/* Rastreamento GPS */
let sessionGpsTrack = [];
let soloReturnStarted = false;
let soloReturnTrack = [];

/* ── Helpers ── */
function getUserAddress() {
  const p = window._userProfile || {};
  const parts = [
    p.addr_rua || p.address || '',
    p.addr_num || p.number || '',
    p.addr_bairro || p.bairro || '',
    p.addr_cidade || p.cidade || '',
    p.addr_cep || p.cep || ''
  ].filter(Boolean);
  return parts.join(', ') || null;
}

function getMeetingLocationAddress() {
  return currentMeetingLocation
    ? (currentMeetingLocation.address || currentMeetingLocation.name)
    : null;
}

function buildMapsUrl(origin, destination, waypoints = []) {
  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  if (waypoints && waypoints.length > 0) {
    url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
  }
  return url;
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

function showMeetingView(viewId) {
  ['meeting-role-select', 'meeting-location-select', 'meeting-driver-search',
    'meeting-individual', 'meeting-passenger-active',
    'meeting-driver-route', 'meeting-driver-return'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
  const t = document.getElementById(viewId);
  if (t) t.classList.remove('hidden');
}

/* ── Seleção de papel ── */
function selectRole(role) {
  currentDriverRole = role;
  showMeetingView('meeting-location-select');
  loadMeetingLocations();
}

async function loadMeetingLocations() {
  const list = document.getElementById('meeting-locations-suggestion-list');
  if (!list) return;
  list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:10px">Carregando locais...</p>';
  try {
    const { data, error } = await window._supabase
      .from('meeting_locations').select('*').order('name');
    if (error) throw error;
    if (!data || !data.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:10px">Nenhum local cadastrado.</p>';
      return;
    }
    list.innerHTML = data.map(loc => `
      <button class="action-btn"
        onclick="selectMeetingLocation(${JSON.stringify(loc).replace(/"/g, '&quot;')})"
        style="width:100%;text-align:left;padding:16px;border-radius:16px;display:flex;flex-direction:column;gap:4px;
               margin-bottom:8px;background:#111827;border:1.5px solid rgba(255,255,255,0.15);color:#fff">
        <div style="font-weight:800;font-size:1rem;color:#ffffff">${loc.name}</div>
        <div style="font-size:0.75rem;color:#94a3b8;line-height:1.4">${loc.address || ''}</div>
      </button>`).join('');
  } catch (e) {
    console.error(e);
    list.innerHTML = '<p style="color:#ff4757;font-size:0.85rem;padding:10px">Erro ao carregar locais.</p>';
  }
}

function selectMeetingLocation(loc) {
  currentMeetingLocation = loc;
  if (currentDriverRole === 'driver') {
    showMeetingView('meeting-driver-search');
    loadDriverSearchList();
  } else if (currentDriverRole === 'individual') {
    showMeetingView('meeting-individual');
    const det = document.getElementById('individual-location-details');
    if (det) det.textContent = loc.address || loc.name;

    // Nav GPS Dinâmico (Individual: Atual -> Reunião)
    const mapsUrl = buildMapsUrl('Minha localização', loc.address || loc.name);
    window.open(mapsUrl, '_blank');
  } else if (currentDriverRole === 'solo') {
    // solo já chama startDriverAlone diretamente
    startDriverAlone();
  }
}

function driverVehicleType(type) { currentVehicleType = type; }

function loadDriverSearchList() {
  const input = document.getElementById('driver-search-input');
  if (input) input.addEventListener('input', () => filterDriverSearch(input.value));
}

async function filterDriverSearch(query) {
  const results = document.getElementById('driver-search-results');
  if (!results) return;
  try {
    let q = window._supabase.from('usuarios')
      .select('uid, name, cc, address, addr_rua, addr_num, addr_bairro, addr_cidade, addr_cep')
      .eq('role', 'vendedor').neq('uid', window._currentUserId);

    if (query) q = q.ilike('name', `%${query}%`);
    const { data, error } = await q.limit(10);
    if (error) throw error;

    results.innerHTML = (data || []).map(u => {
      // Compõe o endereço amigável para o trajeto previsto
      const fullAddr = [u.addr_rua || u.address || '', u.addr_num || '', u.addr_bairro || '', u.addr_cidade || ''].filter(Boolean).join(', ');

      return `<div onclick="togglePassenger('${u.uid}','${u.name}', '${fullAddr}')"
        style="padding:12px 14px;cursor:pointer;border-bottom:1px solid var(--border);
               display:flex;align-items:center;gap:10px"
        onmouseenter="this.style.background='rgba(191,154,86,0.07)'"
        onmouseleave="this.style.background=''">
        <i data-lucide="user" style="width:18px;height:18px;color:var(--muted)"></i>
        <span style="flex:1">${u.name}</span>
        <span style="font-size:0.75rem;color:var(--muted)">${u.cc || ''}</span>
      </div>`;
    }).join('') || '<p style="padding:12px;color:var(--muted);font-size:0.85rem">Nenhum vendedor encontrado.</p>';
    if (window.lucide) lucide.createIcons();
  } catch (e) { console.error(e); }
}

function togglePassenger(id, name, address) {
  const idx = selectedPassengers.findIndex(p => p.id === id);
  if (idx >= 0) selectedPassengers.splice(idx, 1);
  else selectedPassengers.push({ id, name, address: address || '' });
  renderSelectedChips();
}

function renderSelectedChips() {
  const chips = document.getElementById('driver-selected-chips');
  if (!chips) return;
  chips.innerHTML = selectedPassengers.map(p => `
    <span style="background:rgba(191,154,86,0.15);border:1px solid var(--gold-border);
                 color:var(--gold);padding:4px 10px;border-radius:20px;font-size:0.8rem;
                 display:flex;align-items:center;gap:6px">
      ${p.name}
      <span onclick="togglePassenger('${p.id}','${p.name}')"
        style="cursor:pointer;opacity:0.7;font-weight:bold">×</span>
    </span>`).join('');
}

/* ══════════════════════════════════════════════════════════
   IR SOZINHO — CORREÇÃO BUG 1
   IDA: endereço do vendedor → local de reunião
   ══════════════════════════════════════════════════════════ */
async function startDriverAlone() {
  if (!currentMeetingLocation) { showToast('Selecione um local de reunião.', 'error'); return; }
  const homeAddr = getUserAddress();
  const meetingAddr = getMeetingLocationAddress();
  if (!homeAddr) { showToast('Endereço residencial não encontrado no cadastro.', 'error'); return; }

  isSoloMode = true;
  currentDriverRole = 'solo';
  soloReturnStarted = false;
  sessionGpsTrack = [];
  soloReturnTrack = [];

  // Salva sessão ANTES de abrir Maps
  await saveMeetingSession('solo');

  // Nav GPS Dinâmico (IDA)
  openDriverMapRoute(false);

  showMeetingView('meeting-driver-route');
  const sub = document.querySelector('#meeting-driver-route .status-v2-subtitle');
  if (sub) sub.textContent = 'Dirigindo sozinho até a reunião.';
  const pl = document.getElementById('driver-pickup-list');
  if (pl) pl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:10px 0">Modo Ir Sozinho — sem caronas.</p>';
  const bp = document.getElementById('btn-driver-confirm-presence');
  if (bp) { bp.classList.remove('hidden'); bp.textContent = '✓  Cheguei na Reunião'; }
  showToast('Rota de ida aberta no Google Maps!', 'success');
}

/* ── Com caronas ── */
async function startDriverRoute() {
  if (!currentMeetingLocation) { showToast('Selecione um local de reunião.', 'error'); return; }
  if (!selectedPassengers.length) { showToast('Adicione ao menos uma carona ou use "Ir Sozinho".', 'error'); return; }
  isSoloMode = false;
  currentDriverRole = 'driver';
  sessionGpsTrack = [];
  await saveMeetingSession('driver');
  showMeetingView('meeting-driver-route');
  renderPickupList();
  openDriverMapRoute(false);
}

function renderPickupList() {
  const list = document.getElementById('driver-pickup-list');
  if (!list) return;
  list.innerHTML = selectedPassengers.map((p, i) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <span style="background:var(--gold);color:var(--bg);width:24px;height:24px;border-radius:50%;
                   display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800">
        ${i + 1}</span>
      <span style="flex:1;font-size:0.9rem">${p.name}</span>
      <span style="font-size:0.75rem;color:var(--muted)">Aguardando</span>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════
   ABRIR MAPS — CORREÇÃO BUG 2
   isReturn=false → origem: casa  / destino: reunião
   isReturn=true  → origem: reunião / destino: casa (cadastro)
   ══════════════════════════════════════════════════════════ */
async function openDriverMapRoute(isReturn) {
  const meetingAddr = getMeetingLocationAddress();
  if (!meetingAddr) { showToast('Local de reunião não definido.', 'error'); return; }

  // 1. PONTO DE PARTIDA: GPS ou CASA
  let origin = 'Minha localização'; // Fallback pro Maps usar GPS do celular

  if (!isReturn) {
    // ── IDA: atual -> paradas -> reunião ──
    const waypoints = [];

    // Tenta buscar GPS de cada carona para pegar o endereço exato de onde eles estão
    if (selectedPassengers && selectedPassengers.length > 0) {
      showToast('Buscando localização das caronas...', 'info');
      for (const p of selectedPassengers) {
        try {
          const { data: v } = await window._supabase.from('vendedores').select('lat, lon').eq('uid', p.uid).maybeSingle();
          if (v && v.lat && v.lon) {
            // Se tem GPS, usa as coordenadas para o Maps ir no ponto exato
            waypoints.push(`${v.lat},${v.lon}`);
          } else {
            // Caso contrário, usa o endereço cadastrado (ou o nome)
            waypoints.push(p.address || p.name);
          }
        } catch (e) { waypoints.push(p.address || p.name); }
      }
    }

    const url = buildMapsUrl('Minha localização', meetingAddr, waypoints);
    window.open(url, '_blank');
  } else {
    // ── RETORNO: reunião -> casa motorista ──
    const homeAddr = getUserAddress();
    if (!homeAddr) {
      showToast('Endereço residencial não encontrado no cadastro.', 'error');
      return;
    }
    const url = buildMapsUrl(meetingAddr, homeAddr);
    soloReturnStarted = true;
    soloReturnTrack = [];
    updateReturnInSession();
    window.open(url, '_blank');
  }
}

async function updateReturnInSession() {
  if (!currentMeetingId) return;
  try {
    await window._supabase.from('meeting_sessions')
      .update({ return_started_at: new Date().toISOString() })
      .eq('id', currentMeetingId);
  } catch (e) { console.warn(e); }
}

/* ── Confirmar presença na reunião ── */
async function driverConfirmPresence() {
  document.getElementById('btn-driver-confirm-presence')?.classList.add('hidden');
  document.getElementById('driver-meeting-in-progress')?.classList.remove('hidden');
  await updateSessionStatus('at_meeting');
  showToast('Presença confirmada na reunião!', 'success');
}

/* ══════════════════════════════════════════════════════════
   INICIAR VOLTA / RETORNO
   ══════════════════════════════════════════════════════════ */
async function endMeeting() {
  showMeetingView('meeting-driver-return');
  if (isSoloMode) {
    const dl = document.getElementById('driver-dropoff-list');
    if (dl) dl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:10px 0">Modo Ir Sozinho — sem caronas.</p>';
  } else {
    renderDropoffList();
  }
  document.getElementById('btn-driver-arrived-home')?.classList.remove('hidden');
  await updateSessionStatus('returning');
  // Abre automaticamente o Maps de retorno (reunião → casa)
  openDriverMapRoute(true);
}

function renderDropoffList() {
  const list = document.getElementById('driver-dropoff-list');
  if (!list) return;
  list.innerHTML = selectedPassengers.map((p, i) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <span style="background:rgba(46,213,115,0.2);color:#2ed573;width:24px;height:24px;border-radius:50%;
                   display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800">
        ${i + 1}</span>
      <span style="flex:1;font-size:0.9rem">${p.name}</span>
      <button onclick="confirmDropoff('${p.id}',this)"
        style="font-size:0.75rem;padding:4px 10px;border-radius:10px;background:rgba(46,213,115,0.1);
               color:#2ed573;border:1px solid rgba(46,213,115,0.3);cursor:pointer">
        Desembarcar</button>
    </div>`).join('');
}

function confirmDropoff(id, btn) {
  btn.textContent = '✓ Desembarcado';
  btn.disabled = true;
  btn.style.opacity = '0.5';
}

/* ── Finalizar turno ── */
async function driverArrivedHome() {
  await finalizeSession();
  isSoloMode = false; selectedPassengers = []; currentMeetingLocation = null;
  currentMeetingId = null; soloReturnStarted = false;
  sessionGpsTrack = []; soloReturnTrack = [];
  showMeetingView('meeting-role-select');
  showToast('Turno finalizado! Bom descanso.', 'success');
}

/* ── Individual ── */
async function individualConfirmPresence() {
  document.getElementById('btn-individual-confirm')?.classList.add('hidden');
  document.getElementById('individual-confirmed')?.classList.remove('hidden');
  await saveMeetingSession('individual');
  await updateSessionStatus('at_meeting');
  showToast('Presença confirmada!', 'success');
}

function cancelIndividual() {
  showMeetingView('meeting-role-select');
  currentMeetingLocation = null;
}

/* ── Helpers de Quilometragem ── */
function _haversineKm(p1, p2) {
  if (!p1 || !p2 || !p1.lat || !p2.lat) return 0;
  const R = 6371; // Raio da Terra em km
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateTotalDistance(track) {
  let total = 0;
  if (!track || track.length < 2) return 0;
  for (let i = 0; i < track.length - 1; i++) {
    total += _haversineKm(track[i], track[i + 1]);
  }
  return total;
}

/* ══════════════════════════════════════════════════════════
   SUPABASE — salvar sessão
   ══════════════════════════════════════════════════════════ */
async function saveMeetingSession(type) {
  try {
    const p = window._userProfile || {};
    const home = getUserAddress();
    const meeting = getMeetingLocationAddress();

    // MONTAGEM DO TRAJETO PREVISTO (ITINERÁRIO LÓGICO)
    let stops = [];
    stops.push({ label: 'CASA VENDEDOR', address: home });

    if (type === 'driver') {
      selectedPassengers.forEach(pax => {
        stops.push({ label: `BUSCAR: ${pax.name.split(' ')[0]}`, address: pax.address || 'Não informado' });
      });
    }

    stops.push({ label: 'REUNIÃO', address: meeting });

    if (type === 'driver') {
      selectedPassengers.forEach(pax => {
        stops.push({ label: `DEVOLVER: ${pax.name.split(' ')[0]}`, address: pax.address || 'Não informado' });
      });
    }

    stops.push({ label: 'VOLTA CASA', address: home });

    const payload = {
      driver_id: window._currentUserId || null,
      driver_name: p.name || 'Vendedor',
      meeting_location_name: currentMeetingLocation?.name || '',
      meeting_location_address: currentMeetingLocation?.address || '',
      meeting_location_lat: currentMeetingLocation?.lat || null,
      meeting_location_lng: currentMeetingLocation?.lng || null,
      meeting_type: type,
      vehicle_type: currentVehicleType,
      passengers: selectedPassengers,
      status: 'outbound',
      date: new Date().toISOString().split('T')[0],
      home_address: home,
      predicted_route: stops
    };

    if (currentMeetingId) {
      // SE JÁ EXISTE, APENAS ATUALIZA (EVITA DUPLICATAS)
      const { error } = await window._supabase
        .from('meeting_sessions')
        .update(payload)
        .eq('id', currentMeetingId);
      if (error) throw error;
      console.log('[UniRotas] Sessão atualizada (sem duplicar):', currentMeetingId);
    } else {
      // SE NÃO EXISTE, CRIA NOVA
      const { data, error } = await window._supabase
        .from('meeting_sessions')
        .insert([{
          ...payload,
          created_at: new Date().toISOString()
        }])
        .select().single();
      if (error) throw error;
      currentMeetingId = data.id;
      console.log('[UniRotas] Nova sessão criada:', currentMeetingId);
    }
  } catch (e) {
    console.error('[UniRotas] Erro ao salvar sessão:', e);
    showToast('Aviso: sessão não registrada.', 'error');
  }
}

async function updateSessionStatus(status) {
  if (!currentMeetingId) return;
  try {
    const upd = { status };
    if (status === 'finalized') upd.finalized_at = new Date().toISOString();
    await window._supabase.from('meeting_sessions').update(upd).eq('id', currentMeetingId);
  } catch (e) { console.warn(e); }
}

async function finalizeSession() {
  if (!currentMeetingId) return;
  try {
    const kmOutbound = calculateTotalDistance(sessionGpsTrack);
    const kmReturn = calculateTotalDistance(soloReturnTrack);
    const totalKm = kmOutbound + kmReturn;

    await window._supabase.from('meeting_sessions').update({
      status: 'finalized',
      finalized_at: new Date().toISOString(),
      gps_track: sessionGpsTrack,
      return_track: soloReturnTrack,
      total_km: totalKm
    }).eq('id', currentMeetingId);

    console.log(`[UniRotas] Sessão finalizada. Km: ${totalKm.toFixed(2)}`);
  } catch (e) { console.warn(e); }
}

/* ── GPS tracking ── */
function recordGpsPoint(lat, lng) {
  const pt = { lat, lng, ts: Date.now() };
  if (soloReturnStarted) soloReturnTrack.push(pt);
  else sessionGpsTrack.push(pt);
  const track = soloReturnStarted ? soloReturnTrack : sessionGpsTrack;
  const field = soloReturnStarted ? 'return_track' : 'gps_track';
  if (track.length % 5 === 0 && currentMeetingId) {
    window._supabase.from('meeting_sessions')
      .update({ [field]: track }).eq('id', currentMeetingId)
      .then(({ error }) => { if (error) console.warn(error); });
  }
}

/* ── Cancelar ── */
async function cancelDriverRoute() {
  if (currentMeetingId) await updateSessionStatus('cancelled');
  isSoloMode = false; selectedPassengers = []; currentMeetingLocation = null;
  currentMeetingId = null; soloReturnStarted = false;
  sessionGpsTrack = []; soloReturnTrack = [];
  showMeetingView('meeting-role-select');
}

/* ── Notificações de carona ── */
function handleNotifAccept() {
  document.getElementById('notification-modal')?.classList.add('hidden');
  showMeetingView('meeting-passenger-active');
}
function handleNotifRefuse() {
  document.getElementById('notification-modal')?.classList.add('hidden');
}
function passengerConfirmBoarding() {
  document.getElementById('passenger-boarding-card')?.classList.add('hidden');
  showToast('Embarque confirmado!', 'success');
}
function passengerRejectBoarding() {
  document.getElementById('passenger-boarding-card')?.classList.add('hidden');
}
function cancelPassengerWaiting() { showMeetingView('meeting-role-select'); }

/* ── Simulação DEV ── */
async function startMeetingSimulation(isReturn = false) {
  showToast(isReturn ? 'Simulando retorno...' : 'Simulando rota completa...', 'info');
  if (!currentMeetingId) await saveMeetingSession(isSoloMode ? 'solo' : 'driver');
  const fake = Array.from({ length: 10 }, (_, i) => ({
    lat: -20.3 + i * 0.005, lng: -40.3 + i * 0.005, ts: Date.now() + i * 60000
  }));
  if (isReturn) {
    soloReturnTrack = fake; soloReturnStarted = true;
    await updateSessionStatus('returning');
  } else {
    sessionGpsTrack = fake;
    await updateSessionStatus('at_meeting');
  }
  await finalizeSession();
  showToast('Simulação concluída. Verifique em Revisão de Reuniões.', 'success');
}

/* ══════════════════════════════════════════════════════════
   EXPOSIÇÃO GLOBAL
   ══════════════════════════════════════════════════════════ */
window.selectRole = selectRole;
window.selectMeetingLocation = selectMeetingLocation;
window.driverVehicleType = driverVehicleType;
window.startDriverRoute = startDriverRoute;
window.startDriverAlone = startDriverAlone;
window.openDriverMapRoute = openDriverMapRoute;
window.driverConfirmPresence = driverConfirmPresence;
window.endMeeting = endMeeting;
window.driverArrivedHome = driverArrivedHome;
window.individualConfirmPresence = individualConfirmPresence;
window.cancelIndividual = cancelIndividual;
window.cancelDriverRoute = cancelDriverRoute;
window.handleNotifAccept = handleNotifAccept;
window.handleNotifRefuse = handleNotifRefuse;
window.passengerConfirmBoarding = passengerConfirmBoarding;
window.passengerRejectBoarding = passengerRejectBoarding;
window.cancelPassengerWaiting = cancelPassengerWaiting;
window.startMeetingSimulation = startMeetingSimulation;
window.recordGpsPoint = recordGpsPoint;
window.showMeetingView = showMeetingView;
window.filterDriverSearch = filterDriverSearch;
window.togglePassenger = togglePassenger;
window.confirmDropoff = confirmDropoff;