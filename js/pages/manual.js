// Manual page script: enforces auth for the static operator reference page.
// Reading guide:
// 1. This file is intentionally tiny because the page is mostly static HTML content.
// 2. Its only runtime job is to require authentication before showing the manual.
// Search guide:
// - Ctrl+F `requireAuth` for the page-protection call.
// Key terms:
// - protected page: a page that should only be visible to signed-in users.
// EXAM: protected manual page guard.
(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on manual page.');
  }
})();
