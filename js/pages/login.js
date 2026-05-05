// Login page script: redirects authenticated users, submits credentials, and keeps the login card state in sync.
// Reading guide:
// 1. The top validates that the shared auth module exists.
// 2. The middle captures the form fields and watches auth state.
// 3. The bottom handles submit/loading/error/redirect behavior.
// Search guide:
// - Ctrl+F `redirect` for post-login navigation rules.
// - Ctrl+F `setLoading` for submit button spinner/disabled behavior.
// - Ctrl+F `showError` for login failure messaging.
// Key terms:
// - redirect target: page the user should land on after a successful login.
// - auth listener: callback that runs when Firebase auth state changes.
(function () {
  'use strict';

  // EXAM: shared auth module presence.
  if (!window.SkyShieldAuth) {
    console.error('SkyShieldAuth module failed to load.');
    return;
  }

  // EXAM: login page DOM capture and redirect target.
  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('emailInput');
  const passwordInput = document.getElementById('passwordInput');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const errorBox = document.getElementById('loginError');
  const params = new URLSearchParams(window.location.search);
  const redirectTarget = sanitizeRedirect(params.get('redirect'));

  let unsubAuthListener = null;

  // EXAM: already-authenticated redirect.
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

  // EXAM: submit login flow.
  async function handleLogin() {
    setLoading(true, 'Signing in...');
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

  // EXAM: loading button state.
  function setLoading(isLoading, label) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle('disabled', isLoading);
    if (isLoading && label) {
      submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${label}`;
    } else if (!isLoading) {
      submitBtn.innerHTML = '<i class="bi bi-shield-lock me-2"></i>Sign In';
    }
  }

  // EXAM: error display.
  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  // EXAM: clear login messages.
  function clearMessages() {
    errorBox.classList.add('d-none');
    errorBox.textContent = '';
  }

  // EXAM: safe redirect sanitization.
  function sanitizeRedirect(target) {
    if (!target || /^https?:\/\//i.test(target)) {
      return 'control.html';
    }
    return target;
  }
})();
