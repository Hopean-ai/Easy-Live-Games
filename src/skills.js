// The skill tree. Players earn skill points during a match and spend them on upgrades that the
// simulation in game.js applies. Pure data and validation, so the room, the client and the
// tests all read the same tree.

// A point is earned each time you concede, so the player who is behind gets the upgrades first.
export const POINTS_PER_CONCEDE = 1;
export const STARTING_POINTS = 0;

// Three branches, three nodes each. A node needs the one before it in its branch.
export const SKILLS = [
  { id: 'reach1', branch: 'reach', cost: 1, requires: null, name: 'Long paddle', desc: 'Paddle 20% taller.' },
  { id: 'reach2', branch: 'reach', cost: 2, requires: 'reach1', name: 'Longer paddle', desc: 'Paddle 45% taller.' },
  { id: 'reach3', branch: 'reach', cost: 3, requires: 'reach2', name: 'Wall', desc: 'Paddle 75% taller.' },
  { id: 'speed1', branch: 'speed', cost: 1, requires: null, name: 'Quick feet', desc: 'Paddle moves 20% faster.' },
  { id: 'speed2', branch: 'speed', cost: 2, requires: 'speed1', name: 'Quicker feet', desc: 'Paddle moves 40% faster.' },
  { id: 'speed3', branch: 'speed', cost: 3, requires: 'speed2', name: 'Blink', desc: 'Paddle moves 65% faster.' },
  { id: 'spin1', branch: 'spin', cost: 1, requires: null, name: 'Spin', desc: 'Moving as you hit bends the ball.' },
  { id: 'spin2', branch: 'spin', cost: 2, requires: 'spin1', name: 'Power shot', desc: 'Your returns speed the ball up twice as much.' },
  { id: 'spin3', branch: 'spin', cost: 3, requires: 'spin2', name: 'Sharp angles', desc: 'Edge hits leave at up to 65°.' },
];

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export function skillById(id) {
  return BY_ID.get(id) ?? null;
}

export function createSkillState() {
  return { points: STARTING_POINTS, owned: [] };
}

// Why `id` can't be bought right now, or null if it can.
export function cannotBuy(state, id) {
  const skill = skillById(id);
  if (!skill) return 'unknown';
  if (state.owned.includes(id)) return 'owned';
  if (skill.requires && !state.owned.includes(skill.requires)) return 'locked';
  if (state.points < skill.cost) return 'points';
  return null;
}

// Spends points on `id`. Returns true if it was bought.
export function buySkill(state, id) {
  if (cannotBuy(state, id)) return false;
  state.points -= skillById(id).cost;
  state.owned.push(id);
  return true;
}

// The stat changes a set of owned skills adds up to. Nodes in a branch replace each other, so
// only the deepest one owned counts.
export function modifiers(owned) {
  const has = (id) => owned.includes(id);
  return {
    height: has('reach3') ? 1.75 : has('reach2') ? 1.45 : has('reach1') ? 1.2 : 1,
    speed: has('speed3') ? 1.65 : has('speed2') ? 1.4 : has('speed1') ? 1.2 : 1,
    spin: has('spin1'),
    speedupBoost: has('spin2') ? 2 : 1,
    maxAngle: has('spin3') ? (65 * Math.PI) / 180 : Math.PI / 4,
  };
}
