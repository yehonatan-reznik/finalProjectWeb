(function () {
  'use strict';

  if (!window.SkyShieldAuth) {
    console.error('SkyShieldAuth module failed to load.');
    return;
  }

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('emailInput');
  const passwordInput = document.getElementById('passwordInput');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const errorBox = document.getElementById('loginError');
  const params = new URLSearchParams(window.location.search);
  const redirectTarget = sanitizeRedirect(params.get('redirect'));

  let unsubAuthListener = null;

  unsubAuthListener = window.SkyShieldAuth.onAuthChanged((user) => {
    if (user) {
      window.location.href = redirectTarget;
    }
  });

  window.addEventListener('beforeunload', () => {
    if (typeof unsubAuthListener === 'function') {
      unsubAuthListener();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();

    await handleLogin();
  });

  async function handleLogin() {
    setLoading(true, 'Authenticatingג€¦');
    const result = await window.SkyShieldAuth.loginWithEmail(emailInput.value, passwordInput.value);
    setLoading(false);

    if (!result.ok) {
      showError(result.message);
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    form.reset();
    window.location.href = redirectTarget;
  }

  function setLoading(isLoading, label) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle('disabled', isLoading);
    if (isLoading && label) {
      submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${label}`;
    } else if (!isLoading) {
      submitBtn.innerHTML = '<i class="bi bi-shield-lock me-2"></i>Authenticate';
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function clearMessages() {
    errorBox.classList.add('d-none');
    errorBox.textContent = '';
  }

  function sanitizeRedirect(target) {
    if (!target || /^https?:\/\//i.test(target)) {
      return 'control.html';
    }
    return target;
  }
})();
