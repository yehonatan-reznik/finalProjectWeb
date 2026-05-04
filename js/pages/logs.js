// Logs page script: protects the page and filters the static session timeline by search text and category.
// Reading guide:
// 1. The top enforces authentication.
// 2. The middle captures the search input, rows, and filter buttons.
// 3. The bottom applies text/category filtering and updates active button state.
// Search guide:
// - Ctrl+F `applyFilters` for the core text/category filtering logic.
// - Ctrl+F `activeFilter` for the currently selected category state.
// Key terms:
// - category filter: selected event group such as stream, detection, or controller.
// - text filter: substring search applied to the row text content.
// EXAM: authenticated log filtering page.
(function () {
  'use strict';

  if (window.SkyShieldAuth) {
    window.SkyShieldAuth.requireAuth();
  } else {
    console.error('SkyShieldAuth module missing on logs page.');
  }

  const searchInput = document.getElementById('logSearch');
  const rows = Array.from(document.querySelectorAll('#logTable tbody tr'));
  const filterButtons = Array.from(document.querySelectorAll('[data-log-filter]'));
  if (!searchInput || !rows.length) return;
  let activeFilter = 'all';

  // EXAM: text/category row filtering.
  const applyFilters = () => {
    const q = searchInput.value.trim().toLowerCase();
    rows.forEach((tr) => {
      const txt = tr.textContent.toLowerCase();
      const category = tr.dataset.category || 'all';
      const matchesText = txt.includes(q);
      const matchesFilter = activeFilter === 'all' || category === activeFilter;
      tr.style.display = matchesText && matchesFilter ? '' : 'none';
    });
  };

  searchInput.addEventListener('input', applyFilters);

  filterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.logFilter || 'all';
      filterButtons.forEach((candidate) => {
        const isActive = candidate === button;
        candidate.classList.toggle('active', isActive);
        candidate.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      applyFilters();
    });
  });

  applyFilters();
})();
