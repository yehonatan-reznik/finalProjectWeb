(function (window, document) {
  'use strict';

  const LOGIN_PAGE = 'index.html';
  const SESSION_KEY = 'skyshield_auth_user';
  const DEFAULT_USERS = [
    { username: 'commander', password: 'shield123' },
    { username: 'observer', password: 'falcon987' },
    { username: 'a', password: 'a' }
  ];

  const USERS = Array.isArray(window.SkyShieldUsers) && window.SkyShieldUsers.length
    ? window.SkyShieldUsers
    : DEFAULT_USERS;

  function normalizeUsername(value) {
    return (value || '').trim().toLowerCase();
  }

  function findUser(username) {
    const normalized = normalizeUsername(username);
    return USERS.find((user) => normalizeUsername(user.username) === normalized);
  }

  function login(username, password) {
    const trimmedUser = (username || '').trim();
    const suppliedPassword = password || '';

    if (!trimmedUser || !suppliedPassword) {
      return { ok: false, message: 'Enter both username and password.' };
    }

    const record = findUser(trimmedUser);
    if (!record || record.password !== suppliedPassword) {
      return { ok: false, message: 'Invalid username or password.' };
    }

    sessionStorage.setItem(SESSION_KEY, record.username);
    return { ok: true, user: record.username };
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function isAuthenticated() {
    return Boolean(sessionStorage.getItem(SESSION_KEY));
  }

  function currentUser() {
    return sessionStorage.getItem(SESSION_KEY);
  }

  function buildRedirectParam() {
    const path = window.location.pathname.split('/').pop() || 'control.html';
    const query = window.location.search || '';
    const hash = window.location.hash || '';
    return encodeURIComponent(path + query + hash);
  }

  function requireAuth(options = {}) {
    if (isAuthenticated()) {
      return true;
    }

    const loginTarget = options.loginPage || LOGIN_PAGE;
    const redirect = options.skipRedirect ? '' : `?redirect=${buildRedirectParam()}`;
    window.location.href = `${loginTarget}${redirect}`;
    return false;
  }

  function hydrateLogouts() {
    const targets = document.querySelectorAll('[data-action="logout"]');
    targets.forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        logout();
        window.location.href = LOGIN_PAGE;
      });
    });
  }

  document.addEventListener('DOMContentLoaded', hydrateLogouts);

  window.SkyShieldAuth = {
    login,
    logout,
    requireAuth,
    isAuthenticated,
    currentUser,
    SESSION_KEY,
    USERS
  };
})(window, document);
