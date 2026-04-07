/* UniRotas – Supabase Data & Auth Driver V2.6 (Pure Supabase - No Firebase) */
(function () {
    console.log("UniRotas Shim V2.6: Initializing Pure Supabase...");
    const _SUPA_URL = 'https://ajconwarkeunpixqngnq.supabase.co';
    const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';

    if (!window.supabase || !window.supabase.createClient) return;

    // O cliente REAL do Supabase
    const _sb = window.supabase.createClient(_SUPA_URL, _SUPA_KEY);

    // Exposição global limpa
    window.sb = _sb;
    window._supabase = _sb;
    window._supabaseClient = _sb;

    // Helpers de Mapeamento (para facilitar a vida do script.js e vendedor.js)
    window.sbHelper = {
        // Busca um usuário pelo UID
        async getUser(uid) {
            const { data } = await _sb.from('usuarios').select('*').eq('uid', uid).maybeSingle();
            return data;
        },
        // Busca mensagens de chat
        async getMessages(uid) {
            const { data } = await _sb.from('mensagens').select('*').eq('vendor_uid', uid).order('ts', { ascending: true });
            return data || [];
        },
        // Envia mensagem
        async sendMessage(uid, sender, text) {
            return await _sb.from('mensagens').insert({ vendor_uid: uid, sender, content: text, ts: new Date().toISOString() });
        },
        // Busca sessões de reunião (para o Gestor)
        async getMeetingSessions(date) {
            return await _sb.from('meeting_sessions').select('*').eq('date', date).order('created_at', { ascending: false });
        }
    };

    // Sobrescrevendo o objeto global 'supabase' para ser o CLIENTE REAL
    // Mas mantendo compatibilidade de nome se algum script chamar apenas 'supabase'
    const originalSupabase = window.supabase;
    window.supabase = _sb;
    window.supabase.original = originalSupabase;

    console.log("UniRotas Shim V2.6: Firebase Exterminated. Supabase Native Active.");
})();
