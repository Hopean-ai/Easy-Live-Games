import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, escapeHtml, MAX_NAME_LENGTH } from '../src/names.js';

test('trims, collapses whitespace and caps length', () => {
  assert.equal(sanitizeName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(sanitizeName('x'.repeat(50)).length, MAX_NAME_LENGTH);
});

test('falls back when empty or missing', () => {
  assert.equal(sanitizeName(''), 'Player');
  assert.equal(sanitizeName(null), 'Player');
  assert.equal(sanitizeName('​\u0007'), 'Player');
});

test('strips control and bidi-override characters', () => {
  assert.equal(sanitizeName('ev‮il\u0000'), 'evil');
});

test('does not split emoji when capping length', () => {
  const name = sanitizeName('😀'.repeat(20));
  assert.equal(Array.from(name).length, MAX_NAME_LENGTH);
  assert.ok(!name.includes('�'));
});

test('escapeHtml neutralises markup in names', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('hi')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;hi&#39;)&quot;&gt;&amp;',
  );
});
