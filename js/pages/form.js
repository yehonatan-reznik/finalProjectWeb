// Request form page script: enforces auth for the static change-request page.
// Reading guide:
// 1. This file is intentionally small because the page is mostly static form markup.
// 2. Its only runtime job is to require authentication before showing the request form.
// Search guide:
// - Ctrl+F `requireAuth` for the page-protection call.
// Key terms:
// - request form: page used to report UI, detector, controller, or workflow issues.
// EXAM: protected request-form page guard.
(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on mission form page.');
  }
})();
