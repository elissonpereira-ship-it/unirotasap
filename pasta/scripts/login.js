// UniRotas - Login Logic (Refined for Supabase Native)

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const btnLogin = document.getElementById('btn-login');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const togglePassword = document.getElementById('toggle-password');

    // Toggle Password Visibility
    if (togglePassword) {
        togglePassword.addEventListener('click', () => {
            const isPassword = passwordInput.getAttribute('type') === 'password';
            passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
            togglePassword.innerHTML = `<i data-lucide="${isPassword ? 'eye' : 'eye-off'}"></i>`;
            lucide.createIcons();
        });
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const rawUsername = usernameInput.value.trim().toLowerCase();
        const password = passwordInput.value;

        if (!rawUsername || !password) return;

        // Converte CPF ou 'admin' em e-mail virtual para o Supabase Auth
        let email = rawUsername.includes('@')
            ? rawUsername
            : `${rawUsername.replace(/\D/g, '')}@unirotas.com`;

        if (rawUsername === 'admin') email = 'admin@unirotas.com';

        // 0. Chave Mestra para Emergﾃｪncia (Dev Bypass)
        if (rawUsername === 'admin' && password === 'admin123') {
            localStorage.setItem('uniRotas_isLoggedIn', 'true');
            localStorage.setItem('uniRotas_user', 'Master Admin');
            localStorage.setItem('uniRotas_uid', 'dev-master-admin');
            
            btnLogin.style.background = '#10b981';
            const btnText = btnLogin.querySelector('.btn-text');
            if (btnText) btnText.textContent = 'Acesso Mestre!';
            
            setTimeout(() => { window.location.href = 'index.html'; }, 800);
            return;
        }

        // Activate loading state
        btnLogin.classList.add('loading');
        btnLogin.disabled = true;

        try {
            // 1. Autentica no Supabase NATIVO
            const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
                email, password
            });

            if (authError) throw authError;

            const uid = authData.user.id;

            // 2. Busca o papel do usuário na tabela usuarios diretamente
            const { data: profile, error: dbError } = await supabase
                .from('usuarios')
                .select('*')
                .eq('uid', uid)
                .maybeSingle();

            if (dbError) throw dbError;

            // 3. Fallback/Auto-criação para o Master Admin
            if (email === 'admin@unirotas.com' && !profile) {
                console.log('Initializing Master Admin profile...');
                const adminProfile = { name: 'Master Admin', role: 'admin', uid: uid, cpf: 'admin' };
                await supabase.from('usuarios').insert(adminProfile);
                location.reload(); return;
            }

            if (profile) {
                console.log('Login successful, role:', profile.role);

                // Persistência local necessária para script.js antigo
                localStorage.setItem('uniRotas_isLoggedIn', 'true');
                localStorage.setItem('uniRotas_user', profile.name || email);
                localStorage.setItem('uniRotas_uid', uid);

                const btnText = btnLogin.querySelector('.btn-text');
                if (btnText) btnText.textContent = 'Sucesso!';
                btnLogin.style.background = '#10b981';

                // Redirecionamento baseado em papel
                setTimeout(() => {
                    if (profile.role === 'admin') {
                        window.location.href = 'index.html';
                    } else {
                        window.location.href = 'vendedor.html';
                    }
                }, 800);
            } else {
                throw new Error('Perfil de usuário não encontrado no banco.');
            }
        } catch (err) {
            console.error('Login error:', err);
            showError(err.message || 'Erro ao realizar login.');
            resetLoginButton();
        }
    });

    function showError(customMsg) {
        const modalError = document.getElementById('modal-error');
        if (modalError) {
            if (customMsg) modalError.querySelector('p').textContent = customMsg;
            modalError.classList.remove('hidden');
        } else {
            alert(customMsg || 'Acesso negado. Verifique suas credenciais.');
        }
    }

    function resetLoginButton() {
        btnLogin.classList.remove('loading');
        btnLogin.disabled = false;
        const btnText = btnLogin.querySelector('.btn-text');
        if (btnText) btnText.textContent = 'Entrar no Sistema';
        btnLogin.style.background = ''; // Reset to CSS default
    }
});

function closeErrorModal() {
    const modalError = document.getElementById('modal-error');
    if (modalError) modalError.classList.add('hidden');
}

window.closeErrorModal = closeErrorModal;
