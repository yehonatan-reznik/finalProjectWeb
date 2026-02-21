(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on mission form page.');
  }
})();
