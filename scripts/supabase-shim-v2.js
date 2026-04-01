/* UniRotas – Supabase Data & Auth Driver V2.3 (Final Fix) */
(function() {
    console.log("UniRotas Shim V2.3: Initializing...");
    const _SUPA_URL = 'https://ajconwarkeunpixqngnq.supabase.co';
    const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';
    
    if (!window.supabase || !window.supabase.createClient) {
        console.error("Erro: Biblioteca Supabase não encontrada!");
        return;
    }
    const _realSB = window.supabase.createClient(_SUPA_URL, _SUPA_KEY);
    let _cachedUser = null;

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
        const p = path.split('/').filter(Boolean);
        const q = (t) => _realSB.from(t);
        try {
            if (p[0]==='usuarios' && p.length===2) {
                const {data} = await q('usuarios').select('*').eq('uid', p[1]).limit(1);
                return data && data.length ? data[0] : null;
            }
            if (p[0]==='vendedores' && p.length===2) {
                const {data} = await q('vendedores').select('*').eq('uid', p[1]).limit(1);
                return data && data.length ? data[0] : null;
            }
            if (path==='meeting/locations') {
                const {data} = await q('meeting_locations').select('*');
                return _toMap(data,'id');
            }
            if (p[0]==='meeting'&&p[1]==='participants'&&p.length===3) {
                const {data} = await q('meeting_participants').select('*').eq('vendor_uid',p[2]).limit(1);
                return data && data.length ? _normPart(data[0]) : null;
            }
            if (path==='meeting/participants') {
                const {data} = await q('meeting_participants').select('*');
                return _toMap(data,'vendor_uid',_normPart);
            }
            if (p[0]==='meeting'&&p[1]==='driverPickups'&&p.length===3) {
                const {data} = await q('meeting_driver_pickups').select('*').eq('driver_uid',p[2]);
                return _toMap(data,'passenger_uid', r => ({uid: r.passenger_uid, name: r.passenger_name, status: r.status, dropoffStatus: r.dropoff_status}));
            }
            if (p[0]==='meeting'&&p[1]==='notifications'&&p.length===3) {
                const {data} = await q('meeting_notifications').select('*').eq('vendor_uid',p[2]).eq('handled',false).order('created_at',{ascending:false}).limit(1);
                return data && data.length ? {...(data[0].data||{}), type: data[0].type, handled: data[0].handled, _id: data[0].id} : null;
            }
            return null;
        } catch(e) { return null; }
    }

    const _auth = {
        get currentUser() { return _cachedUser; },
        onAuthStateChanged(cb) {
            _realSB.auth.getSession().then(({data:{session}}) => {
                _cachedUser = session?.user ? { uid: session.user.id } : null;
                cb(_cachedUser);
            });
            _realSB.auth.onAuthStateChange((_, session) => {
                _cachedUser = session?.user ? { uid: session.user.id } : null;
                cb(_cachedUser);
            });
        },
        async signInWithEmailAndPassword(email, password) {
            const { data, error } = await _realSB.auth.signInWithPassword({ email, password });
            if (error) throw error;
            _cachedUser = { uid: data.user.id };
            return { user: _cachedUser };
        },
        async signOut() { _cachedUser = null; return await _realSB.auth.signOut(); }
    };

    class _Ref {
        constructor(path) { this.path = path; }
        async once() { const d = await _readPath(this.path); return {val:()=>d}; }
        on(ev, cb) { 
            const p = this.path.split('/').filter(Boolean);
            let table = '';
            if (p[0]==='meeting'&&p[1]==='participants') table = 'meeting_participants';
            if (p[0]==='meeting'&&p[1]==='notifications') table = 'meeting_notifications';
            if (!table) return cb;
            
            _readPath(this.path).then(d => cb({val:()=>d}));
            const subId = Math.random().toString(36).substring(7);
            const channel = _realSB.channel('vfinal_' + subId)
                .on('postgres_changes', {event:'*', schema:'public', table}, async () => {
                    const d = await _readPath(this.path);
                    cb({val:()=>d});
                }).subscribe();
            return cb;
        }
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
        async push(d) {
            const p = this.path.split('/').filter(Boolean);
            if (p[0]==='mensagens'&&p.length===2) {
                await _realSB.from('mensagens').insert({ vendor_uid: p[1], sender: d.sender, content: d.text, ts: new Date().toISOString() });
            }
        }
    }

    window.firebase = {
        database: () => ({ ref: (p) => new _Ref(p) }),
        auth: () => _auth
    };
    window.supabase.database = window.firebase.database;
    window.supabase.auth = () => _auth;

    console.log("UniRotas Shim V2.3: Ready.");
})();
