/* global firebase */
// Reading guide:
// 1. The top validates and initializes the shared Firebase app.
// 2. The middle exposes small auth helpers used by the login and control pages.
// 3. The bottom exports one global module, window.SkyShieldAuth.
// Search guide:
// - Ctrl+F `firebaseConfig` for the project keys and RTDB endpoint.
// - Ctrl+F `loginWithEmail` for email/password sign-in flow.
// - Ctrl+F `requireAuth` for page-protection and redirect behavior.
// - Ctrl+F `buildRedirectParam` for post-login return-to-page behavior.
// Key terms:
// - Firebase app: initialized SDK instance shared by auth and database calls.
// - auth state listener: callback triggered when Firebase knows whether a user is signed in.
// - redirect param: encoded page name added to the login URL so the user returns after auth.
// - shared auth module: the window.SkyShieldAuth object used by other scripts.
(function (window) {
  'use strict';

  // EXAM: firebase config.
  // These values identify the Firebase project used by the website for login and RTDB access.
  const firebaseConfig = {
    apiKey: 'AIzaSyBuRH94SdL8iA830JeKT2Xyp2LKXsw1EXk', // Public client key required by the web SDK to talk to this Firebase project.
    authDomain: 'skyshield-45d5e.firebaseapp.com', // Domain used by Firebase Auth for browser login flows.
    databaseURL: 'https://skyshield-45d5e-default-rtdb.firebaseio.com', // Realtime Database root URL used by the browser and device auto-discovery logic.
    projectId: 'skyshield-45d5e', // Unique Firebase project id.
    storageBucket: 'skyshield-45d5e.firebasestorage.app', // Storage bucket; not central to this page, but part of the app config bundle.
    messagingSenderId: '112895141645', // Firebase messaging sender id generated for the project.
    appId: '1:112895141645:web:bb6d411d096b8645cdf244' // Unique web app id for this frontend registration.
  };

  // EXAM: firebase sdk guard.
  // Fail early if the page forgot to load the Firebase scripts before this file.
  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK not detected. Load it before js/auth.js');
    return;
  }

  // EXAM: firebase app initialization.
  // Reuse an existing Firebase app if one is already alive, otherwise create it once from firebaseConfig.
  const app = firebase.apps && firebase.apps.length
    ? firebase.app()
    : firebase.initializeApp(firebaseConfig);

  const auth = firebase.auth(app); // Firebase Auth service instance used for login/logout/current-user queries.
  const database = typeof firebase.database === 'function' ? firebase.database(app) : null; // Optional RTDB instance exported for other scripts.

  // EXAM: login flow.
  // logs in a user using email and password via firebase auth
  async function loginWithEmail(rawEmail, rawPassword) {
    // Validat   e inputs and attempt Firebase email/password sign-in.
    const email = (rawEmail || '').trim(); // Remove accidental spaces before authenticating.
    const password = rawPassword || ''; // Preserve the exact password string the user typed.

    if (!email || !password) {
      return { ok: false, message: 'Enter both email and password.' };
    }

    try {
      const result = await auth.signInWithEmailAndPassword(email, password); // Ask Firebase Auth to validate credentials and create a session.
      return { ok: true, user: result.user };
    } catch (error) {
      return { ok: false, message: friendlyEmailError(error), code: error && error.code };
    }
  }

  // EXAM: auth error translation.
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

  // EXAM: logout.
  // signs out the currently authenticated user
  function logout() {
    // Call Firebase signOut to log the user out.
    return auth.signOut();
  }

  // EXAM: auth check.
  // checks whether a user is currently authenticated
  function isAuthenticated() {
    // Return true if Firebase has a current user object.
    return Boolean(auth.currentUser);
  }

  // EXAM: auth listener.
  // registers a listener for authentication state changes
  function onAuthChanged(callback) {
    // Subscribe to auth state changes and forward to callback.
    return auth.onAuthStateChanged(callback);
  }

  // EXAM: redirect parameter.
  // builds an encoded redirect parameter based on the current page
  function buildRedirectParam() {
    // Encode the current page path/query/hash for redirect after login.
    const { pathname, search, hash } = window.location; // Current browser URL parts.
    const fragment = `${pathname.split('/').pop() || ''}${search || ''}${hash || ''}`; // Reduce the URL to the local page + query/hash.
    return encodeURIComponent(fragment || 'control.html');
  }

  // EXAM: page protection.
  // protects a page by redirecting unauthenticated users to the login page
  function requireAuth(options = {}) {
    // Guard protected pages: redirect unauthenticated users and expose hooks.
    const loginPage = options.loginPage || 'index.html'; // Page to send unauthenticated users to.
    const skipRedirect = Boolean(options.skipRedirect); // Testing/debug option that keeps the page in place even if logged out.
    const disableRedirectParam = Boolean(options.disableRedirectParam); // Option to suppress ?redirect=... on the login URL.
    const onReady = typeof options.onReady === 'function' ? options.onReady : null; // Hook fired once auth state has been resolved.

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

  // EXAM: module export.
  // One global object exposes the shared auth/database helpers to every page script.
  window.SkyShieldAuth = {
    loginWithEmail, // Used by login.js to sign in with email/password.
    logout, // Used by pages with a logout button.
    isAuthenticated, // Small helper for checking current session presence.
    onAuthChanged, // Listener registration helper for pages that react to sign-in state.
    requireAuth, // Guard used by protected pages like control.html.
    auth, // Raw Firebase Auth instance for advanced access if needed.
    app, // Raw initialized Firebase app instance.
    database, // Raw RTDB instance used by control.js for sync.
    getDatabase: () => database // Small accessor that returns the same RTDB instance.
  };
})(window);
