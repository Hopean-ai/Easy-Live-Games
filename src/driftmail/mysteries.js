// The ocean's own bottles, the ones no player wrote: strange unsigned letters that seem to know
// you, letters dated days ahead that come true, clues that point at a hidden current, and your
// own old bottles come back not quite as you wrote them. Pure text-making; the Ocean object
// (ocean.js) decides when they wash up. Why any of it happens is never explained.

import { DIRECTIONS, EVENTS, clock } from './world.js';

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// A strange letter about you. `you` is your island's name, `line` something you wrote lately.
const KNOWING = [
  (you) => `${you}. We have been reading your letters. You write as if someone is listening. Someone is.`,
  (you, line) => (line ? `You wrote "${line}". We kept it. We keep all of them.` : 'You have not written yet. We are waiting.'),
  () => 'Do not trust the light to the south-west. It is not a lighthouse.',
  (you) => `The crate on your beach was packed for you, ${you}. Did you not wonder how it knew your size?`,
  (you, line) => (line ? `"${line}" — you will write that again, years from now, and you will not remember this.` : 'Write something. It matters more than you think.'),
  () => 'Count the stones on your north beach. Then count them again tomorrow.',
  () => 'The others are real. That is the only thing we are allowed to tell you.',
  (you) => `Someone is writing in your hand, ${you}. Not us.`,
];

export function knowingLetter(rand, you, line) {
  return pick(rand, KNOWING)(you, line ? excerptOf(line) : null);
}

// A letter from the future: it names an event that really is coming, dated by island day.
export function futureLetter(rand, event, dayNumber) {
  const e = EVENTS[event.kind];
  const lines = [
    `Island day ${dayNumber}. ${cap(e.name)} came today. Nobody believed me when I wrote that it would.`,
    `Day ${dayNumber}, writing in a hurry. ${cap(e.name)}. If you are reading this before it comes, you still have time.`,
    `It is day ${dayNumber} and ${e.name} is here, exactly as the old pages said. Tell the others.`,
  ];
  return pick(rand, lines);
}

export function islandDay(t, dayMs) {
  return Math.floor(t / dayMs);
}

// A clue to a hidden current: a direction, a part of the day and a tide. Throwing a bottle that
// way at that time, on that tide, before the clue goes stale, finds what the current hides.
export function clue(rand) {
  const dir = Math.floor(rand() * DIRECTIONS.length);
  const part = pick(rand, ['dawn', 'morning', 'midday', 'afternoon', 'dusk', 'night']);
  const ebbing = rand() < 0.5;
  return { dir, part, ebbing };
}

export function clueText({ dir, part, ebbing }) {
  // Only numbers and a shape: the bearing in degrees, the hour of the island day, and the tide drawn.
  const bearing = dir * 45;
  const hour = { dawn: 6, morning: 9, midday: 12, afternoon: 15, dusk: 18, night: 22 }[part];
  return `${String(bearing).padStart(3, '0')}°   ·   ${hour}:00   ·   ${ebbing ? '⌄ ⌄ ⌄' : '⌃ ⌃ ⌃'}`;
}

export function matchesClue(c, { dir, t }) {
  const now = clock(t);
  return c.dir === dir && c.part === now.part && c.ebbing === now.ebbing;
}

// An echo: your own words, come back with a few of them changed.
const SEA_WORDS = ['salt', 'tide', 'fog', 'lantern', 'glass', 'the sea', 'drowned', 'remembered', 'again', 'below'];

export function echo(rand, text) {
  const words = text.split(/(\s+)/);
  const candidates = words.map((w, i) => (w.trim().length >= 5 ? i : -1)).filter((i) => i >= 0);
  const changes = Math.max(1, Math.round(candidates.length * 0.12));
  for (let k = 0; k < changes && candidates.length; k++) {
    const i = candidates.splice(Math.floor(rand() * candidates.length), 1)[0];
    words[i] = pick(rand, SEA_WORDS);
  }
  return words.join('');
}

function excerptOf(text) {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 58).trimEnd()}…` : line;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
