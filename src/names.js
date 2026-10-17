export const MAX_NAME_LENGTH = 16;

// Normalizes a player-supplied name: strips control characters, collapses whitespace, caps length.
// It does not HTML-escape; anything rendering a name must escape it (or use textContent).
export function sanitizeName(raw, fallback = 'Player') {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('') || fallback;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
