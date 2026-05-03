// Request form page script: enforces auth for the static change-request page.
(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on mission form page.');
  }
})();
