// Kirish sahifasi
(() => {
  const { store, api } = window.Oyin;

  const form = document.getElementById('login-form');
  const tabs = form.querySelectorAll('[data-role]');
  const errorEl = form.querySelector('.form-error');
  const submitBtn = form.querySelector('button[type="submit"]');
  const loginInput = form.elements.login;
  const passwordInput = form.elements.password;

  let role = store.get('lastRole') === 'owner' ? 'owner' : 'user';

  function setRole(next) {
    role = next;
    tabs.forEach((tab) => {
      const active = tab.dataset.role === role;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    loginInput.placeholder = role === 'owner' ? 'email' : 'login';
    hideError();
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError() {
    errorEl.hidden = true;
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.textContent = loading ? 'Tekshirilmoqda…' : 'Kirish';
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    setRole(tab.dataset.role);
    loginInput.focus();
  }));
  [loginInput, passwordInput].forEach((input) => input.addEventListener('input', hideError));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const login = loginInput.value.trim();
    const password = passwordInput.value.trim();

    if (!login || !password) {
      showError('Login va parolni kiriting');
      (login ? passwordInput : loginInput).focus();
      return;
    }

    setLoading(true);
    try {
      const data = await api('/api/login', { method: 'POST', body: { role, login, password } });
      store.set('lastRole', data.role || role);
      window.location.href = data.redirect || '/panel';
    } catch (err) {
      showError(err.message);
      setLoading(false);
      passwordInput.select();
    }
  });

  setRole(role);
  loginInput.focus();
})();
