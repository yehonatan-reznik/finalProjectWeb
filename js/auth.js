/* global firebase */
(function (window) {
  'use strict';

  const firebaseConfig = {
    apiKey: 'AIzaSyBuRH94SdL8iA830JeKT2Xyp2LKXsw1EXk',
    authDomain: 'skyshield-45d5e.firebaseapp.com',
    projectId: 'skyshield-45d5e',
    storageBucket: 'skyshield-45d5e.firebasestorage.app',
    messagingSenderId: '112895141645',
    appId: '1:112895141645:web:bb6d411d096b8645cdf244'
  };

  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK not detected. Load it before js/auth.js');
    return;
  }

  const app = firebase.apps && firebase.apps.length
    ? firebase.app()
    : firebase.initializeApp(firebaseConfig);

  const auth = firebase.auth(app);

  async function loginWithEmail(rawEmail, rawPassword) {
    const email = (rawEmail || '').trim();
    const password = rawPassword || '';

    if (!email || !password) {
      return { ok: false, message: 'Enter both email and password.' };
    }

    try {
      const result = await auth.signInWithEmailAndPassword(email, password);
      return { ok: true, user: result.user };
    } catch (error) {
      return { ok: false, message: friendlyEmailError(error), code: error && error.code };
    }
  }

  function friendlyEmailError(error) {
    if (!error || !error.code) {
      return 'Authentication failed. Try again.';
    }

    switch (error.code) {
      case 'auth/invalid-email':
        return 'Email format is invalid.';
      case 'auth/user-disabled':
        return 'This account has been disabled.';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
        return 'Incorrect email or password.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait and try again.';
      default:
        return error.message || 'Authentication failed. Try again.';
    }
  }

  function logout() {
    return auth.signOut();
  }

  function isAuthenticated() {
    return Boolean(auth.currentUser);
  }

  function onAuthChanged(callback) {
    return auth.onAuthStateChanged(callback);
  }

  function buildRedirectParam() {
    const { pathname, search, hash } = window.location;
    const fragment = `${pathname.split('/').pop() || ''}${search || ''}${hash || ''}`;
    return encodeURIComponent(fragment || 'control.html');
  }

  function requireAuth(options = {}) {
    const loginPage = options.loginPage || 'index.html';
    const skipRedirect = Boolean(options.skipRedirect);
    const disableRedirectParam = Boolean(options.disableRedirectParam);
    const onReady = typeof options.onReady === 'function' ? options.onReady : null;

    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        if (typeof options.onAuthenticated === 'function') {
          options.onAuthenticated(user);
        }
      } else if (!skipRedirect) {
        const redirect = disableRedirectParam ? '' : `?redirect=${buildRedirectParam()}`;
        window.location.href = `${loginPage}${redirect}`;
      }

      if (onReady) {
        onReady(user);
      }
    });

    return unsubscribe;
  }

  window.SkyShieldAuth = {
    loginWithEmail,
    logout,
    isAuthenticated,
    onAuthChanged,
    requireAuth,
    auth
  };
})(window);
