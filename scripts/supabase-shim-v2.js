/* UniRotas – Supabase Data & Auth Driver V2 (Cache Buster) */
console.log("UniRotas Shim V2: Initializing...");
const _SUPA_URL = 'https://ajconwarkeunpixqngnq.supabase.co';
const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';

// Inicializa o cliente original do Supabase (está vindo do script do navegador)
const _realSB = window.supabase && window.supabase.createClient ? window.supabase.createClient(_SUPA_URL, _SUPA_KEY) : null;

function _toMap(arr, key, fn) {
    if (!arr || !arr.length) return {};
    const r = {};
    arr.forEach(row => { r[row[key]] = fn ? fn(row) : row; });
    return r;
}

function _normPart(row) {
    if (!row) return null;
    return { uid: row.vendor_uid, name: row.name, role: row.role, embarkStatus: row.embark_status,
        joinedAt: row.joined_at ? new Date(row.joined_at).getTime() : null, locationId: row.location_id,
        locationName: row.location_name, locationAddress: row.location_address, region: row.region,
        lat: row.lat, lng: row.lng, phase: row.phase, presenceConfirmed: row.presence_confirmed,
        driverUid: row.driver_uid, driverName: row.driver_name, status: row.status, passengers: row.passengers };
}

async function _readPath(path) {
    if (!_realSB) return null;
    const p = path.split('/').filter(Boolean);
    const q = (t) => _realSB.from(t);

    try {
        if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) {
            const {data} = await q('meeting_participants').select('*').eq('vendor_uid',p[2]).limit(1);
            return data && data.length ? _normPart(data[0]) : null;
        }
        if (path==='meeting/participants') {
            const {data} = await q('meeting_participants').select('*');
            return _toMap(data,'vendor_uid',_normPart);
        }
        if (path==='meeting/locations') {
            const {data} = await q('meeting_locations').select('*');
            return _toMap(data,'id');
        }
        if (p[0]==='meeting'&&p[1]==='notifications'&&p.length===3) {
            const {data} = await q('meeting_notifications').select('*').eq('vendor_uid',p[2]).eq('handled',false).order('created_at',{ascending:false}).limit(1);
            if (!data || !data.length) return null;
            return {...(data[0].data||{}), type: data[0].type, handled: data[0].handled, _id: data[0].id};
        }
        if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===3) {
            const {data} = await q('meeting_driver_pickups').select('*').eq('driver_uid',p[2]);
            return _toMap(data,'passenger_uid', r => ({uid: r.passenger_uid, name: r.passenger_name, status: r.status, dropoffStatus: r.dropoff_status}));
        }
        return null;
    } catch(e) { return null; }
}

const _activeSubs = {};
function _subscribe(path, cb) {
    if (!_realSB) return;
    const p = path.split('/').filter(Boolean);
    let table = '';
    if (p[0]==='meeting'&&p[1]==='participants') table = 'meeting_participants';
    if (p[0]==='meeting'&&p[1]==='notifications') table = 'meeting_notifications';
    if (p[0]==='meeting'&&p[1]==='driverPickups') table = 'meeting_driver_pickups';
    if (!table) return;

    const subId = Math.random().toString(36).substring(7);
    _readPath(path).then(d => cb({val:()=>d}));

    const channel = _realSB.channel('v2_' + subId)
        .on('postgres_changes', {event:'*', schema:'public', table}, async () => {
            const d = await _readPath(path);
            cb({val:()=>d});
        })
        .subscribe();
    _activeSubs[path + subId] = channel;
}

class _Ref {
    constructor(path) { this.path = path; }
    async once() { const d = await _readPath(this.path); return {val:()=>d}; }
    on(ev, cb) { if (ev==='value') _subscribe(this.path, cb); return cb; }
    off() {}
    async set(d) { 
        const p = this.path.split('/').filter(Boolean);
        if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) {
            await _realSB.from('meeting_participants').upsert({
                vendor_uid: p[2], name: d.name, role: d.role, embark_status: d.embarkStatus,
                location_id: d.locationId, status: d.status, lat: d.lat, lng: d.lng, joined_at: new Date().toISOString()
            });
        }
    }
    async update(d) {
        const p = this.path.split('/').filter(Boolean);
        if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) {
            const up = {};
            if (d.embarkStatus) up.embark_status = d.embarkStatus;
            await _realSB.from('meeting_participants').update(up).eq('vendor_uid', p[2]);
        }
    }
}

const _shim = {
    database: () => ({ ref: (p) => new _Ref(p) }),
    auth: () => window.firebase?.auth ? window.firebase.auth() : null
};

// Sobrescreve as variáveis globais para forçar o uso da V2
window.supabase = _shim;
window.firebase = _shim;
console.log("UniRotas Shim V2: Ready.");
