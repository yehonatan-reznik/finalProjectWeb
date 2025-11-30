// Centralized list of phone numbers allowed to access the SkyShield console.
// Update this list as needed; numbers can be in any format because the auth
// layer normalizes by stripping non-digit characters before comparison.
(function (window) {
  window.SkyShieldAllowedPhones = [
    '0584648044'
  ];
})(window);
