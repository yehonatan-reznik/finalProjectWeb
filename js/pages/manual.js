// Manual page script: enforces auth for the static operator reference page.
(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on manual page.');
  }
})();
