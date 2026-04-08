const { createClient } = require('@supabase/supabase-js');
const url = 'https://ajconwarkeunpixqngnq.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqY29ud2Fya2V1bnBpeHFuZ25xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4OTQ2MDksImV4cCI6MjA5MDQ3MDYwOX0.HFHmApPMYKT_GZLJwDAY8IZSaM38CjVUN1amAah4wZM';
const supabase = createClient(url, key);

async function checkAdmins() {
    const { data, error } = await supabase.from('usuarios').select('cpf, name, role').eq('role', 'admin');
    if (error) {
        console.error('Error:', error);
    } else {
        console.log('Admins:', data);
    }
}
checkAdmins();
