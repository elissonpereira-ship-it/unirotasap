const { createClient } = require('@supabase/supabase-js');
const url = 'https://ajconwarkeunpixqngnq.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';
const supabase = createClient(url, key);

async function initMasterAdmin() {
    const email = 'admin@unirotas.com';
    const pass = 'unirotasadmin2025';
    
    console.log('Attempting to create/update master admin...');

    // 1. Try to sign up the user at Supabase Auth
    // (Note: If email verification is ON, this might need manual confirmation in dashboard, 
    // but the DB record part will still identify the user if we can get the uid).
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password: pass });
    
    // If user already exists, try to login to get UID
    let uid = authData?.user?.id;
    if (authError && authError.status === 400 && authError.code === 'user_already_exists') {
        console.log('User already exists in Auth, trying to sign in...');
        const { data: signData, error: signError } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (signError) {
            console.error('Sign in failed (wrong password?):', signError.message);
            return;
        }
        uid = signData.user.id;
    } else if (authError) {
        console.error('Auth Error:', authError.message);
        return;
    }

    if (!uid) {
        console.error('Could not obtain UID for master admin.');
        return;
    }

    console.log('Master Admin Auth UID:', uid);

    // 2. Clean up old admins from usuarios table
    const { error: delError } = await supabase.from('usuarios').delete().eq('role', 'admin');
    if (delError) console.error('Delete Error:', delError.message);

    // 3. Upsert the master admin record
    const { error: upsertError } = await supabase.from('usuarios').upsert({
        uid: uid,
        name: 'Master Admin',
        cpf: 'admin',
        email: email,
        role: 'admin'
    });

    if (upsertError) {
        console.error('Upsert Error:', upsertError.message);
    } else {
        console.log('Master Admin "admin" initialized successfully!');
    }
}

initMasterAdmin();
