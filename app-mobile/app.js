(() => {
  const CONFIG = {
    supabaseUrl: "https://vbbdlxcrxssllshskhuz.supabase.co",
    supabaseRestUrl: "https://vbbdlxcrxssllshskhuz.supabase.co/rest/v1/",
    supabasePublishableKey: "sb_publishable_WhasDQLv43zOZBDpyz9dgA_KpJfQntL",
    googleMapsKey: "AIzaSyAO46S-g-tbXDg9aljUNajplLQV_3i7c9Q",
    rates: { car: 0.9, moto: 0.4, bus: 0, other: 0 },
    presenceRadiusMeters: 300
  };
  const ENTRY_MODE = document.body?.dataset.appEntry === "mobile" ? "mobile" : "manager";
  const DEFAULT_LOGIN_TAB = ENTRY_MODE === "mobile" ? "mobile" : "manager";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const fmtMoney = value => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fmtKm = value => `${value.toFixed(1).replace(".", ",")} km`;
  const nowIso = () => new Date().toISOString();
  const icon = () => window.lucide?.createIcons?.();
  let sbClient = null;
  const STORAGE_KEY = `unilider_rotas_funcional_v3_${ENTRY_MODE}`;

  const defaultState = {
    activeApp: "login",
    loginTab: DEFAULT_LOGIN_TAB,
    managerPanel: "overview",
    selectedRouteLeg: "all",
    selectedMessageSellerId: null,
    mobilePanel: "home",
    mobileSheetCollapsed: false,
    mobileApproved: false,
    sessionUser: null,
    currentProfile: null,
    mobileTrip: {
      role: null,
      meetingId: null,
      vehicle: "car",
      status: "idle",
      atMeeting: false,
      passengers: [],
      chat: []
    },
    data: emptyData()
  };

  const state = loadState();

  function emptyData() {
    return {
      sellers: [],
      meetings: [],
      routes: [],
      feedback: [],
      messages: [],
      notifications: [],
      supportTickets: [],
      attendance: []
    };
  }

  function coord(lat, lng) {
    return { lat, lng };
  }

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return mergeState(defaultState, JSON.parse(stored));
    } catch (error) {
      console.warn("Nao foi possivel carregar estado local", error);
    }
    return structuredClone(defaultState);
  }

  function mergeState(base, incoming) {
    const copy = structuredClone(base);
    return {
      ...copy,
      ...incoming,
      mobileTrip: { ...copy.mobileTrip, ...(incoming.mobileTrip || {}) },
      data: { ...copy.data, ...(incoming.data || {}) }
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function supabaseClient() {
    if (sbClient) return sbClient;
    if (window.supabase?.createClient) {
      sbClient = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey);
    }
    return sbClient;
  }

  async function remoteAttempt(promise, ms = 1200) {
    if (!promise) return null;
    return Promise.race([
      promise,
      new Promise(resolve => window.setTimeout(() => resolve({ timedOut: true }), ms))
    ]);
  }

  async function restSelect(table, query = "select=*") {
    const response = await fetch(`${CONFIG.supabaseRestUrl}${table}?${query}`, {
      headers: {
        apikey: CONFIG.supabasePublishableKey,
        Authorization: `Bearer ${CONFIG.supabasePublishableKey}`
      }
    });
    if (!response.ok) throw new Error(`Supabase REST ${table}: ${response.status}`);
    return response.json();
  }

  async function selectRows(table, build = query => query) {
    const client = supabaseClient();
    if (!client) throw new Error("Biblioteca Supabase nao carregada.");
    const { data, error } = await build(client.from(table).select("*"));
    if (error) throw error;
    return data || [];
  }

  async function insertRow(table, payload) {
    const { data, error } = await supabaseClient().from(table).insert(payload).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function updateRow(table, payload, column, value) {
    const { data, error } = await supabaseClient().from(table).update(payload).eq(column, value).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function upsertRow(table, payload, onConflict) {
    const { data, error } = await supabaseClient().from(table).upsert(payload, { onConflict }).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deleteRow(table, column, value) {
    const { error } = await supabaseClient().from(table).delete().eq(column, value);
    if (error) throw error;
  }

  async function currentSession() {
    const { data, error } = await supabaseClient().auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async function getProfile(uid) {
    const { data, error } = await supabaseClient()
      .from("usuarios")
      .select("*")
      .eq("uid", uid)
      .maybeSingle();
    if (error) throw error;
    return data ? normalizeSeller(data) : null;
  }

  async function loginWithSupabase(email, password) {
    const { data, error } = await supabaseClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    state.sessionUser = data.user || null;
    state.currentProfile = data.user ? await getProfile(data.user.id) : null;
    return data.user;
  }

  async function ensureExistingSession() {
    const session = await currentSession();
    state.sessionUser = session?.user || null;
    state.currentProfile = session?.user ? await getProfile(session.user.id) : null;
    return session;
  }

  async function refreshRemoteData() {
    await ensureExistingSession();
    const [users, meetings, routes, events, messages, feedback, attendance, notifications, supportTickets] = await Promise.all([
      selectRows("usuarios", query => query.order("created_at", { ascending: false })),
      selectRows("meeting_locations", query => query.order("meeting_date", { ascending: true }).order("meeting_time", { ascending: true })),
      selectRows("route_sessions", query => query.order("created_at", { ascending: false }).limit(300)),
      selectRows("route_events", query => query.order("created_at", { ascending: true }).limit(800)),
      safeRows("ride_messages", query => query.order("created_at", { ascending: true }).limit(300)),
      safeRows("app_feedback", query => query.neq("hidden", true).order("created_at", { ascending: false }).limit(200)),
      safeRows("attendance_records", query => query.order("confirmed_at", { ascending: false }).limit(300)),
      safeRows("app_notifications", query => query.order("created_at", { ascending: false }).limit(100)),
      safeRows("support_tickets", query => query.order("created_at", { ascending: false }).limit(100))
    ]);

    const sellers = users.map(normalizeSeller);
    const normalizedMeetings = meetings.map(normalizeMeeting);
    const normalizedRoutes = routes.map(row => normalizeRoute(row, events));
    const normalizedMessages = normalizeMessages(messages, sellers);

    state.data = {
      sellers,
      meetings: normalizedMeetings,
      routes: normalizedRoutes,
      feedback: feedback.map(item => ({
        id: item.id,
        sellerId: item.user_uid,
        title: item.title || "Feedback",
        text: item.message || "",
        createdAt: item.created_at
      })),
      messages: normalizedMessages,
      notifications: notifications.map(item => ({
        id: item.id,
        type: item.type || "info",
        text: item.body || item.title || "",
        read: item.read === true
      })),
      supportTickets: supportTickets.map(item => ({
        id: item.id,
        sellerId: item.user_uid,
        title: item.subject || "Chamado",
        text: item.message || "",
        status: item.status || "open",
        createdAt: item.created_at
      })),
      attendance
    };

    state.selectedMessageSellerId = state.selectedMessageSellerId || sellers.find(item => item.role !== "manager" && item.approved)?.id || null;
    state.mobileTrip.meetingId = state.mobileTrip.meetingId || normalizedMeetings[0]?.id || null;
    state.mobileApproved = state.currentProfile?.approved === true;
    saveState();
  }

  async function safeRows(table, build = query => query) {
    try {
      return await selectRows(table, build);
    } catch (error) {
      console.warn(`Tabela ${table} indisponivel ou bloqueada por RLS`, error);
      return [];
    }
  }

  function normalizeSeller(row) {
    const uid = row.uid || null;
    const id = uid || row.id;
    return {
      id,
      dbId: row.id,
      uid,
      name: row.name || row.email || "Sem nome",
      cpf: row.cpf || "",
      email: row.email || "",
      address: row.address || "",
      costCenter: row.cost_center || "",
      approved: row.approved === true,
      status: row.approved ? (row.status || "offline") : "pending",
      transport: row.transport || "other",
      role: row.role || "seller",
      home: usablePoint(row.home_lat, row.home_lng) || { lat: -23.5505, lng: -46.6333 }
    };
  }

  function normalizeMeeting(row) {
    return {
      id: row.id,
      name: row.name || "Reuniao",
      address: row.address || "",
      date: row.meeting_date || "",
      time: String(row.meeting_time || "").slice(0, 5),
      radius: Number(row.radius_m || CONFIG.presenceRadiusMeters),
      point: usablePoint(row.lat, row.lng) || { lat: -23.5505, lng: -46.6333 },
      active: row.active !== false
    };
  }

  function normalizeRoute(row, events) {
    const routeEvents = events.filter(item => item.route_id === row.id);
    return {
      id: row.id,
      driverId: row.driver_uid,
      meetingId: row.meeting_id,
      vehicle: row.vehicle || "car",
      status: row.status || "active",
      createdAt: row.created_at,
      passengers: Array.isArray(row.passengers) ? row.passengers.map(normalizePassenger) : [],
      planned: normalizeRouteSegments(row.planned_route),
      real: normalizeRouteSegments(row.real_route),
      events: routeEvents.map(event => ({
        leg: event.leg || "outbound",
        time: timeOnly(event.created_at),
        type: event.event_type || "event",
        text: event.message || ""
      }))
    };
  }

  function normalizePassenger(item) {
    return {
      sellerId: item.uid || item.sellerId,
      status: item.status || "added",
      pickedAt: timeOnly(item.boardedAt || item.pickedAt),
      droppedAt: timeOnly(item.droppedAt),
      confirmedPresence: item.confirmedPresence === true
    };
  }

  function normalizeRouteSegments(value) {
    const parsed = Array.isArray(value) ? value : [];
    if (parsed[0]?.points) {
      return parsed.map(segment => ({
        leg: segment.leg || "outbound",
        points: (segment.points || []).map(normalizePoint).filter(Boolean)
      }));
    }

    const points = parsed.map(normalizePoint).filter(Boolean);
    const returnIndex = points.findIndex(item => item.kind === "return" || item.kind === "meeting-end");
    if (returnIndex >= 0) {
      return [
        { leg: "outbound", points: points.slice(0, returnIndex + 1) },
        { leg: "return", points: points.slice(returnIndex) }
      ];
    }
    return points.length ? [{ leg: "outbound", points }] : [];
  }

  function normalizePoint(item) {
    const p = point(item.lat, item.lng);
    if (!p) return null;
    return {
      ...p,
      kind: item.kind || item.type || "point",
      label: item.label || "Ponto"
    };
  }

  function normalizeMessages(rows, sellers) {
    const managerUid = state.currentProfile?.uid;
    const manager = sellers.find(item => item.role === "manager");
    const isManager = state.currentProfile?.role === "manager";
    return rows.map(row => {
      const otherUid = row.sender_uid === managerUid ? row.receiver_uid : row.sender_uid;
      const sellerId = isManager ? otherUid : (manager?.uid || manager?.id || otherUid);
      const from = isManager
        ? row.sender_uid === managerUid ? "manager" : "seller"
        : row.sender_uid === managerUid ? "seller" : "manager";
      return {
        id: row.id,
        sellerId,
        from,
        text: row.body || "",
        time: timeOnly(row.created_at),
        routeOnly: Boolean(row.route_id),
        sellerName: sellers.find(item => item.id === sellerId)?.name || "Vendedor"
      };
    });
  }

  function point(lat, lng) {
    const y = Number(lat);
    const x = Number(lng);
    if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
    return { lat: y, lng: x };
  }

  function usablePoint(lat, lng) {
    const p = point(lat, lng);
    if (!p) return null;
    if (Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001) return null;
    return p;
  }

  function pointWithFallback(value, fallback) {
    return usablePoint(value?.lat, value?.lng) || fallback;
  }

  function managerProfile() {
    return state.data.sellers.find(item => item.role === "manager") || null;
  }

  function greetingByHour(date = new Date()) {
    const hour = date.getHours();
    if (hour < 12) return "Bom dia";
    if (hour < 18) return "Boa tarde";
    return "Boa noite";
  }

  function timeOnly(value) {
    if (!value) return "";
    return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function seller(id) {
    return state.data.sellers.find(item => item.id === id) || null;
  }

  function appSellers() {
    return state.data.sellers.filter(item => item.role !== "manager");
  }

  function meeting(id) {
    return state.data.meetings.find(item => item.id === id) || null;
  }

  function currentSeller() {
    return seller(state.currentProfile?.uid)
      || state.data.sellers.find(item => item.email === state.sessionUser?.email)
      || appSellers().find(item => item.approved)
      || {
        id: state.sessionUser?.id || "current-user",
        uid: state.sessionUser?.id || "current-user",
        name: state.sessionUser?.email || "Vendedor",
        cpf: "",
        email: state.sessionUser?.email || "",
        address: "",
        costCenter: "",
        approved: false,
        status: "pending",
        transport: "other",
        home: { lat: -23.5505, lng: -46.6333 }
      };
  }

  function vehicleLabel(vehicle) {
    return ({ car: "Carro", moto: "Moto", bus: "Onibus", other: "Outro" })[vehicle] || vehicle;
  }

  function initials(name) {
    return name.split(" ").map(part => part[0]).slice(0, 2).join("").toUpperCase();
  }

  function distanceMeters(a, b) {
    if (!a || !b) return 0;
    const R = 6371e3;
    const p1 = a.lat * Math.PI / 180;
    const p2 = b.lat * Math.PI / 180;
    const dp = (b.lat - a.lat) * Math.PI / 180;
    const dl = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function pathKm(points) {
    if (!points || points.length < 2) return 0;
    const meters = points.slice(1).reduce((total, point, index) => total + distanceMeters(points[index], point), 0);
    return meters / 1000 * 1.22;
  }

  function routeKm(route, kind, leg = "all") {
    return segments(route, kind, leg).reduce((total, item) => total + pathKm(item.points), 0);
  }

  function routeCost(route, kind, leg = "all") {
    return routeKm(route, kind, leg) * (CONFIG.rates[route.vehicle] || 0);
  }

  function segments(route, kind, leg = "all") {
    const list = route[kind] || [];
    return leg === "all" ? list : list.filter(item => item.leg === leg);
  }

  function routePoints(route, kind, leg = "all") {
    return segments(route, kind, leg).flatMap(item => item.points);
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
  }

  function serializeSegments(list = []) {
    return list.map(segment => ({
      leg: segment.leg || "outbound",
      points: (segment.points || []).map(item => ({
        kind: item.kind || "point",
        label: item.label || "Ponto",
        lat: Number(item.lat),
        lng: Number(item.lng)
      })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng))
    }));
  }

  function routeSessionPayload(route) {
    return {
      driver_uid: route.driverId,
      meeting_id: route.meetingId,
      vehicle: route.vehicle,
      status: route.status,
      planned_route: serializeSegments(route.planned),
      real_route: serializeSegments(route.real),
      passengers: (route.passengers || []).map(item => ({
        uid: item.sellerId,
        sellerId: item.sellerId,
        status: item.status || "invited",
        pickedAt: item.pickedAt || null,
        droppedAt: item.droppedAt || null,
        confirmedPresence: item.confirmedPresence === true
      })),
      planned_km: Number(routeKm(route, "planned").toFixed(2)),
      real_km: Number(routeKm(route, "real").toFixed(2)),
      planned_cost: Number(routeCost(route, "planned").toFixed(2)),
      real_cost: Number(routeCost(route, "real").toFixed(2)),
      started_at: route.startedAt || route.createdAt || nowIso()
    };
  }

  async function createRemoteRoute(route) {
    const inserted = await insertRow("route_sessions", routeSessionPayload(route));
    route.id = inserted.id;
    route.createdAt = inserted.created_at || route.createdAt;
    await Promise.all((route.events || []).map(event => insertRouteEvent(route, event)));
    return route;
  }

  async function updateRemoteRoute(route) {
    if (!route || !isUuid(route.id)) return null;
    return updateRow("route_sessions", routeSessionPayload(route), "id", route.id);
  }

  async function insertRouteEvent(route, event, pointValue = null) {
    if (!route || !isUuid(route.id) || !event) return null;
    return insertRow("route_events", {
      route_id: route.id,
      actor_uid: state.currentProfile?.uid || route.driverId,
      leg: event.leg || "outbound",
      event_type: event.type || "event",
      message: event.text || "",
      lat: pointValue?.lat || null,
      lng: pointValue?.lng || null
    });
  }

  function sellerUpdateTarget(item) {
    if (!item) return ["uid", ""];
    return item.uid ? ["uid", item.uid] : ["id", item.dbId || item.id];
  }

  function getCurrentPositionPoint(fallback) {
    return new Promise(resolve => {
      if (!navigator.geolocation) {
        resolve(fallback);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        position => resolve(usablePoint(position.coords.latitude, position.coords.longitude) || fallback),
        () => resolve(fallback),
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 }
      );
    });
  }

  function showToast(text, type = "info") {
    const toast = $("#toast");
    toast.textContent = text;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.className = "toast";
    }, 3300);
  }

  function showScreen(name) {
    state.activeApp = name;
    saveState();
    $("#login-screen").classList.toggle("hidden", name !== "login");
    $("#loading-screen").classList.toggle("hidden", name !== "loading");
    $("#manager-app").classList.toggle("hidden", name !== "manager");
    $("#mobile-app").classList.toggle("hidden", name !== "mobile");
    $("#back-to-manager").classList.toggle("hidden", name !== "mobile" || !state.wasManager);
    if (name === "manager") renderManager();
    if (name === "mobile") renderMobile();
    icon();
  }

  function withLoading(copy, next) {
    $("#loading-copy").textContent = copy;
    showScreen("loading");
    window.setTimeout(next, 780);
  }

  async function withLoadingAsync(copy, task) {
    $("#loading-copy").textContent = copy;
    showScreen("loading");
    await new Promise(resolve => window.setTimeout(resolve, 450));
    return task();
  }

  function setLoginTab(tab) {
    const safeTab = tab === ENTRY_MODE ? tab : DEFAULT_LOGIN_TAB;
    state.loginTab = safeTab;
    $$(".login-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.loginTab === safeTab));
    $("#manager-login-form").classList.toggle("hidden", safeTab !== "manager");
    $("#mobile-login-form").classList.toggle("hidden", safeTab !== "mobile");
    saveState();
  }

  function bindLogin() {
    $$(".login-tab").forEach(btn => btn.addEventListener("click", () => setLoginTab(btn.dataset.loginTab)));

    $("#manager-login-form").addEventListener("submit", async event => {
      event.preventDefault();
      const user = $("#manager-user").value.trim();
      const pass = $("#manager-pass").value;
      try {
        await withLoadingAsync("Validando permissoes do gestor...", async () => {
          await loginWithSupabase(user, pass);
          if (!state.currentProfile || state.currentProfile.role !== "manager" || !state.currentProfile.approved) {
            await supabaseClient().auth.signOut();
            throw new Error("Este usuario nao esta marcado como gestor aprovado em usuarios.");
          }
          await refreshRemoteData();
          state.wasManager = true;
          showScreen("manager");
        });
      } catch (error) {
        showScreen("login");
        showToast(error.message || "Nao foi possivel entrar no painel.", "error");
      }
    });

    $("#mobile-login-form").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        const email = $("#mobile-email").value.trim();
        const pass = $("#mobile-pass").value;
        await withLoadingAsync("Carregando GPS, reunioes e status de aprovacao...", async () => {
          await loginWithSupabase(email, pass);
          if (!state.currentProfile) throw new Error("Perfil nao encontrado. Solicite cadastro novamente.");
          await refreshRemoteData();
          state.wasManager = false;
          showScreen("mobile");
        });
      } catch (error) {
        showScreen("login");
        showToast(error.message || "Nao foi possivel entrar no aplicativo.", "error");
      }
    });

    $("#open-mobile-demo").addEventListener("click", async () => {
      try {
        await withLoadingAsync("Abrindo app mobile com dados reais...", async () => {
          await refreshRemoteData();
          state.wasManager = false;
          showScreen("mobile");
        });
      } catch (error) {
        showScreen("login");
        showToast("Entre no Supabase antes de abrir o app mobile.", "warning");
      }
    });

    $("#show-register").addEventListener("click", openRegisterModal);
    $("#recover-password").addEventListener("click", openRecoveryModal);
  }

  function renderManager() {
    switchPanel(state.managerPanel);
    renderMetrics();
    renderOverview();
    renderRoutes();
    renderSellers();
    renderApprovals();
    renderMeetings();
    renderPresence();
    renderMessages();
    renderFeedback();
    icon();
  }

  function switchPanel(panel) {
    state.managerPanel = panel;
    const titles = {
      overview: "Resumo",
      routes: "Rotas",
      sellers: "Vendedores",
      approvals: "Aprovacoes",
      meetings: "Reunioes",
      presence: "Presenca",
      messages: "Mensagens",
      feedback: "Feedbacks"
    };
    $("#manager-title").textContent = titles[panel] || "Resumo";
    $$(".side-link").forEach(btn => btn.classList.toggle("active", btn.dataset.panel === panel));
    $$(".panel").forEach(item => item.classList.toggle("active", item.dataset.panelView === panel));
    saveState();
  }

  function renderMetrics() {
    const routes = state.data.routes;
    const payableRoutes = routes.filter(route => ["car", "moto"].includes(route.vehicle));
    const realKm = payableRoutes.reduce((total, route) => total + routeKm(route, "real"), 0);
    const cost = payableRoutes.reduce((total, route) => total + routeCost(route, "real"), 0);
    const pending = appSellers().filter(item => !item.approved).length;
    const metrics = [
      ["route", "Rotas monitoradas", routes.length],
      ["wallet", "Custo estimado", fmtMoney(cost)],
      ["gauge", "KM auditado", fmtKm(realKm)],
      ["user-check", "Cadastros pendentes", pending]
    ];

    $("#metric-grid").innerHTML = metrics.map(([ic, label, value]) => `
      <article class="metric-card">
        <i data-lucide="${ic}"></i>
        <span>${label}</span>
        <strong>${value}</strong>
      </article>
    `).join("") || `<p class="form-note">Nenhum vendedor cadastrado.</p>`;
  }

  function renderOverview() {
    $("#attention-routes").innerHTML = state.data.routes
      .filter(route => route.status !== "completed")
      .map(route => {
        const driver = seller(route.driverId);
        const place = meeting(route.meetingId);
        return `
          <div class="compact-row">
            <div>
              <strong>${driver?.name || "Motorista"}</strong>
              <span>${place?.name || "Reuniao"} - ${vehicleLabel(route.vehicle)}</span>
            </div>
            <span class="status-pill ${route.status}">${statusLabel(route.status)}</span>
          </div>
        `;
      }).join("") || `<p class="form-note">Nenhuma rota pendente.</p>`;

    $("#pending-overview").innerHTML = appSellers()
      .filter(item => !item.approved)
      .map(item => `
        <div class="compact-row">
          <div>
            <strong>${item.name}</strong>
            <span>${item.costCenter} - ${item.address}</span>
          </div>
          <button class="tiny-button" data-approve="${item.id}">Aprovar</button>
        </div>
      `).join("") || `<p class="form-note">Nenhum cadastro pendente.</p>`;
  }

  function renderRoutes() {
    const locationFilter = $("#route-location-filter");
    const currentLocation = locationFilter.value || "all";
    locationFilter.innerHTML = `<option value="all">Todas as reunioes</option>` + state.data.meetings
      .map(item => `<option value="${item.id}">${item.name}</option>`)
      .join("");
    locationFilter.value = state.data.meetings.some(item => item.id === currentLocation) ? currentLocation : "all";

    const status = $("#route-status-filter").value || "all";
    const routes = state.data.routes.filter(route => {
      const byPlace = locationFilter.value === "all" || route.meetingId === locationFilter.value;
      const byStatus = status === "all" || route.status === status;
      return byPlace && byStatus;
    });

    $("#routes-list").innerHTML = routes.map(route => {
      const driver = seller(route.driverId);
      const place = meeting(route.meetingId);
      return `
        <article class="route-card">
          <div class="route-driver">
            <div class="avatar">${initials(driver?.name || "Motorista")}</div>
            <div>
              <strong>${driver?.name || "Motorista"}</strong>
              <span>${place?.name || "Reuniao"}</span>
            </div>
          </div>
          <div><strong>${vehicleLabel(route.vehicle)}</strong><span>Locomocao</span></div>
          <div><strong>${route.passengers.length}</strong><span>Caronas</span></div>
          <div><strong>${fmtKm(routeKm(route, "real"))}</strong><span>KM percorrido</span></div>
          <div><strong>${fmtMoney(routeCost(route, "real"))}</strong><span>Valor a pagar</span></div>
          <div class="route-actions">
            <button class="tiny-button" data-route-detail="${route.id}">Ver rota completa</button>
            <button class="tiny-button danger" data-delete-route="${route.id}">Excluir</button>
          </div>
        </article>
      `;
    }).join("") || `<p class="form-note">Nenhuma rota encontrada para o filtro.</p>`;
    icon();
  }

  function statusLabel(status) {
    return ({ active: "Em andamento", completed: "Concluida", issue: "Ocorrencia", cancelled: "Cancelada", pending: "Pendente" })[status] || status;
  }

  function openRouteDetail(routeId, leg = state.selectedRouteLeg || "all") {
    state.selectedRouteLeg = leg;
    const route = state.data.routes.find(item => item.id === routeId);
    if (!route) return;
    const driver = seller(route.driverId);
    const place = meeting(route.meetingId);
    const plannedKm = routeKm(route, "planned", leg);
    const realKm = routeKm(route, "real", leg);
    const modal = $("#modal-card");
    modal.className = "modal-card";
    modal.innerHTML = `
      <div class="modal-head">
        <div>
          <span class="eyebrow">Rota completa</span>
          <h3>${driver?.name || "Motorista"} -> ${place?.name || "Reuniao"}</h3>
          <p class="form-note">${vehicleLabel(route.vehicle)} - ${route.passengers.length} carona(s) - ${statusLabel(route.status)}</p>
        </div>
        <button class="icon-button" data-close-modal title="Fechar"><i data-lucide="x"></i></button>
      </div>

      <div class="section-head wrap">
        <div class="segment-control" aria-label="Filtrar trecho">
          <button class="${leg === "all" ? "active" : ""}" data-route-leg="all" data-route-id="${route.id}">Tudo</button>
          <button class="${leg === "outbound" ? "active" : ""}" data-route-leg="outbound" data-route-id="${route.id}">Ida</button>
          <button class="${leg === "return" ? "active" : ""}" data-route-leg="return" data-route-id="${route.id}">Volta</button>
        </div>
        <div class="filter-row">
          <button class="soft-button" data-export-one="${route.id}"><i data-lucide="download"></i> Extrair rota completa</button>
          <button class="soft-button" data-sync-route="${route.id}"><i data-lucide="cloud-upload"></i> Enviar ao Supabase</button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="map-compare">
          <article class="map-card">
            <h4>Trajeto previsto</h4>
            <div id="planned-route-map" class="map-box"></div>
            <div class="map-summary">
              <div><span>KM previsto</span><strong>${fmtKm(plannedKm)}</strong></div>
              <div><span>Custo previsto</span><strong>${fmtMoney(routeCost(route, "planned", leg))}</strong></div>
            </div>
          </article>
          <article class="map-card">
            <h4>Trajeto real</h4>
            <div id="real-route-map" class="map-box"></div>
            <div class="map-summary">
              <div><span>KM percorrido</span><strong>${fmtKm(realKm)}</strong></div>
              <div><span>Valor a pagar</span><strong>${fmtMoney(routeCost(route, "real", leg))}</strong></div>
            </div>
          </article>
        </div>

        <aside class="surface">
          <div class="section-head">
            <div>
              <span class="eyebrow">Linha do tempo</span>
              <h3>Eventos auditados</h3>
            </div>
          </div>
          <div class="timeline">
            ${route.events
              .filter(event => leg === "all" || event.leg === leg)
              .map(event => `<div class="timeline-item"><time>${event.time}</time><div><strong>${eventTypeLabel(event.type)}</strong><span>${event.text}</span></div></div>`)
              .join("")}
          </div>
        </aside>
      </div>
    `;
    $("#modal-root").classList.remove("hidden");
    icon();
    window.setTimeout(() => {
      drawRouteMap("planned-route-map", routePoints(route, "planned", leg), "#0a49bf");
      drawRouteMap("real-route-map", routePoints(route, "real", leg), route.status === "issue" ? "#dc2626" : "#16a06a");
    }, 80);
  }

  function eventTypeLabel(type) {
    return ({
      start: "Inicio",
      pickup: "Embarque",
      issue: "Ocorrencia",
      arrive: "Chegada",
      return: "Retorno",
      dropoff: "Desembarque",
      finish: "Fim",
      gps: "GPS"
    })[type] || type;
  }

  function drawRouteMap(id, points, color) {
    const el = $(`#${id}`);
    if (!el) return;
    if (!points.length) {
      el.innerHTML = `
        <div class="map-fallback">
          <div class="fake-water"></div>
          <div class="fake-road main"></div>
          <div class="fake-road side"></div>
          <span class="map-poi park">Aguardando rota</span>
          <span class="map-poi gym">Escolha uma reuniao</span>
        </div>
      `;
      return;
    }
    if (window.google?.maps) {
      el.innerHTML = "";
      const map = new google.maps.Map(el, {
        center: points[0],
        zoom: 13,
        disableDefaultUI: true,
        clickableIcons: false,
        mapTypeControl: false,
        streetViewControl: false
      });
      const bounds = new google.maps.LatLngBounds();
      points.forEach(point => bounds.extend(point));
      const drawFallbackLine = () => new google.maps.Polyline({
        map,
        path: points,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.95,
        strokeWeight: 6
      });
      if (points.length >= 2 && google.maps.DirectionsService) {
        const directions = new google.maps.DirectionsService();
        const renderer = new google.maps.DirectionsRenderer({
          map,
          suppressMarkers: true,
          preserveViewport: true,
          polylineOptions: {
            strokeColor: color,
            strokeOpacity: 0.95,
            strokeWeight: 6
          }
        });
        directions.route({
          origin: points[0],
          destination: points.at(-1),
          waypoints: points.slice(1, -1).map(point => ({ location: point, stopover: true })),
          travelMode: google.maps.TravelMode.DRIVING
        }, (result, status) => {
          if (status === "OK" && result) renderer.setDirections(result);
          else drawFallbackLine();
        });
      } else {
        drawFallbackLine();
      }
      points.forEach((point, index) => {
        new google.maps.Marker({
          map,
          position: point,
          title: point.label,
          label: {
            text: markerLetter(point.kind, index),
            color: "#ffffff",
            fontWeight: "800"
          }
        });
      });
      map.fitBounds(bounds, 52);
      return;
    }

    el.innerHTML = `
      <div class="map-fallback">
        <div class="fake-water"></div>
        <div class="fake-road main"></div>
        <div class="fake-road side"></div>
        <div class="fake-route" style="background:${color}"></div>
        <div class="fake-car"><i data-lucide="navigation"></i></div>
        <span class="map-poi park">${points[0]?.label || "Inicio"}</span>
        <span class="map-poi gym">${points.at(-1)?.label || "Fim"}</span>
      </div>
    `;
    icon();
  }

  function markerLetter(kind, index) {
    const map = {
      home: "C",
      ride: "P",
      "ride-drop": "D",
      meeting: "R",
      "meeting-end": "S",
      "real-start": "I",
      issue: "!"
    };
    return map[kind] || String(index + 1);
  }

  function renderSellers() {
    $("#sellers-table").innerHTML = appSellers().map(item => `
      <div class="seller-row">
        <div class="route-driver">
          <div class="avatar">${initials(item.name)}</div>
          <div>
            <strong>${item.name}</strong>
            <span>${item.email}</span>
          </div>
        </div>
        <div><strong>${item.cpf}</strong><span>CPF</span></div>
        <div><strong>${item.costCenter}</strong><span>C. custo</span></div>
        <div><strong>${item.address}</strong><span>Endereco</span></div>
        <div class="seller-actions">
          <button class="tiny-button" data-message-seller="${item.id}">Mensagem</button>
          <button class="tiny-button" data-edit-seller="${item.id}">Editar</button>
          <button class="tiny-button danger" data-delete-seller="${item.id}">Excluir</button>
        </div>
      </div>
    `).join("") || `<p class="form-note">Nenhum vendedor cadastrado.</p>`;
    icon();
  }

  function renderApprovals() {
    const pending = appSellers().filter(item => !item.approved);
    $("#approval-list").innerHTML = pending.map(item => `
      <article class="approval-card">
        <h4>${item.name}</h4>
        <span>${item.email}</span>
        <p class="form-note">${item.address}<br>CPF ${item.cpf} - C. custo ${item.costCenter}</p>
        <div class="card-actions">
          <button class="tiny-button" data-approve="${item.id}">Aprovar</button>
          <button class="tiny-button danger" data-refuse="${item.id}">Recusar</button>
        </div>
      </article>
    `).join("") || `<p class="form-note">Nenhum cadastro aguardando aprovacao.</p>`;
  }

  function renderMeetings() {
    $("#meeting-list").innerHTML = state.data.meetings.map(item => `
      <article class="meeting-card">
        <h4>${item.name}</h4>
        <span>${item.date} as ${item.time}</span>
        <p class="form-note">${item.address}<br>Raio de presenca: ${item.radius}m</p>
        <div class="card-actions">
          <button class="tiny-button" data-edit-meeting="${item.id}">Editar</button>
          <button class="tiny-button danger" data-delete-meeting="${item.id}">Excluir</button>
        </div>
      </article>
    `).join("") || `<p class="form-note">Cadastre a primeira reuniao para aparecer no app mobile.</p>`;
  }

  function renderPresence() {
    const filter = $("#presence-filter");
    const previous = filter.value || "all";
    filter.innerHTML = `<option value="all">Todas as reunioes</option>` + state.data.meetings.map(item => `<option value="${item.id}">${item.name}</option>`).join("");
    filter.value = state.data.meetings.some(item => item.id === previous) ? previous : "all";

    const rows = [];
    state.data.routes.forEach(route => {
      if (filter.value !== "all" && route.meetingId !== filter.value) return;
      const driver = seller(route.driverId);
      rows.push({ name: driver?.name || "Motorista", role: "Motorista", route, status: route.events.some(e => e.type === "arrive") ? "Confirmado por GPS" : "Em validacao" });
      route.passengers.forEach(pax => rows.push({
        name: seller(pax.sellerId)?.name || "Carona",
        role: "Carona",
        route,
        status: pax.confirmedPresence ? "Confirmado com motorista" : "Pendente"
      }));
    });
    state.data.attendance.forEach(item => {
      if (filter.value !== "all" && item.meeting_id !== filter.value) return;
      const alreadyListed = rows.some(row => row.route?.id && row.route.id === item.route_id && row.name === (seller(item.user_uid)?.name || ""));
      if (alreadyListed) return;
      rows.push({
        name: seller(item.user_uid)?.name || "Vendedor",
        role: item.role === "driver" ? "Motorista" : item.role === "passenger" ? "Carona" : "Meio proprio",
        route: { meetingId: item.meeting_id, vehicle: item.role === "own_transport" ? "other" : "car" },
        status: item.method === "gps" ? "Confirmado por GPS" : "Em validacao"
      });
    });

    $("#presence-list").innerHTML = rows.map(row => `
      <div class="presence-row">
        <div><strong>${row.name}</strong><span>${row.role}</span></div>
        <div><strong>${meeting(row.route.meetingId)?.name || "Reuniao"}</strong><span>Reuniao</span></div>
        <div><strong>${vehicleLabel(row.route.vehicle)}</strong><span>Meio</span></div>
        <div><span class="status-pill ${row.status.includes("Pendente") ? "pending" : "active"}">${row.status}</span></div>
        <div></div>
      </div>
    `).join("") || `<p class="form-note">Nenhuma presenca para o filtro.</p>`;
  }

  function renderMessages() {
    const sellers = appSellers().filter(item => item.approved);
    $("#message-contacts").innerHTML = sellers.map(item => `
      <button class="contact-row ${item.id === state.selectedMessageSellerId ? "active" : ""}" data-contact="${item.id}">
        <span class="avatar">${initials(item.name)}</span>
        <span><strong>${item.name}</strong><span>${item.status === "online" ? "Online agora" : "Offline"}</span></span>
        <i data-lucide="chevron-right"></i>
      </button>
    `).join("");

    const active = seller(state.selectedMessageSellerId);
    $("#message-title").textContent = active?.name || "Selecione um vendedor";
    const messages = state.data.messages.filter(item => item.sellerId === state.selectedMessageSellerId);
    $("#message-thread").innerHTML = messages.map(item => `
      <div class="message-bubble ${item.from === "manager" ? "me" : ""}">
        ${item.text}
        <small>${item.time}${item.routeOnly ? " - expira ao fim da viagem" : ""}</small>
      </div>
    `).join("") || `<p class="form-note">Sem mensagens nesta conversa.</p>`;
    icon();
  }

  function renderFeedback() {
    const rows = [
      ...state.data.supportTickets.map(item => ({ ...item, kind: "ticket", title: `Chamado: ${item.title}` })),
      ...state.data.feedback.map(item => ({ ...item, kind: "feedback" }))
    ];
    $("#feedback-list").innerHTML = rows.map(item => `
      <article class="feedback-card" id="feedback-${item.id}">
        <h4>${item.title}</h4>
        <span>${seller(item.sellerId)?.name || "Vendedor"} - ${item.createdAt}</span>
        <p class="form-note">${item.text}</p>
        <div class="card-actions">
          ${item.kind === "feedback" ? `<button class="tiny-button danger" data-delete-feedback="${item.id}">Excluir mensagem</button>` : `<span class="status-pill active">${item.status || "open"}</span>`}
        </div>
      </article>
    `).join("") || `<p class="form-note">Nenhum feedback recebido.</p>`;
  }

  function renderMobile() {
    const me = currentSeller();
    $("#mobile-side-name").textContent = me.name;
    $("#mobile-side-cost").textContent = me.costCenter ? `Centro de custo ${me.costCenter}` : "Cadastro pendente";
    $("#mobile-notifications")?.classList.toggle("has-dot", state.data.notifications.some(item => !item.read));
    const today = new Date().toISOString().slice(0, 10);
    const nextMeeting = state.data.meetings
      .filter(item => item.active !== false)
      .filter(item => !item.date || item.date >= today)
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))[0];
    renderMobileHome(nextMeeting);
    initMobileMap();
    if (!state.mobileApproved) {
      $("#approval-waiting").classList.remove("hidden");
    } else {
      $("#approval-waiting").classList.add("hidden");
    }
    showMobilePanel(state.mobilePanel || "home");
    icon();
  }

  function renderMobileHome(nextMeeting) {
    const me = currentSeller();
    const activeTrip = state.mobileTrip.status !== "idle";
    const tripMeeting = meeting(state.mobileTrip.meetingId);
    const unread = state.data.notifications.filter(item => !item.read).length;
    const openTickets = state.data.supportTickets.filter(item => (item.sellerId === me.uid || item.sellerId === me.id) && item.status !== "closed").length;
    const myRoutes = state.data.routes.filter(route => route.driverId === me.uid || route.driverId === me.id);
    const completedRoutes = myRoutes.filter(route => route.status === "completed");
    const monthKey = new Date().toISOString().slice(0, 7);
    const monthRoutes = myRoutes.filter(route => (route.createdAt || "").slice(0, 7) === monthKey);
    const monthCost = monthRoutes.reduce((total, route) => total + routeCost(route, "real"), 0);
    const tripKm = activeTrip ? pathKm(mobileTripPoints()) : 0;
    const approvalCopy = `${greetingByHour()}, ${me.name.split(" ")[0] || "vendedor"}`;
    const meetingDate = nextMeeting?.date ? nextMeeting.date.split("-").reverse().join("/") : "Sem data";
    const meetingTime = nextMeeting?.time || "--:--";
    const home = $("#mobile-home-panel");
    if (!home) return;

    home.innerHTML = `
      <div class="mobile-home-dashboard">
        <header class="home-topbar">
          <button class="home-icon-button" data-open-sidebar aria-label="Abrir menu"><i data-lucide="menu"></i></button>
          <div class="home-title">
            <span>${approvalCopy}</span>
            <h2>Inicio</h2>
          </div>
          <button class="home-icon-button ${unread ? "has-dot" : ""}" data-mobile-panel="notifications" aria-label="Notificacoes"><i data-lucide="bell"></i></button>
        </header>

        <section class="home-hero">
          <div>
            <span>Ola, ${me.name.split(" ")[0] || "vendedor"}</span>
            <h3>${activeTrip ? "Rota em andamento" : "Pronto para sua proxima reuniao"}</h3>
            <p>${activeTrip ? `${tripStatusCopy(state.mobileTrip.status)} para ${tripMeeting?.name || "a reuniao"}.` : nextMeeting ? `${nextMeeting.name} - ${meetingDate} as ${meetingTime}` : "Nenhuma reuniao cadastrada no momento."}</p>
          </div>
          <button class="home-primary-action" data-mobile-panel="meetings"><i data-lucide="${activeTrip ? "navigation" : "calendar-days"}"></i>${activeTrip ? "Continuar" : "Abrir reuniao"}</button>
        </section>

        <section class="home-widget-grid">
          <button class="home-widget" data-mobile-panel="meetings">
            <i data-lucide="map-pin"></i>
            <span>Proxima reuniao</span>
            <strong>${nextMeeting?.name || "Sem cadastro"}</strong>
            <small>${nextMeeting ? `${meetingDate} as ${meetingTime}` : "Aguardando gestor"}</small>
          </button>
          <button class="home-widget" data-mobile-panel="history">
            <i data-lucide="route"></i>
            <span>Historico</span>
            <strong>${completedRoutes.length}</strong>
            <small>trajetos concluidos</small>
          </button>
          <button class="home-widget" data-mobile-panel="notifications">
            <i data-lucide="bell"></i>
            <span>Notificacoes</span>
            <strong>${unread}</strong>
            <small>nao lidas</small>
          </button>
          <button class="home-widget" data-mobile-panel="support">
            <i data-lucide="headphones"></i>
            <span>Suporte</span>
            <strong>${openTickets}</strong>
            <small>chamados abertos</small>
          </button>
        </section>

        <section class="home-section">
          <div class="home-section-head">
            <div>
              <span>Resumo</span>
              <h3>Este mes</h3>
            </div>
            <button class="tiny-button" data-sync-mobile><i data-lucide="refresh-cw"></i> Atualizar</button>
          </div>
          <div class="home-stats-row">
            <div><span>Reembolso</span><strong>${fmtMoney(monthCost)}</strong></div>
            <div><span>Rota ativa</span><strong>${activeTrip ? fmtKm(tripKm) : "0,0 km"}</strong></div>
            <div><span>Caronas</span><strong>${state.mobileTrip.passengers.length}</strong></div>
          </div>
        </section>

        <section class="home-section">
          <div class="home-section-head">
            <div>
              <span>Acoes rapidas</span>
              <h3>Viagem e atendimento</h3>
            </div>
          </div>
          <div class="home-action-grid">
            <button data-start-role="driver"><i data-lucide="car-front"></i><span>Vou dirigir</span></button>
            <button data-start-role="passenger"><i data-lucide="users"></i><span>Quero carona</span></button>
            <button data-mobile-emergency="Emergencia acionada pela home"><i data-lucide="triangle-alert"></i><span>Emergencia</span></button>
            <button data-mobile-panel="feedback"><i data-lucide="message-square-plus"></i><span>Feedback</span></button>
          </div>
        </section>
      </div>
    `;
  }

  function initMobileMap() {
    const points = state.mobileTrip.status === "idle"
      ? []
      : mobileTripPoints();
    drawRouteMap("mobile-map", points, state.mobileTrip.status === "return" ? "#16a06a" : "#0f62fe");
  }

  function mobileTripPoints() {
    const place = meeting(state.mobileTrip.meetingId);
    const driver = currentSeller();
    const start = pointWithFallback(state.mobileTrip.startPoint, driver.home);
    const paxes = state.mobileTrip.passengers.map(id => {
      const item = seller(id);
      const point = pointWithFallback(item?.home, null);
      return item && point ? { kind: "ride", label: item.name.split(" ")[0] || "Carona", ...point } : null;
    }).filter(Boolean).sort((a, b) => distanceMeters(start, a) - distanceMeters(start, b));
    if (!place) return [{ kind: "real-start", label: "Voce", ...start }];
    if (state.mobileTrip.role === "passenger") {
      return [
        { kind: "real-start", label: "Voce", ...start },
        { kind: "meeting", label: place.name, ...place.point }
      ];
    }
    return [
      { kind: "real-start", label: "Voce", ...start },
      ...paxes,
      { kind: "meeting", label: place.name, ...place.point }
    ];
  }

  function showMobilePanel(panel) {
    state.mobilePanel = panel;
    setBottomSheetCollapsed(false);
    const content = $("#mobile-panel-content");
    const screen = $(".mobile-screen");
    const routeMode = panel === "meetings";
    const homeMode = panel === "home";
    screen.classList.toggle("home-mode", homeMode);
    screen.classList.toggle("route-mode", routeMode);
    screen.classList.toggle("page-mode", !homeMode && !routeMode);
    $("#mobile-home-panel").classList.toggle("hidden", panel !== "home");
    content.classList.toggle("hidden", panel === "home");
    $$(".mobile-bottom-nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.mobilePanel === panel));

    const renderers = {
      meetings: mobileMeetingsPanel,
      rides: mobileRidesPanel,
      chat: mobileChatPanel,
      profile: mobileProfilePanel,
      settings: mobileSettingsPanel,
      history: mobileHistoryPanel,
      support: mobileSupportPanel,
      feedback: mobileFeedbackPanel,
      notifications: mobileNotificationsPanel
    };
    content.innerHTML = panel === "home" ? "" : (renderers[panel]?.() || mobileMeetingsPanel());
    saveState();
    icon();
  }

  function mobileMeetingsPanel() {
    const trip = state.mobileTrip;
    if (trip.status !== "idle") return mobileActiveTripPanel();
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>Como voce vai para a reuniao?</h4>
          <p>Motoristas geram rota auditavel. Caronas confirmam embarque, desembarque e presenca. Onibus/outros apenas confirmam presenca no local.</p>
        </div>
        <div class="choice-grid">
          <button class="choice-button" data-start-role="driver"><i data-lucide="car-front"></i><span><strong>Vou dirigir</strong><span>Carro ou moto com reembolso por km.</span></span></button>
          <button class="choice-button" data-start-role="passenger"><i data-lucide="users"></i><span><strong>Quero carona</strong><span>Seu local fica visivel para motoristas aprovados.</span></span></button>
          <button class="choice-button" data-start-role="own"><i data-lucide="bus"></i><span><strong>Outro meio</strong><span>Sem rota paga; presenca somente no local.</span></span></button>
        </div>
      </div>
    `;
  }

  function mobileActiveTripPanel() {
    const trip = state.mobileTrip;
    if (trip.role === "passenger") return mobilePassengerTripPanel();
    const place = meeting(trip.meetingId);
    const km = pathKm(mobileTripPoints());
    const cost = km * (CONFIG.rates[trip.vehicle] || 0);
    const nextStop = trip.passengers.length
      ? seller(trip.passengers[0])?.name || "carona selecionada"
      : place?.name || "reuniao";
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <div class="trip-state">
            <div>
              <strong>${tripStatusCopy(trip.status)}</strong>
              <p>Proxima parada: ${nextStop}</p>
            </div>
            <span class="status-pill active">${vehicleLabel(trip.vehicle)}</span>
          </div>
          <div class="pill-row">
            <span class="mini-pill">${fmtKm(km)}</span>
            <span class="mini-pill">${fmtMoney(cost)}</span>
            <span class="mini-pill">${trip.passengers.length} carona(s)</span>
          </div>
          <details class="trip-action-menu">
            <summary><i data-lucide="ellipsis"></i><span>Acoes da rota</span></summary>
            <div class="mobile-card-actions">
              <button class="tiny-button" data-pickup-next>Embarcar carona</button>
              <button class="tiny-button" data-arrive-meeting>Cheguei na reuniao</button>
              <button class="tiny-button" data-confirm-presence>Confirmar presenca</button>
              <button class="tiny-button" data-dropoff-next>Desembarcar carona</button>
              <button class="tiny-button danger" data-cancel-trip>Cancelar rota</button>
            </div>
          </details>
        </div>
        ${trip.passengers.map(id => {
          const item = seller(id);
          return item ? `<div class="mobile-card"><h4>${item.name}</h4><p>Status: ${passengerStatus(id)}</p><div class="mobile-card-actions"><button class="tiny-button" data-message-passenger="${id}">Mensagem temporaria</button><button class="tiny-button danger" data-remove-passenger="${id}">Remover</button></div></div>` : "";
        }).join("") || `<div class="mobile-card"><h4>Nenhuma carona adicionada</h4><p>Adicione colegas antes de iniciar ou durante a viagem, respeitando a capacidade do veiculo.</p></div>`}
      </div>
    `;
  }

  function mobilePassengerTripPanel() {
    const trip = state.mobileTrip;
    const place = meeting(trip.meetingId);
    const drivers = state.data.routes
      .filter(route => route.meetingId === trip.meetingId && route.status === "active")
      .map(route => ({ route, driver: seller(route.driverId) }))
      .filter(item => item.driver);
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <div class="trip-state">
            <div>
              <strong>${tripStatusCopy(trip.status)}</strong>
              <p>${place?.name || "Reuniao nao selecionada"}</p>
            </div>
            <span class="status-pill pending">Passageiro</span>
          </div>
          <p class="form-note">Seu ponto foi compartilhado para motoristas aprovados desta reuniao. Quando um motorista adicionar voce, a conversa temporaria fica disponivel.</p>
          <details class="trip-action-menu">
            <summary><i data-lucide="ellipsis"></i><span>Acoes</span></summary>
            <div class="mobile-card-actions">
              <button class="tiny-button" data-arrive-meeting>Cheguei na reuniao</button>
              <button class="tiny-button" data-confirm-presence>Confirmar presenca</button>
              <button class="tiny-button danger" data-cancel-trip>Cancelar pedido</button>
            </div>
          </details>
        </div>
        ${drivers.map(({ driver, route }) => `<div class="mobile-card"><h4>${driver.name}</h4><p>${vehicleLabel(route.vehicle)} - ${fmtKm(routeKm(route, "planned"))}</p><div class="mobile-card-actions"><button class="tiny-button" data-quick-chat="Estou aguardando carona para ${place?.name || "a reuniao"}.">Enviar aviso</button></div></div>`).join("") || `<div class="mobile-card"><h4>Nenhum motorista disponivel ainda</h4><p>Voce pode aguardar ou ir por meios proprios pela tela Reuniao.</p></div>`}
      </div>
    `;
  }

  function tripStatusCopy(status) {
    return ({ idle: "Pronto para iniciar", planning: "Planejando", outbound: "Indo para a reuniao", waiting_ride: "Aguardando carona", at_meeting: "Na reuniao", return: "Retornando", completed: "Finalizada" })[status] || status;
  }

  function passengerStatus(id) {
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    const passenger = route?.passengers.find(item => item.sellerId === id);
    return ({
      invited: "convidado",
      onboard: "embarcado",
      dropped: "desembarcado",
      canceled: "cancelado"
    })[passenger?.status] || "aguardando";
  }

  function mobileRidesPanel() {
    return state.mobileTrip.status === "idle" ? `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>Minhas caronas</h4>
          <p>Nenhuma viagem ativa. Ao pegar carona, o chat fica disponivel apenas durante o trajeto.</p>
        </div>
      </div>
    ` : mobileActiveTripPanel();
  }

  function mobileChatPanel() {
    const me = currentSeller();
    const manager = managerProfile();
    const managerId = manager?.uid || manager?.id || state.data.messages.find(item => item.from === "manager")?.sellerId;
    const messages = state.data.messages.filter(item => item.sellerId === managerId);
    const tripMessages = state.mobileTrip.chat || [];
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>Mensagens com o gestor</h4>
          <p>Responda aqui as mensagens enviadas pelo painel. Mensagens de rota continuam marcadas como temporarias.</p>
        </div>
        <div class="mobile-chat-thread">
          ${messages.map(msg => `<div class="message-bubble ${msg.from === "seller" ? "me" : ""}">${msg.text}<small>${msg.time}${msg.routeOnly ? " - temporaria" : ""}</small></div>`).join("") || `<p class="form-note">Nenhuma mensagem do gestor ainda.</p>`}
          ${tripMessages.map(msg => `<div class="message-bubble me">${msg.text}<small>${msg.time} - viagem</small></div>`).join("")}
        </div>
        <div class="message-compose mobile-compose">
          <input id="mobile-message-input" placeholder="Responder ao gestor">
          <button class="icon-button" data-send-mobile-message><i data-lucide="send"></i></button>
        </div>
        <div class="mobile-card-actions">
          <button class="tiny-button" data-quick-chat="Estou chegando em 5 minutos.">Estou chegando</button>
          <button class="tiny-button" data-quick-chat="Pode aguardar no ponto combinado?">Avisar carona</button>
        </div>
      </div>
    `;
  }

  function mobileProfilePanel() {
    const me = currentSeller();
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>${me.name}</h4>
          <p>CPF ${me.cpf || "-"}<br>${me.address || "Endereco nao informado"}<br>Centro de custo ${me.costCenter || "-"}</p>
          <div class="mobile-card-actions"><button class="tiny-button" data-edit-self>Editar perfil</button></div>
        </div>
      </div>
    `;
  }

  function mobileSettingsPanel() {
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>Configuracoes</h4>
          <p>GPS em segundo plano, notificacoes, tema escuro e permissao de localizacao.</p>
          <div class="mobile-card-actions"><button class="tiny-button" id="settings-theme-toggle">Alternar tema</button></div>
        </div>
      </div>
    `;
  }

  function mobileHistoryPanel() {
    const me = currentSeller();
    const rows = state.data.routes.filter(item => item.driverId === me.id || item.driverId === me.uid);
    return `
      <div class="mobile-card-list">
        ${rows.map(route => `<div class="mobile-card"><h4>${meeting(route.meetingId)?.name || "Reuniao"}</h4><p>${fmtKm(routeKm(route, "real"))} - ${fmtMoney(routeCost(route, "real"))} - ${statusLabel(route.status)}</p></div>`).join("") || `<div class="mobile-card"><p>Nenhum trajeto finalizado.</p></div>`}
      </div>
    `;
  }

  function mobileSupportPanel() {
    const me = currentSeller();
    const tickets = state.data.supportTickets.filter(item => item.sellerId === me.uid || item.sellerId === me.id);
    return `
      <div class="mobile-card-list">
        ${tickets.map(item => `<div class="mobile-card"><div class="trip-state"><div><strong>${item.title}</strong><p>${item.text}</p></div><span class="status-pill ${item.status === "urgent" ? "issue" : "pending"}">${item.status}</span></div><small>${item.createdAt ? new Date(item.createdAt).toLocaleString("pt-BR") : ""}</small></div>`).join("") || `<div class="mobile-card"><h4>Nenhum chamado em andamento</h4><p>Quando voce abrir um suporte, ele aparece aqui com o status.</p></div>`}
        <div class="mobile-card">
          <h4>Novo chamado</h4>
          <p>Descreva o problema. O gestor recebe junto com usuario, rota ativa e horario.</p>
          <textarea id="support-message" class="mobile-textarea" rows="4" placeholder="Ex.: pneu furou, estou parado na avenida..."></textarea>
          <div class="mobile-card-actions"><button class="tiny-button" data-send-support>Enviar chamado</button></div>
        </div>
      </div>
    `;
  }

  function mobileFeedbackPanel() {
    return `
      <div class="mobile-card-list">
        <div class="mobile-card">
          <h4>Dar feedback</h4>
          <p>Conte o que melhoraria no app.</p>
          <textarea id="feedback-message" class="mobile-textarea" rows="4" placeholder="Escreva sua sugestao ou problema"></textarea>
          <div class="mobile-card-actions"><button class="tiny-button" data-send-feedback>Enviar feedback</button></div>
        </div>
      </div>
    `;
  }

  function mobileNotificationsPanel() {
    return `
      <div class="mobile-card-list">
        ${state.data.notifications.map(item => `<div class="mobile-card"><h4>${item.type || "Notificacao"}</h4><p>${item.text}</p></div>`).join("") || `<div class="mobile-card"><p>Nenhuma notificacao recebida.</p></div>`}
      </div>
    `;
  }

  function openRegisterModal() {
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Cadastro vendedor</span><h3>Solicitar acesso</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <form id="register-form" class="form-grid">
        <label class="full">Nome completo<input name="name" required></label>
        <label>CPF<input name="cpf" required placeholder="000.000.000-00"></label>
        <label>C. custo<input name="costCenter" required placeholder="0412"></label>
        <label class="full">Endereco<input name="address" required placeholder="Rua, numero, cidade"></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Senha<input name="password" type="password" required minlength="6"></label>
        <button class="primary-action full" type="submit">Enviar para aprovacao</button>
      </form>
    `;
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  function openRecoveryModal() {
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Recuperacao</span><h3>Recuperar senha</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <p class="form-note">Informe o e-mail cadastrado. Quando o Supabase Auth estiver ativo, ele enviara o link de recuperacao.</p>
      <form id="recovery-form" class="form-grid">
        <label class="full">E-mail<input name="email" type="email" required placeholder="vendedor@empresa.com.br"></label>
        <button class="primary-action full" type="submit">Enviar link</button>
      </form>
    `;
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  function openSellerModal(id = null) {
    const item = id ? seller(id) : { id: "", name: "", cpf: "", email: "", address: "", costCenter: "", transport: "car" };
    if (!item) {
      showToast("Vendedor nao encontrado.", "warning");
      return;
    }
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Vendedor</span><h3>${id ? "Editar" : "Cadastrar"} vendedor</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <form id="seller-form" class="form-grid" data-id="${id || ""}">
        <label class="full">Nome<input name="name" required value="${escapeHtml(item.name)}"></label>
        <label>CPF<input name="cpf" required value="${escapeHtml(item.cpf)}"></label>
        <label>C. custo<input name="costCenter" required value="${escapeHtml(item.costCenter)}"></label>
        <label class="full">Endereco<input name="address" required value="${escapeHtml(item.address)}"></label>
        <label>Email<input name="email" type="email" required value="${escapeHtml(item.email)}"></label>
        <label>Locomocao<select name="transport"><option value="car">Carro</option><option value="moto">Moto</option><option value="bus">Onibus</option><option value="other">Outro</option></select></label>
        <button class="primary-action full" type="submit">Salvar vendedor</button>
      </form>
    `;
    $("#seller-form [name='transport']").value = item.transport || "car";
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  function openMeetingModal(id = null) {
    const item = id ? meeting(id) : { name: "", address: "", date: new Date().toISOString().slice(0, 10), time: "08:00", radius: 300, point: { lat: "", lng: "" } };
    if (!item) {
      showToast("Reuniao nao encontrada.", "warning");
      return;
    }
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Local de reuniao</span><h3>${id ? "Editar" : "Cadastrar"} local</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <form id="meeting-form" class="form-grid" data-id="${id || ""}">
        <label class="full">Nome<input name="name" required value="${escapeHtml(item.name)}"></label>
        <label class="full">Endereco<input name="address" required value="${escapeHtml(item.address)}"></label>
        <label>Data<input name="date" type="date" required value="${item.date}"></label>
        <label>Hora<input name="time" type="time" required value="${item.time}"></label>
        <label>Latitude<input name="lat" type="number" step="0.00001" required value="${item.point.lat}"></label>
        <label>Longitude<input name="lng" type="number" step="0.00001" required value="${item.point.lng}"></label>
        <label class="full">Raio de presenca (metros)<input name="radius" type="number" required value="${item.radius}"></label>
        <button class="primary-action full" type="submit">Salvar local</button>
      </form>
    `;
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  function openTripPlanner(role = "driver") {
    if (!state.data.meetings.length) {
      showToast("Nenhuma reuniao cadastrada pelo gestor.", "warning");
      return;
    }
    const isDriver = role === "driver";
    const isPassenger = role === "passenger";
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Reuniao</span><h3>${isDriver ? "Iniciar como motorista" : isPassenger ? "Pedir carona" : "Confirmar meio proprio"}</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <form id="trip-form" class="form-grid" data-role="${role}">
        <label class="full">Local da reuniao
          <select name="meetingId">${state.data.meetings.map(item => `<option value="${item.id}">${item.name}</option>`).join("")}</select>
        </label>
        ${isDriver ? `
          <label class="full">Veiculo
            <select name="vehicle"><option value="car">Carro - R$ 0,90/km</option><option value="moto">Moto - R$ 0,40/km</option></select>
          </label>
        ` : ""}
        ${isPassenger ? `<p class="form-note full">Seu ponto de encontro sera compartilhado com motoristas aprovados para a mesma reuniao.</p>` : ""}
        <button class="primary-action full" type="submit">${isDriver ? "Comecar trajeto" : isPassenger ? "Ficar disponivel para carona" : "Ir por meios proprios"}</button>
      </form>
    `;
    $("#trip-form [name='meetingId']").value = state.mobileTrip.meetingId || state.data.meetings[0]?.id;
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  async function beginTrip(role, meetingId, vehicle = "other") {
    const me = currentSeller();
    const place = meeting(meetingId);
    if (!state.currentProfile?.uid || !me.approved) {
      showToast("Seu cadastro precisa estar aprovado para iniciar uma viagem.", "warning");
      return;
    }
    if (!place) {
      showToast("Cadastre uma reuniao no painel antes de iniciar.", "warning");
      return;
    }
    const trip = state.mobileTrip;
    trip.role = role;
    trip.meetingId = meetingId;
    trip.vehicle = role === "driver" ? vehicle : role === "own" ? "bus" : "ride";
    trip.status = role === "driver" ? "outbound" : role === "own" ? "outbound" : "waiting_ride";
    trip.atMeeting = false;
    trip.startPoint = await getCurrentPositionPoint(me.home);
    trip.passengers = role === "driver" ? [...trip.passengers] : [];
    trip.chat = [];

    if (role === "driver") {
      const route = buildRouteFromMobileTrip(trip.startPoint);
      await createRemoteRoute(route);
      state.data.routes.unshift(route);
      trip.routeId = route.id;
    } else if (role === "own") {
      await upsertRow("attendance_records", {
        meeting_id: place.id,
        user_uid: me.uid,
        route_id: null,
        role: "own_transport",
        method: "gps_pending",
        lat: trip.startPoint.lat,
        lng: trip.startPoint.lng
      }, "meeting_id,user_uid");
    }

    closeModal();
    saveState();
    showMobilePanel("meetings");
    initMobileMap();
    showToast(role === "driver" ? "Rota iniciada e visivel no painel gestor." : "Status atualizado para a reuniao.", "success");
  }

  function buildRouteFromMobileTrip(startPoint = null) {
    const id = cryptoId("r");
    const driver = currentSeller();
    const place = meeting(state.mobileTrip.meetingId);
    const start = pointWithFallback(startPoint, driver.home);
    const passengerPoints = state.mobileTrip.passengers
      .map(sellerId => {
        const item = seller(sellerId);
        const point = pointWithFallback(item?.home, null);
        return item && point ? { sellerId, name: item.name, ...point } : null;
      })
      .filter(Boolean)
      .sort((a, b) => distanceMeters(start, a) - distanceMeters(start, b));
    const plannedOutbound = [
      { kind: "home", label: "Inicio", ...start },
      ...passengerPoints.map(item => ({ kind: "ride", label: `Carona ${item.name}`, lat: item.lat, lng: item.lng })),
      { kind: "meeting", label: place.name, ...place.point }
    ];
    const plannedReturn = [...plannedOutbound].reverse().map((point, index) => ({
      ...point,
      kind: index === 0 ? "meeting-end" : point.kind === "ride" ? "ride-drop" : point.kind
    }));

    return {
      id,
      driverId: driver.uid,
      meetingId: place.id,
      vehicle: state.mobileTrip.vehicle,
      status: "active",
      createdAt: nowIso(),
      passengers: state.mobileTrip.passengers.map(sellerId => ({ sellerId, status: "invited", confirmedPresence: false })),
      planned: [
        { leg: "outbound", points: plannedOutbound },
        { leg: "return", points: plannedReturn }
      ],
      real: [
        {
          leg: "outbound",
          points: [
            { kind: "real-start", label: "Inicio real", ...start },
            ...passengerPoints.map(item => ({ kind: "ride", label: `Embarque ${item.name}`, lat: item.lat, lng: item.lng })),
            { kind: "meeting", label: place.name, ...place.point }
          ]
        }
      ],
      events: [{ leg: "outbound", time: currentClock(), type: "start", text: "Motorista iniciou a rota pelo app mobile" }]
    };
  }

  function currentClock() {
    return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function cryptoId(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    return `${prefix}-${Date.now().toString(36)}`;
  }

  function closeModal() {
    $("#modal-root").classList.add("hidden");
    $("#modal-card").innerHTML = "";
  }

  function confirmAction(title, text, onConfirm) {
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Confirmacao</span><h3>${title}</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <p class="form-note">${text}</p>
      <div class="filter-row">
        <button class="soft-button" data-close-modal>Cancelar</button>
        <button class="primary-small" id="confirm-action">Confirmar</button>
      </div>
    `;
    $("#modal-root").classList.remove("hidden");
    $("#confirm-action").onclick = async () => {
      try {
        await onConfirm();
        closeModal();
      } catch (error) {
        showToast(error.message || "Nao foi possivel concluir a acao.", "warning");
        console.error(error);
      }
    };
    icon();
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  }

  function addMobilePassenger() {
    if (state.mobileTrip.status !== "idle" && state.mobileTrip.role !== "driver") {
      showToast("Apenas o motorista pode adicionar caronas nesta viagem.", "warning");
      return;
    }
    const capacity = state.mobileTrip.vehicle === "moto" ? 1 : 4;
    const me = currentSeller();
    const available = appSellers().filter(item =>
      item.approved &&
      item.id !== me.id &&
      !state.mobileTrip.passengers.includes(item.id) &&
      item.transport !== "bus"
    );
    $("#modal-card").className = "modal-card small";
    $("#modal-card").innerHTML = `
      <div class="modal-head">
        <div><span class="eyebrow">Caronas</span><h3>Adicionar passageiro</h3></div>
        <button class="icon-button" data-close-modal><i data-lucide="x"></i></button>
      </div>
      <p class="form-note">Capacidade atual: ${state.mobileTrip.passengers.length}/${capacity}. Moto aceita apenas 1 carona.</p>
      <div class="choice-grid">
        ${available.map(item => `<button class="choice-button" data-add-passenger="${item.id}"><i data-lucide="user-plus"></i><span><strong>${item.name}</strong><span>${item.address}</span></span></button>`).join("") || `<p class="form-note">Nenhum vendedor disponivel.</p>`}
      </div>
    `;
    $("#modal-root").classList.remove("hidden");
    icon();
  }

  function pushRouteEvent(type, text, leg = state.mobileTrip.status === "return" ? "return" : "outbound") {
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    if (!route) return null;
    const event = { leg, time: currentClock(), type, text };
    route.events.push(event);
    if (type === "issue") route.status = "issue";
    saveState();
    return event;
  }

  async function persistRouteEvent(type, text, leg, pointValue = null) {
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    const event = pushRouteEvent(type, text, leg);
    if (!route || !event) return;
    await insertRouteEvent(route, event, pointValue);
    await updateRemoteRoute(route);
  }

  async function handleEmergency(reason = "Emergencia acionada") {
    const me = currentSeller();
    const current = await getCurrentPositionPoint(me.home);
    if (state.mobileTrip.routeId) {
      const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
      route.real[0].points.splice(-1, 0, { kind: "issue", label: reason, ...current });
      await persistRouteEvent("issue", reason, "outbound", current);
    } else if (state.currentProfile?.uid) {
      await insertRow("support_tickets", {
        user_uid: me.uid,
        route_id: null,
        subject: "Emergencia sem rota ativa",
        message: reason,
        status: "urgent"
      });
    }
    saveState();
    showToast("Emergencia registrada no painel do gestor.", "warning");
    renderMobile();
  }

  async function arriveMeeting() {
    const place = meeting(state.mobileTrip.meetingId);
    const me = currentSeller();
    const current = await getCurrentPositionPoint(me.home);
    const maxDistance = place?.radius || CONFIG.presenceRadiusMeters;
    if (!place || distanceMeters(current, place.point) > maxDistance) {
      showToast(`Chegada bloqueada. Voce precisa estar dentro de ${maxDistance}m da reuniao.`, "warning");
      return;
    }
    state.mobileTrip.status = "at_meeting";
    state.mobileTrip.atMeeting = true;
    await persistRouteEvent("arrive", "Chegada na reuniao validada por GPS", "outbound", current);
    showToast("Chegada registrada. Presenca liberada.", "success");
    saveState();
    renderMobile();
  }

  async function confirmPresence() {
    if (!state.mobileTrip.atMeeting) {
      showToast(`Presenca bloqueada. Primeiro valide chegada dentro do raio da reuniao.`, "warning");
      return;
    }
    const me = currentSeller();
    const place = meeting(state.mobileTrip.meetingId);
    if (!place) {
      showToast("Selecione uma reuniao antes de confirmar presenca.", "warning");
      return;
    }
    const current = await getCurrentPositionPoint(me.home);
    await upsertRow("attendance_records", {
      meeting_id: place.id,
      user_uid: me.uid,
      route_id: state.mobileTrip.routeId || null,
      role: state.mobileTrip.role === "driver" ? "driver" : state.mobileTrip.role === "passenger" ? "passenger" : "own_transport",
      method: "gps",
      lat: current.lat,
      lng: current.lng
    }, "meeting_id,user_uid");
    await persistRouteEvent("arrive", "Presenca confirmada no local da reuniao", "outbound", current);
    saveState();
    showToast("Presenca confirmada e sincronizada com o gestor.", "success");
  }

  async function startReturn() {
    if (!state.mobileTrip.routeId) {
      showToast("Inicie uma viagem como motorista antes do retorno.", "warning");
      return;
    }
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    if (!route) {
      showToast("Rota incompleta. Sincronize antes de iniciar retorno.", "warning");
      return;
    }
    const place = meeting(route.meetingId);
    const driver = seller(route.driverId);
    if (!place || !driver) {
      showToast("Rota incompleta. Sincronize antes de iniciar retorno.", "warning");
      return;
    }
    route.real.push({
      leg: "return",
      points: [
        { kind: "meeting-end", label: "Inicio retorno", ...place.point },
        ...state.mobileTrip.passengers.map(id => {
          const item = seller(id);
          return item ? { kind: "ride-drop", label: `Desembarque ${item.name}`, ...item.home } : null;
        }).filter(Boolean),
        { kind: "home", label: "Fim retorno", ...driver.home }
      ]
    });
    state.mobileTrip.status = "return";
    await persistRouteEvent("return", "Motorista iniciou retorno", "return", place.point);
    saveState();
    showToast("Retorno iniciado. Caronas foram notificadas.", "success");
    renderMobile();
  }

  async function pickupNext() {
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    const next = route?.passengers.find(item => item.status === "invited");
    if (!next) {
      showToast("Nao ha caronas aguardando embarque.", "info");
      return;
    }
    next.status = "onboard";
    next.pickedAt = currentClock();
    const item = seller(next.sellerId);
    await persistRouteEvent("pickup", `${item?.name || "Carona"} embarcou`, "outbound", item?.home);
    showToast(`${item?.name || "Carona"} embarcou.`, "success");
    renderMobile();
  }

  async function dropoffNext() {
    const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
    const next = route?.passengers.find(item => item.status === "onboard");
    if (!next) {
      showToast("Nenhum carona embarcado para desembarcar.", "info");
      return;
    }
    next.status = "dropped";
    next.droppedAt = currentClock();
    next.confirmedPresence = true;
    const item = seller(next.sellerId);
    await persistRouteEvent("dropoff", `${item?.name || "Carona"} desembarcou`, "return", item?.home);
    showToast(`${item?.name || "Carona"} desembarcou.`, "success");
    renderMobile();
  }

  function cancelTrip() {
    confirmAction("Cancelar rota", "O cancelamento sera registrado no painel e as caronas serao avisadas.", async () => {
      const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
      if (route) {
        route.status = "cancelled";
        const event = { leg: "outbound", time: currentClock(), type: "issue", text: "Motorista cancelou a rota" };
        route.events.push(event);
        await insertRouteEvent(route, event);
        await updateRemoteRoute(route);
      }
      state.mobileTrip.status = "idle";
      state.mobileTrip.routeId = null;
      state.mobileTrip.passengers = [];
      saveState();
      renderMobile();
      showToast("Rota cancelada e registrada.", "warning");
    });
  }

  function exportRoutes(routeId = null) {
    const rows = [
      ["rota", "motorista", "reuniao", "veiculo", "km_previsto", "custo_previsto", "km_real", "custo_real", "status"]
    ];
    state.data.routes
      .filter(route => !routeId || route.id === routeId)
      .forEach(route => rows.push([
        route.id,
        seller(route.driverId)?.name || "Motorista",
        meeting(route.meetingId)?.name || "Reuniao",
        vehicleLabel(route.vehicle),
        routeKm(route, "planned").toFixed(2),
        routeCost(route, "planned").toFixed(2),
        routeKm(route, "real").toFixed(2),
        routeCost(route, "real").toFixed(2),
        statusLabel(route.status)
      ]));
    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = routeId ? `${routeId}-rota-completa.csv` : "unilider-rotas.csv";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Arquivo CSV gerado.", "success");
  }

  async function syncSupabase() {
    try {
      await refreshRemoteData();
      renderManager();
      showToast("Dados sincronizados com o Supabase.", "success");
    } catch (error) {
      showToast("Nao foi possivel ler o Supabase. Verifique RLS/tabelas.", "warning");
      console.warn(error);
    }
  }

  function bindGlobalEvents() {
    document.addEventListener("click", async event => {
      const target = event.target.closest("button, [data-panel-jump], [data-route-detail], [data-delete-route], [data-edit-seller], [data-delete-seller], [data-approve], [data-refuse], [data-edit-meeting], [data-delete-meeting], [data-contact], [data-message-seller], [data-route-leg], [data-export-one], [data-sync-route], [data-sync-mobile], [data-send-mobile-message], [data-open-sidebar], [data-add-passenger], [data-start-role], [data-mobile-panel], [data-quick-chat], [data-mobile-emergency]");
      if (!target) return;

      if (target.matches("[data-close-modal]")) closeModal();
      if (target.dataset.openSidebar !== undefined) {
        $("#mobile-sidebar").classList.add("open");
        $("#mobile-scrim").classList.add("show");
      }
      if (target.dataset.panel) switchPanel(target.dataset.panel);
      if (target.dataset.panelJump) switchPanel(target.dataset.panelJump);
      if (target.dataset.routeDetail) openRouteDetail(target.dataset.routeDetail, "all");
      if (target.dataset.routeLeg) openRouteDetail(target.dataset.routeId, target.dataset.routeLeg);
      if (target.dataset.deleteRoute) confirmAction("Excluir rota", "Esta rota sera removida da auditoria.", async () => {
        await deleteRow("route_sessions", "id", target.dataset.deleteRoute);
        await refreshRemoteData();
        renderManager();
        showToast("Rota excluida.", "success");
      });
      if (target.dataset.editSeller) openSellerModal(target.dataset.editSeller);
      if (target.dataset.deleteSeller) confirmAction("Excluir vendedor", "O vendedor sera removido da lista e nao aparecera para caronas.", async () => {
        const item = seller(target.dataset.deleteSeller);
        const [column, value] = sellerUpdateTarget(item);
        await deleteRow("usuarios", column, value);
        await refreshRemoteData();
        renderManager();
      });
      if (target.dataset.approve) {
        const item = seller(target.dataset.approve);
        if (!item) return;
        const [column, value] = sellerUpdateTarget(item);
        await updateRow("usuarios", { approved: true, status: "offline", updated_at: nowIso() }, column, value);
        await refreshRemoteData();
        renderManager();
        showToast(`${item.name} aprovado.`, "success");
      }
      if (target.dataset.refuse) confirmAction("Recusar cadastro", "O cadastro sera removido da fila de aprovacao.", async () => {
        const item = seller(target.dataset.refuse);
        const [column, value] = sellerUpdateTarget(item);
        await deleteRow("usuarios", column, value);
        await refreshRemoteData();
        renderManager();
      });
      if (target.dataset.editMeeting) openMeetingModal(target.dataset.editMeeting);
      if (target.dataset.deleteMeeting) confirmAction("Excluir local", "O local deixara de aparecer para vendedores no app.", async () => {
        await updateRow("meeting_locations", { active: false }, "id", target.dataset.deleteMeeting);
        await refreshRemoteData();
        renderManager();
      });
      if (target.dataset.contact) {
        state.selectedMessageSellerId = target.dataset.contact;
        saveState();
        renderMessages();
      }
      if (target.dataset.messageSeller) {
        state.selectedMessageSellerId = target.dataset.messageSeller;
        switchPanel("messages");
        renderMessages();
      }
      if (target.dataset.exportOne) exportRoutes(target.dataset.exportOne);
      if (target.dataset.syncRoute) {
        const route = state.data.routes.find(item => item.id === target.dataset.syncRoute);
        if (route) await updateRemoteRoute(route);
        showToast("Rota sincronizada com o Supabase.", "success");
      }
      if (target.dataset.syncMobile !== undefined) {
        await refreshRemoteData();
        renderMobile();
        showToast("Inicio atualizado.", "success");
      }
      if (target.dataset.sendMobileMessage !== undefined) {
        const input = $("#mobile-message-input");
        const text = input?.value.trim();
        const manager = managerProfile();
        const managerId = manager?.uid || manager?.id || state.data.messages.find(item => item.from === "manager")?.sellerId;
        if (!text) return;
        if (!managerId) {
          showToast("Gestor nao encontrado para responder.", "warning");
          return;
        }
        await insertRow("ride_messages", {
          sender_uid: currentSeller().uid,
          receiver_uid: managerId,
          body: text,
          expires_at: null
        });
        input.value = "";
        await refreshRemoteData();
        showMobilePanel("chat");
        showToast("Mensagem enviada ao gestor.", "success");
      }
      if (target.dataset.mobilePanel) {
        closeMobileSidebar();
        showMobilePanel(target.dataset.mobilePanel);
      }
      if (target.dataset.startRole) openTripPlanner(target.dataset.startRole);
      if (target.dataset.addPassenger) {
        const capacity = state.mobileTrip.vehicle === "moto" ? 1 : 4;
        if (state.mobileTrip.passengers.length >= capacity) {
          showToast("Capacidade do veiculo atingida.", "warning");
          return;
        }
        state.mobileTrip.passengers.push(target.dataset.addPassenger);
        const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
        if (route) route.passengers.push({ sellerId: target.dataset.addPassenger, status: "invited", confirmedPresence: false });
        closeModal();
        if (route) await updateRemoteRoute(route);
        saveState();
        renderMobile();
        showToast("Carona adicionada.", "success");
      }
      if (target.dataset.quickChat) {
        state.mobileTrip.chat.push({ from: currentSeller().name, text: target.dataset.quickChat, time: currentClock() });
        saveState();
        showMobilePanel("chat");
      }
      if (target.dataset.mobileEmergency) await handleEmergency(target.dataset.mobileEmergency);
      if (target.dataset.deleteFeedback) confirmAction("Excluir feedback", "A mensagem sera ocultada do painel.", async () => {
        await updateRow("app_feedback", { hidden: true }, "id", target.dataset.deleteFeedback);
        await refreshRemoteData();
        renderFeedback();
      });
    });

    document.addEventListener("submit", async event => {
      if (event.target.id === "register-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        try {
          const email = String(form.get("email")).trim().toLowerCase();
          const { data, error } = await supabaseClient().auth.signUp({ email, password: form.get("password") });
          if (error) throw error;
          const uid = data.user?.id;
          if (!uid) throw new Error("Supabase nao retornou o UID do usuario.");
          await insertRow("usuarios", {
            uid,
            name: form.get("name"),
            cpf: form.get("cpf"),
            email,
            address: form.get("address"),
            cost_center: form.get("costCenter"),
            approved: false,
            role: "seller",
            status: "pending",
            transport: "other"
          });
          state.sessionUser = data.user || null;
          state.currentProfile = await getProfile(uid);
          state.mobileApproved = false;
          closeModal();
          saveState();
          showScreen("mobile");
          showToast("Cadastro enviado para aprovacao.", "success");
        } catch (error) {
          showToast(error.message || "Nao foi possivel enviar cadastro.", "warning");
          console.error(error);
        }
      }

      if (event.target.id === "recovery-form") {
        event.preventDefault();
        const email = new FormData(event.target).get("email");
        try {
          await remoteAttempt(supabaseClient()?.auth.resetPasswordForEmail(email));
        } catch (error) {
          console.info("Recuperacao remota nao confirmada.", error.message);
        }
        closeModal();
        showToast("Se o e-mail existir, o link de recuperacao sera enviado.", "success");
      }

      if (event.target.id === "seller-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        const id = event.target.dataset.id;
        const current = id ? seller(id) : null;
        const isManager = state.currentProfile?.role === "manager";
        const payload = {
          name: form.get("name"),
          cpf: form.get("cpf"),
          email: form.get("email"),
          address: form.get("address"),
          cost_center: form.get("costCenter"),
          transport: form.get("transport"),
          approved: isManager ? true : current?.approved === true,
          status: current?.status || "offline",
          role: current?.role || "seller",
          home_lat: current?.home?.lat || null,
          home_lng: current?.home?.lng || null
        };
        if (id) {
          const [column, value] = sellerUpdateTarget(current);
          await updateRow("usuarios", { ...payload, updated_at: nowIso() }, column, value);
        } else await insertRow("usuarios", payload);
        await refreshRemoteData();
        closeModal();
        saveState();
        renderManager();
        showToast("Vendedor salvo.", "success");
      }

      if (event.target.id === "meeting-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        const id = event.target.dataset.id;
        const payload = {
          name: form.get("name"),
          address: form.get("address"),
          meeting_date: form.get("date"),
          meeting_time: form.get("time"),
          radius_m: Number(form.get("radius")),
          lat: Number(form.get("lat")),
          lng: Number(form.get("lng")),
          active: true
        };
        if (id) await updateRow("meeting_locations", payload, "id", id);
        else await insertRow("meeting_locations", payload);
        await refreshRemoteData();
        closeModal();
        saveState();
        renderManager();
        showToast("Local de reuniao salvo.", "success");
      }

      if (event.target.id === "trip-form") {
        event.preventDefault();
        const form = new FormData(event.target);
        try {
          await beginTrip(event.target.dataset.role, form.get("meetingId"), form.get("vehicle") || "other");
        } catch (error) {
          showToast(error.message || "Nao foi possivel iniciar a viagem.", "warning");
          console.error(error);
        }
      }
    });

    $("#route-location-filter").addEventListener("change", renderRoutes);
    $("#route-status-filter").addEventListener("change", renderRoutes);
    $("#presence-filter").addEventListener("change", renderPresence);
    $("#export-routes").addEventListener("click", () => exportRoutes());
    $("#sync-supabase").addEventListener("click", syncSupabase);
    $("#manager-logout").addEventListener("click", async () => {
      await supabaseClient()?.auth.signOut();
      state.sessionUser = null;
      state.currentProfile = null;
      showScreen("login");
    });
    $("#open-mobile-from-manager").addEventListener("click", () => {
      state.wasManager = true;
      showScreen("mobile");
    });
    $("#back-to-manager").addEventListener("click", () => showScreen("manager"));
    $("#create-seller").addEventListener("click", () => openSellerModal());
    $("#create-meeting").addEventListener("click", () => openMeetingModal());
    $("#send-message").addEventListener("click", async () => {
      const input = $("#message-input");
      const text = input.value.trim();
      if (!text || !state.selectedMessageSellerId) return;
      const receiver = seller(state.selectedMessageSellerId);
      if (!receiver?.uid) {
        showToast("Este vendedor ainda nao tem login Auth vinculado.", "warning");
        return;
      }
      try {
        await insertRow("ride_messages", {
          sender_uid: state.currentProfile?.uid,
          receiver_uid: receiver.uid,
          body: text,
          expires_at: null
        });
        await insertRow("app_notifications", {
          recipient_uid: receiver.uid,
          title: "Mensagem do gestor",
          body: text,
          type: "message"
        });
        input.value = "";
        await refreshRemoteData();
        renderMessages();
        showToast("Mensagem enviada ao vendedor.", "success");
      } catch (error) {
        showToast(error.message || "Nao foi possivel enviar mensagem.", "warning");
        console.error(error);
      }
    });

    $("#open-sidebar").addEventListener("click", () => {
      $("#mobile-sidebar").classList.add("open");
      $("#mobile-scrim").classList.add("show");
    });
    $("#mobile-scrim").addEventListener("click", closeMobileSidebar);
    $("#sheet-handle").addEventListener("click", toggleBottomSheet);
    $("#mobile-logout").addEventListener("click", async () => {
      await supabaseClient()?.auth.signOut();
      state.sessionUser = null;
      state.currentProfile = null;
      showScreen("login");
    });
    $("#toggle-theme").addEventListener("click", toggleMobileTheme);
    $("#start-trip")?.addEventListener("click", () => showMobilePanel("meetings"));
    $("#mobile-add-passenger").addEventListener("click", addMobilePassenger);
    $("#mobile-emergency").addEventListener("click", () => handleEmergency("Emergencia acionada pelo motorista"));
    $("#mobile-select-meeting").addEventListener("click", () => openTripPlanner("driver"));
    $("#mobile-return").addEventListener("click", () => startReturn().catch(error => showToast(error.message, "warning")));
    $("#mobile-locate").addEventListener("click", async () => {
      state.mobileTrip.startPoint = await getCurrentPositionPoint(currentSeller().home);
      initMobileMap();
      saveState();
      showToast("GPS atualizado. Sua rota usa esse ponto de partida.", "success");
    });
    $("#mobile-layers").addEventListener("click", () => showToast("Camada de transito/rotas alternada.", "info"));
    $("#simulate-approval").addEventListener("click", async () => {
      await refreshRemoteData();
      renderMobile();
      showToast(state.mobileApproved ? "Cadastro aprovado." : "Cadastro ainda aguarda aprovacao.", state.mobileApproved ? "success" : "info");
    });
    $("#mobile-search").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      const term = event.target.value.trim().toLowerCase();
      if (!term) {
        openTripPlanner("driver");
        return;
      }
      const found = state.data.meetings.find(item =>
        item.name.toLowerCase().includes(term) ||
        item.address.toLowerCase().includes(term)
      );
      if (!found) {
        showToast("Nenhuma reuniao encontrada com esse texto.", "warning");
        return;
      }
      state.mobileTrip.meetingId = found.id;
      showMobilePanel("meetings");
      showToast(`${found.name} selecionada.`, "success");
    });
  }

  function bindLateMobileEvents() {
    document.addEventListener("click", async event => {
      const target = event.target.closest("[data-pickup-next], [data-arrive-meeting], [data-confirm-presence], [data-dropoff-next], [data-cancel-trip], [data-remove-passenger], [data-message-passenger], [data-edit-self], [data-send-support], [data-send-feedback], #settings-theme-toggle");
      if (!target) return;

      if (target.dataset.pickupNext !== undefined) await pickupNext();
      if (target.dataset.arriveMeeting !== undefined) await arriveMeeting();
      if (target.dataset.confirmPresence !== undefined) await confirmPresence();
      if (target.dataset.dropoffNext !== undefined) await dropoffNext();
      if (target.dataset.cancelTrip !== undefined) cancelTrip();
      if (target.dataset.removePassenger) {
        const id = target.dataset.removePassenger;
        confirmAction("Remover carona", "O passageiro sera avisado e o evento ficara registrado.", async () => {
          state.mobileTrip.passengers = state.mobileTrip.passengers.filter(item => item !== id);
          const route = state.data.routes.find(item => item.id === state.mobileTrip.routeId);
          if (route) {
            const passenger = route.passengers.find(item => item.sellerId === id);
            if (passenger) passenger.status = "canceled";
            const item = seller(id);
            route.events.push({ leg: "outbound", time: currentClock(), type: "issue", text: `${item?.name || "Carona"} removido da carona` });
            await updateRemoteRoute(route);
          }
          saveState();
          renderMobile();
        });
      }
      if (target.dataset.messagePassenger) {
        const receiver = seller(target.dataset.messagePassenger);
        state.mobileTrip.chat.push({ from: currentSeller().name, text: `Mensagem enviada para ${receiver?.name || "carona"}.`, time: currentClock() });
        if (receiver?.uid) {
          await insertRow("ride_messages", {
            route_id: state.mobileTrip.routeId || null,
            sender_uid: currentSeller().uid,
            receiver_uid: receiver.uid,
            body: `Mensagem temporaria enviada durante a viagem.`,
            expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
          });
        }
        saveState();
        showMobilePanel("chat");
      }
      if (target.dataset.editSelf !== undefined) openSellerModal(currentSeller().id);
      if (target.dataset.sendSupport !== undefined) {
        const message = $("#support-message")?.value.trim();
        if (!message) {
          showToast("Descreva o problema antes de enviar.", "warning");
          return;
        }
        await insertRow("support_tickets", {
          user_uid: currentSeller().uid,
          route_id: state.mobileTrip.routeId || null,
          subject: "Chamado do app mobile",
          message,
          status: "open"
        });
        await insertRow("app_feedback", {
          user_uid: currentSeller().uid,
          title: "Chamado de suporte",
          message
        });
        $("#support-message").value = "";
        await refreshRemoteData();
        showMobilePanel("support");
        showToast("Chamado enviado ao suporte.", "success");
      }
      if (target.dataset.sendFeedback !== undefined) {
        const message = $("#feedback-message")?.value.trim();
        if (!message) {
          showToast("Escreva o feedback antes de enviar.", "warning");
          return;
        }
        await insertRow("app_feedback", {
          user_uid: currentSeller().uid,
          title: "Feedback mobile",
          message
        });
        $("#feedback-message").value = "";
        showToast("Feedback enviado ao gestor.", "success");
      }
      if (target.id === "settings-theme-toggle") toggleMobileTheme();
    });
  }

  function closeMobileSidebar() {
    $("#mobile-sidebar").classList.remove("open");
    $("#mobile-scrim").classList.remove("show");
  }

  function setBottomSheetCollapsed(collapsed) {
    state.mobileSheetCollapsed = collapsed;
    const sheet = $("#mobile-bottom-sheet");
    const handle = $("#sheet-handle");
    const screen = $(".mobile-screen");
    if (sheet) sheet.classList.toggle("collapsed", collapsed);
    if (screen) screen.classList.toggle("sheet-collapsed", collapsed);
    if (handle) {
      handle.setAttribute("aria-expanded", String(!collapsed));
      handle.setAttribute("aria-label", collapsed ? "Abrir painel inferior" : "Recolher painel inferior");
    }
    saveState();
  }

  function toggleBottomSheet() {
    setBottomSheetCollapsed(!state.mobileSheetCollapsed);
  }

  function toggleMobileTheme() {
    $("#mobile-app").classList.toggle("dark-mobile");
    showToast("Tema alternado.", "success");
  }

  function boot() {
    bindLogin();
    bindGlobalEvents();
    bindLateMobileEvents();
    setLoginTab(DEFAULT_LOGIN_TAB);
    showScreen("login");
    icon();
  }

  window.addEventListener("load", boot);
})();

