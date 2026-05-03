# JavaScript

This folder contains the browser-side JavaScript used by the web app.

- `auth.js` wraps Firebase authentication and protected-page redirects.
- `pages/` contains page-specific scripts for the dashboard, login page, manual page, logs page, and form page.

Shared cross-page helpers should stay here at the top level; page-only behavior should stay in `pages/`.
