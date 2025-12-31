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

  // logs in a user using email and password via firebase auth
  async function loginWithEmail(rawEmail, rawPassword) {
    // Validat   e inputs and attempt Firebase email/password sign-in.
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

  // converts firebase auth error codes into user-friendly messages
  function friendlyEmailError(error) {
    // Map Firebase auth error codes to readable messages.
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

  // signs out the currently authenticated user
  function logout() {
    // Call Firebase signOut to log the user out.
    return auth.signOut();
  }

  // checks whether a user is currently authenticated
  function isAuthenticated() {
    // Return true if Firebase has a current user object.
    return Boolean(auth.currentUser);
  }

  // registers a listener for authentication state changes
  function onAuthChanged(callback) {
    // Subscribe to auth state changes and forward to callback.
    return auth.onAuthStateChanged(callback);
  }

  // builds an encoded redirect parameter based on the current page
  function buildRedirectParam() {
    // Encode the current page path/query/hash for redirect after login.
    const { pathname, search, hash } = window.location;
    const fragment = `${pathname.split('/').pop() || ''}${search || ''}${hash || ''}`;
    return encodeURIComponent(fragment || 'control.html');
  }

  // protects a page by redirecting unauthenticated users to the login page
  function requireAuth(options = {}) {
    // Guard protected pages: redirect unauthenticated users and expose hooks.
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
