(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on logs page.');
  }

  const searchInput = document.getElementById('logSearch');
  const rows = Array.from(document.querySelectorAll('#logTable tbody tr'));
  if (!searchInput || !rows.length) return;

  searchInput.addEventListener('input', (event) => {
    const q = event.target.value.trim().toLowerCase();
    rows.forEach((tr) => {
      const txt = tr.textContent.toLowerCase();
      tr.style.display = txt.includes(q) ? '' : 'none';
    });
  });
})();
