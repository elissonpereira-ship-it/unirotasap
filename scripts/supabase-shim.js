/* UniRotas – Supabase Data & Auth Driver (Compatibility Layer) */
const _SUPA_URL = 'https://ajconwarkeunpixqngnq.supabase.co';
const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';
const _sb = window.supabase.createClient(_SUPA_URL, _SUPA_KEY);

// ── HELPERS ────────────────────────────────────────────────────────────────
function _toMap(arr, key, fn) {
    if (!arr || !arr.length) return null;
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
function _denormPart(d) {
    const r = {};
    if (d.uid !== undefined) r.vendor_uid = d.uid;
    if (d.name !== undefined) r.name = d.name;
    if (d.role !== undefined) r.role = d.role;
    if (d.embarkStatus !== undefined) r.embark_status = d.embarkStatus;
    if (d.locationId !== undefined) r.location_id = d.locationId;
    if (d.locationName !== undefined) r.location_name = d.locationName;
    if (d.locationAddress !== undefined) r.location_address = d.locationAddress;
    if (d.region !== undefined) r.region = d.region;
    if (d.lat !== undefined) r.lat = d.lat;
    if (d.lng !== undefined) r.lng = d.lng;
    if (d.phase !== undefined) r.phase = d.phase;
    if (d.presenceConfirmed !== undefined) r.presence_confirmed = d.presenceConfirmed;
    if (d.driverUid !== undefined) r.driver_uid = d.driverUid;
    if (d.driverName !== undefined) r.driver_name = d.driverName;
    if (d.status !== undefined) r.status = d.status;
    if (d.passengers !== undefined) r.passengers = d.passengers;
    return r;
}
function _normPickup(row) {
    return { uid: row.passenger_uid, name: row.passenger_name, address: row.passenger_address,
        status: row.status, dropoffStatus: row.dropoff_status, order: row.sort_order };
}

// ── PATH READ ──────────────────────────────────────────────────────────────
async function _readPath(path) {
    const p = path.split('/').filter(Boolean);
    const q = (t) => _sb.from(t);

    if (p[0]==='vendedores' && p.length===1) {
        const {data} = await q('vendedores').select('*');
        return _toMap(data,'uid');
    }
    if (p[0]==='vendedores' && p.length===2) {
        const {data,error} = await q('vendedores').select('*').eq('uid',p[1]).single();
        return error ? null : data;
    }
    if (p[0]==='usuarios' && p.length===1) {
        const {data} = await q('usuarios').select('*');
        return _toMap(data,'uid');
    }
    if (p[0]==='usuarios' && p.length===2) {
        const {data,error} = await q('usuarios').select('*').eq('uid',p[1]).single();
        return error ? null : data;
    }
    if (p[0]==='mensagens' && p.length===1) {
        const {data} = await q('mensagens').select('*').order('ts');
        if (!data) return {};
        return data.reduce((acc, r) => {
            if (!acc[r.vendor_uid]) acc[r.vendor_uid] = {};
            acc[r.vendor_uid][r.id] = {sender:r.sender,text:r.content,timestamp:new Date(r.ts).getTime(),read:r.read};
            return acc;
        }, {});
    }
    if (p[0]==='mensagens' && p.length===2) {
        const {data} = await q('mensagens').select('*').eq('vendor_uid',p[1]).order('ts');
        return _toMap(data,'id', r=>({sender:r.sender,text:r.content,timestamp:new Date(r.ts).getTime(),read:r.read}));
    }
    if (p[0]==='typing' && p.length===3) {
        const {data} = await q('typing_status').select('*').eq('vendor_uid',p[1]).single();
        if (!data) return false;
        return p[2]==='admin' ? (data.admin_typing||false) : (data.vendor_typing||false);
    }
    if (p[0]==='routes' && p.length===2) {
        const {data} = await q('routes').select('*').eq('vendor_uid',p[1]).order('created_at',{ascending:false}).limit(1);
        if (!data||!data.length) return null;
        return {waypoints:data[0].waypoints, optimized:data[0].optimized};
    }
    if (path==='meeting/config/activeLocation') {
        const {data} = await q('meeting_config').select('value').eq('key','activeLocation').single();
        return data?.value ?? null;
    }
    if (path==='meeting/locations') {
        const {data} = await q('meeting_locations').select('*');
        return _toMap(data,'id');
    }
    if (p[0]==='meeting'&&p[1]==='locations'&&p.length===3) {
        const {data,error} = await q('meeting_locations').select('*').eq('id',p[2]).single();
        return error ? null : data;
    }
    if (path==='meeting/participants') {
        const {data} = await q('meeting_participants').select('*');
        return _toMap(data,'vendor_uid',_normPart);
    }
    if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) {
        const {data,error} = await q('meeting_participants').select('*').eq('vendor_uid',p[2]).single();
        return error ? null : _normPart(data);
    }
    if (p[0]==='meeting'&&p[1]==='participants'&&p.length===4) {
        const {data,error} = await q('meeting_participants').select('*').eq('vendor_uid',p[2]).single();
        if (error||!data) return null;
        return _normPart(data)?.[p[3]] ?? null;
    }
    if (p[0]==='meeting'&&p[1]==='notifications'&&p.length===3) {
        const {data} = await q('meeting_notifications').select('*').eq('vendor_uid',p[2]).eq('handled',false).order('created_at',{ascending:false}).limit(1);
        if (!data||!data.length) return null;
        const row=data[0];
        return {...(row.data||{}),type:row.type,handled:row.handled,_id:row.id};
    }
    if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===3) {
        const {data} = await q('meeting_driver_pickups').select('*').eq('driver_uid',p[2]);
        return _toMap(data,'passenger_uid',_normPickup);
    }
    if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===4) {
        const {data,error} = await q('meeting_driver_pickups').select('*').eq('driver_uid',p[2]).eq('passenger_uid',p[3]).single();
        return error ? null : _normPickup(data);
    }
    if (p[0]==='meeting'&&p[1]==='attendance'&&p.length===3) {
        const {data} = await q('meeting_attendance').select('*').eq('date',p[2]);
        return _toMap(data,'vendor_uid',r=>({name:r.name,role:r.role,driverUid:r.driver_uid,locationId:r.location_id,locationName:r.location_name,region:r.region}));
    }
    if (p[0]==='meeting'&&p[1]==='history'&&p.length===4) {
        const {data,error} = await q('meeting_history').select('*').eq('date',p[2]).eq('driver_uid',p[3]).single();
        return error ? null : {driverName:data.driver_name,driverUid:data.driver_uid,passengers:data.passengers,vehicleType:data.vehicle_type||'carro',realRoute:data.real_route||[],predictedRoute:data.predicted_route||[]};
    }
    if (p[0]==='meeting'&&p[1]==='chats'&&p.length===3) {
        const {data} = await q('meeting_chats').select('*').eq('room_key',p[2]).order('ts');
        return _toMap(data,'id',r=>({senderUid:r.sender_uid,senderName:r.sender_name,text:r.content,timestamp:new Date(r.ts).getTime()}));
    }
    return null;
}

// ── PATH WRITE ─────────────────────────────────────────────────────────────
async function _writePath(path, data) {
    const p = path.split('/').filter(Boolean);
    const now = new Date().toISOString();
    const q = (t) => _sb.from(t);

    let res;
    if (p[0]==='vendedores'&&p.length===2)
        res = await q('vendedores').upsert({uid:p[1],name:data.name,status:data.status,lat:data.lat,lon:data.lon,last_active:now});
    else if (p[0]==='usuarios'&&p.length===2)
        res = await q('usuarios').upsert({uid:p[1],name:data.name,cpf:data.cpf,email:data.email,address:data.address,registered_at:now});
    else if (path==='meeting/config/activeLocation')
        res = await q('meeting_config').upsert({key:'activeLocation',value:data});
    else if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3)
        res = await q('meeting_participants').upsert({..._denormPart({uid:p[2],...data}),joined_at:now});
    else if (p[0] === 'meeting' && p[1] === 'notifications' && p.length === 3) {
        await q('meeting_notifications').insert({ vendor_uid: p[2], type: data.type, handled: data.handled || false, data: data });
        return;
    }
    else if (p[0] === 'meeting' && p[1] === 'history' && p.length === 4) {
        await q('meeting_history').upsert({ date: p[2], vendor_uid: p[3], data: data, updated_at: new Date().toISOString() });
        return;
    }
    else if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===4)
        res = await q('meeting_driver_pickups').upsert({driver_uid:p[2],passenger_uid:p[3],passenger_name:data.name,status:data.status,sort_order:data.order||0},{onConflict:'driver_uid,passenger_uid'});
    else if (p[0]==='meeting'&&p[1]==='attendance'&&p.length===4)
        res = await q('meeting_attendance').upsert({date:p[2],vendor_uid:p[3],name:data.name,role:data.role,driver_uid:data.driverUid||null,location_id:data.locationId,location_name:data.locationName,region:data.region||'',confirmed_at:now},{onConflict:'date,vendor_uid'});
    else if (p[0]==='typing'&&p.length===3) {
        const col = p[2]==='admin' ? {admin_typing:data} : {vendor_typing:data};
        res = await q('typing_status').upsert({vendor_uid:p[1],...col});
    }
    else if (p[0]==='vendedores'&&p.length===3&&p[2]==='rota')
        res = await q('routes').upsert({vendor_uid:p[1],waypoints:data.waypoints,optimized:data.optimized||false});

    if (res && res.error) {
        console.error(`Supabase Write Error (${path}):`, res.error);
        throw new Error(res.error.message);
    }
    return res;
}

async function _updatePath(path, data) {
    const p = path.split('/').filter(Boolean);
    const now = new Date().toISOString();
    const q = (t) => _sb.from(t);

    let res;
    if (p[0]==='vendedores'&&p.length===2) {
        const u={last_active:now};
        if (data.status!==undefined) u.status=data.status;
        if (data.name!==undefined) u.name=data.name;
        if (data.lat!==undefined) u.lat=data.lat;
        if (data.lon!==undefined) u.lon=data.lon;
        res = await q('vendedores').upsert({uid:p[1],...u});
    }
    else if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3)
        res = await q('meeting_participants').update(_denormPart(data)).eq('vendor_uid',p[2]);
    else if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===4) {
        const u={};
        if (data.status!==undefined) u.status=data.status;
        if (data.dropoffStatus!==undefined) u.dropoff_status=data.dropoffStatus;
        res = await q('meeting_driver_pickups').update(u).eq('driver_uid',p[2]).eq('passenger_uid',p[3]);
    }
    else if (p[0] === 'meeting' && p[1] === 'notifications' && p.length === 3) {
        await q('meeting_notifications').update({ handled: data.handled }).eq('vendor_uid', p[2]);
        return;
    }
    else if (p[0] === 'meeting' && p[1] === 'history' && p.length === 4) {
        await q('meeting_history').upsert({ date: p[2], vendor_uid: p[3], data: data, updated_at: new Date().toISOString() });
        return;
    }
    else if (p[0]==='meeting'&&p[1]==='locations'&&p.length===3)
        res = await q('meeting_locations').update({name:data.name,region:data.region,address:data.address,lat:data.lat,lng:data.lng}).eq('id',p[2]);
    else if (p[0]==='meeting'&&p[1]==='history'&&p.length===4) {
        const u={};
        if (data.driverName!==undefined) u.driver_name=data.driverName;
        if (data.passengers!==undefined) u.passengers=data.passengers;
        if (data.vehicleType!==undefined) u.vehicle_type=data.vehicleType;
        if (data.realRoute!==undefined) u.real_route=data.realRoute;
        if (data.predictedRoute!==undefined) u.predicted_route=data.predictedRoute;
        if (data.completedAt!==undefined) u.completed_at=new Date(data.completedAt).toISOString();
        res = await q('meeting_history').upsert({date:p[2],driver_uid:p[3],...u},{onConflict:'date,driver_uid'});
    }

    if (res && res.error) {
        console.error(`Supabase Update Error (${path}):`, res.error);
        throw new Error(res.error.message);
    }
    return res;
}

async function _removePath(path) {
    const p = path.split('/').filter(Boolean);
    const q = (t) => _sb.from(t);
    if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) return q('meeting_participants').delete().eq('vendor_uid',p[2]);
    if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===3) return q('meeting_driver_pickups').delete().eq('driver_uid',p[2]);
    if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===4) return q('meeting_driver_pickups').delete().eq('driver_uid',p[2]).eq('passenger_uid',p[3]);
    if (p[0]==='mensagens'&&p.length===2) return q('mensagens').delete().eq('vendor_uid',p[1]);
    if (p[0]==='mensagens'&&p.length===3) return q('mensagens').delete().eq('id',p[2]);
    if (p[0]==='meeting'&&p[1]==='locations'&&p.length===3) return q('meeting_locations').delete().eq('id',p[2]);
}

async function _pushToPath(path, data) {
    const p = path.split('/').filter(Boolean);
    const now = new Date().toISOString();
    const q = (t) => _sb.from(t);
    let res;
    if (p[0]==='mensagens'&&p.length===2)
        res = await q('mensagens').insert({vendor_uid:p[1],sender:data.sender,content:data.text,read:data.read??false,ts:now});
    else if (p[0]==='meeting'&&p[1]==='chats'&&p.length===3)
        res = await q('meeting_chats').insert({room_key:p[2],sender_uid:data.senderUid,sender_name:data.senderName,content:data.text,ts:now});
    else if (p[0]==='meeting'&&p[1]==='locations'&&p.length===2) {
        console.log("DEBUG: Push to meeting_locations", data);
        res = await q('meeting_locations').insert({name:data.name,region:data.region,address:data.address,lat:data.lat,lng:data.lng,created_at:now});
    }
    else if (p[0]==='audit_logs'&&p.length===2)
        res = await q('audit_logs').insert({vendor_uid:p[1],type:data.type,lat:data.lat,lng:data.lng,ts:now});

    if (res && res.error) {
        console.error(`Supabase Push Error (${path}):`, res.error);
        throw new Error(res.error.message);
    }
    return res;
}

// ── REALTIME SUBSCRIPTIONS ─────────────────────────────────────────────────
const _activeSubs = {}; // key -> {channel, path, cb}

function _subKey(path, cb) { return path + '::' + (cb._subId || (cb._subId = ++_subKey._n)); }
_subKey._n = 0;

function _pathToTable(path) {
    const p = path.split('/').filter(Boolean);
    if (p[0]==='vendedores') return 'vendedores';
    if (p[0]==='mensagens') return 'mensagens';
    if (p[0]==='typing') return 'typing_status';
    if (p[0]==='routes') return 'routes';
    if (p[0]==='meeting'&&p[1]==='config') return 'meeting_config';
    if (p[0]==='meeting'&&p[1]==='locations') return 'meeting_locations';
    if (p[0]==='meeting'&&p[1]==='participants') return 'meeting_participants';
    if (p[0]==='meeting'&&p[1]==='notifications') return 'meeting_notifications';
    if (p[0]==='meeting'&&p[1]==='driverPickups') return 'meeting_driver_pickups';
    if (p[0]==='meeting'&&p[1]==='chats') return 'meeting_chats';
    if (p[0]==='usuarios') return 'usuarios';
    return null;
}

function _subscribe(path, cb) {
    const table = _pathToTable(path);
    if (!table) return;
    const key = _subKey(path, cb);
    // Initial read
    _readPath(path).then(data => cb({val:()=>data}));
    // Realtime changes – refetch path on any change to table
    const channel = _sb.channel('shim_' + key)
        .on('postgres_changes', {event:'*',schema:'public',table}, async () => {
            const data = await _readPath(path);
            cb({val:()=>data});
        })
        .subscribe();
    _activeSubs[key] = {channel, path, cb};
}

function _unsubscribe(path, cb) {
    const key = _subKey(path, cb);
    if (_activeSubs[key]) {
        _sb.removeChannel(_activeSubs[key].channel);
        delete _activeSubs[key];
    }
}

// ── SUPABASE REF SHIM (Firebase Style) ──────────────────────────────────────────────────────
class _Ref {
    constructor(path) { this.path = path; }
    async once(ev) {
        const data = await _readPath(this.path);
        return { val: () => data };
    }
    on(ev, cb) {
        if (ev === 'value') _subscribe(this.path, cb);
        return cb;
    }
    off(ev, cb) {
        if (cb) _unsubscribe(this.path, cb);
        else {
            // Remove all subs for this path
            Object.keys(_activeSubs).forEach(k => {
                if (_activeSubs[k].path === this.path) {
                    _sb.removeChannel(_activeSubs[k].channel);
                    delete _activeSubs[k];
                }
            });
        }
    }
    async set(data)    { await _writePath(this.path, data); }
    async update(data) { await _updatePath(this.path, data); }
    async push(data)   { await _pushToPath(this.path, data); }
    async remove()     { await _removePath(this.path); }
    onDisconnect() {
        return {
            update: async (data) => {
                // Best-effort: call on page unload
                window.addEventListener('beforeunload', () => navigator.sendBeacon(_SUPA_URL + '/rest/v1/vendedores', JSON.stringify({status:'Offline'})));
            },
            set: () => {}
        };
    }
}

// ── SUPABASE AUTH SHIM (Firebase Style) ─────────────────────────────────────────────────────
const _auth = {
    _user: null,
    get currentUser() { return this._user ? {uid: this._user.id} : null; },

    async signInWithEmailAndPassword(email, password) {
        const {data, error} = await _sb.auth.signInWithPassword({email, password});
        if (error) throw _mapErr(error);
        this._user = data.user;
        return {user: {uid: data.user.id}};
    },
    async createUserWithEmailAndPassword(email, password) {
        const {data, error} = await _sb.auth.signUp({email, password});
        if (error) throw _mapErr(error);
        this._user = data.user;
        return {user: {uid: data.user.id}};
    },
    async signOut() {
        await _sb.auth.signOut();
        this._user = null;
    },
    onAuthStateChanged(cb) {
        _sb.auth.getSession().then(({data:{session}}) => {
            this._user = session?.user || null;
            cb(this._user ? {uid: this._user.id} : null);
        }).catch(err => {
            console.error("Supabase Shim: Session Error:", err);
            cb(null); // Prossegue sem usuário se der erro
        });
        _sb.auth.onAuthStateChange((_, session) => {
            this._user = session?.user || null;
            cb(this._user ? {uid: this._user.id} : null);
        });
    }
};

function _mapErr(error) {
    const msg = error.message || '';
    let code = 'auth/unknown';
    if (msg.includes('Invalid login') || msg.includes('invalid_credentials')) code = 'auth/invalid-credential';
    else if (msg.includes('already registered') || msg.includes('already been registered')) code = 'auth/email-already-in-use';
    else if (msg.includes('Password') || msg.includes('password')) code = 'auth/weak-password';
    else if (msg.includes('network') || msg.includes('fetch')) code = 'auth/network-request-failed';
    else if (msg.includes('over_request_rate') || msg.includes('too many')) code = 'auth/too-many-requests';
    return {code, message: msg};
}

// ── GLOBAL firebase OBJECT ─────────────────────────────────────────────────
function _dbFn() { return { ref: (path) => new _Ref(path) }; }
_dbFn.ServerValue = { TIMESTAMP: Date.now() };

const _supabaseShim = {
    auth: () => _auth,
    database: _dbFn
};

window.supabase = _supabaseShim;
window.firebase = _supabaseShim; // Alias para compatibilidade legada
