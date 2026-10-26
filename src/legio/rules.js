// Legio: one soldier's career in the Roman army, from recruit in 235 AD to (perhaps) emperor.
// Everything here is pure: a run is a plain object, and `choose` applies one answer to the card
// in front of the player using the run's own seeded dice, so the server alone decides outcomes.
// Cards are the only way the game moves: each half-year starts with an orders card, and what the
// player orders (and the year's history) queues battles, vacancies and events behind it.

export const START_YEAR = 235;
const HALVES = ['Campaign season', 'Winter quarters'];
const LOG_LIMIT = 60;

// The ladder. `pay` is what a half-year leaves in your purse after the army's deductions, as a
// multiple of a legionary's. `points` is what reaching the rank adds to the score.
export const RANKS = [
  { id: 'tiro', name: 'Tiro', gloss: 'Recruit in training', pay: 1, points: 0 },
  { id: 'miles', name: 'Miles gregarius', gloss: 'Legionary', pay: 1, points: 10 },
  { id: 'immunis', name: 'Immunis', gloss: 'Specialist, excused fatigue duties', pay: 1, points: 25 },
  { id: 'tesserarius', name: 'Tesserarius', gloss: 'Watch officer, keeps the password', pay: 1.5, points: 45 },
  { id: 'signifer', name: 'Signifer', gloss: 'Standard-bearer and the century\'s banker', pay: 2, points: 70 },
  { id: 'optio', name: 'Optio', gloss: 'The centurion\'s deputy', pay: 2, points: 100 },
  { id: 'centurio', name: 'Centurio', gloss: 'Centurion, commands about 80 men', pay: 10, points: 160 },
  { id: 'primiordo', name: 'Centurio primi ordinis', gloss: 'Centurion of the first cohort', pay: 15, points: 230 },
  { id: 'primuspilus', name: 'Primus pilus', gloss: 'Chief centurion of the legion', pay: 30, points: 320 },
  { id: 'castrorum', name: 'Praefectus castrorum', gloss: 'Camp prefect, now a knight', pay: 40, points: 430 },
  { id: 'legionis', name: 'Praefectus legionis', gloss: 'Commander of a legion', pay: 60, points: 560 },
  { id: 'dux', name: 'Dux', gloss: 'General of a frontier', pay: 80, points: 720 },
  { id: 'imperator', name: 'Imperator', gloss: 'Emperor of Rome', pay: 0, points: 1500 },
];
const R = Object.fromEntries(RANKS.map((r, i) => [r.id, i]));
export const RANK = R;

// What each promotion board weighs (virtus, gratia, litterae), and the merit it wants.
const BOARDS = {
  immunis: { w: [0.2, 0.2, 0.6], need: 18 },
  tesserarius: { w: [0.2, 0.3, 0.5], need: 26 },
  signifer: { w: [0.4, 0.3, 0.3], need: 34 },
  optio: { w: [0.5, 0.3, 0.2], need: 42 },
  centurio: { w: [0.35, 0.45, 0.2], need: 50 },
  primiordo: { w: [0.4, 0.4, 0.2], need: 57 },
  primuspilus: { w: [0.4, 0.4, 0.2], need: 63 },
  castrorum: { w: [0.2, 0.5, 0.3], need: 67 },
  legionis: { w: [0.35, 0.45, 0.2], need: 60 },
  dux: { w: [0.4, 0.4, 0.2], need: 66 },
};
// Until Gallienus shut senators out of army commands (about 262), legions were led by senators.
const LEGATES_UNTIL = 262;

export const FRONTS = {
  rhine: 'the Rhine',
  danube: 'the Danube',
  east: 'the Persian frontier',
  africa: 'the African frontier',
  britannia: 'Hadrian\'s Wall',
  field: 'the emperor\'s field army',
  rome: 'Rome',
};

export const LEGIONS = [
  { id: 'xxii', name: 'Legio XXII Primigenia', base: 'Moguntiacum', front: 'rhine' },
  { id: 'viii', name: 'Legio VIII Augusta', base: 'Argentoratum', front: 'rhine' },
  { id: 'i-italica', name: 'Legio I Italica', base: 'Novae', front: 'danube' },
  { id: 'xiii', name: 'Legio XIII Gemina', base: 'Apulum', front: 'danube' },
  { id: 'iii-gallica', name: 'Legio III Gallica', base: 'Raphanea', front: 'east' },
  { id: 'xvi', name: 'Legio XVI Flavia Firma', base: 'Samosata', front: 'east' },
  { id: 'iii-augusta', name: 'Legio III Augusta', base: 'Lambaesis', front: 'africa' },
  { id: 'xx', name: 'Legio XX Valeria Victrix', base: 'Deva', front: 'britannia' },
  { id: 'ii-parthica', name: 'Legio II Parthica', base: 'Albanum', front: 'field' },
  { id: 'praetoriani', name: 'Cohortes praetoriae', base: 'Rome', front: 'rome', pay: 2 },
];
const legionById = (id) => LEGIONS.find((l) => l.id === id);

const ORIGINS = [
  { id: 'thracia', name: 'Thracia', text: 'Hill country on the lower Danube. Hard men, and the new emperor is one of them.', legion: 'i-italica', bonus: { virtus: 6 }, cognomina: ['Bithus', 'Mucapor', 'Dizzo', 'Tarsa'] },
  { id: 'pannonia', name: 'Pannonia', text: 'The middle Danube, where the army is the only way up.', legion: 'xiii', bonus: { virtus: 4, gratia: 2 }, cognomina: ['Bato', 'Dasius', 'Scenus', 'Liccaius'] },
  { id: 'syria', name: 'Syria', text: 'Old cities and caravan money, facing Persia.', legion: 'iii-gallica', bonus: { denarii: 60, litterae: 3 }, cognomina: ['Barsemis', 'Iamlichus', 'Malchus', 'Zabdas'] },
  { id: 'gallia', name: 'Gallia', text: 'Rich farmland behind the Rhine frontier.', legion: 'viii', bonus: { health: 0, gratia: 3, denarii: 30 }, cognomina: ['Senecio', 'Vindex', 'Tetricus', 'Carantus'] },
  { id: 'africa', name: 'Africa', text: 'Wheat, olives and schools. A quiet frontier, for now.', legion: 'iii-augusta', bonus: { litterae: 8 }, cognomina: ['Saturninus', 'Felix', 'Donatus', 'Honoratus'] },
  { id: 'italia', name: 'Italia', text: 'The old heartland. Few Italians join the legions any more, but the emperor\'s own legion camps near Rome.', legion: 'ii-parthica', bonus: { gratia: 6 }, cognomina: ['Rufus', 'Maximus', 'Severus', 'Crispus'] },
];
const PRAENOMINA = ['Marcus', 'Gaius', 'Lucius', 'Titus', 'Publius', 'Quintus', 'Sextus'];
const NOMINA = ['Aurelius', 'Aurelius', 'Aurelius', 'Iulius', 'Flavius', 'Valerius', 'Septimius'];
const RIVALS = ['Aurelius Victor', 'Iulius Pudens', 'Flavius Celer', 'Valerius Firmus', 'Septimius Bassus', 'Aurelius Dizo', 'Claudius Fronto', 'Ulpius Marcellus', 'Aelius Mucianus', 'Cassius Licinus'];

const BACKGROUNDS = [
  { id: 'farm', name: 'A farmer\'s son', text: 'Strong back, no letters.', stats: { virtus: 8, gratia: 2, litterae: 2 }, denarii: 20 },
  { id: 'scribe', name: 'A scribe\'s son', text: 'You can read and write, which most recruits cannot.', stats: { virtus: 2, gratia: 2, litterae: 20 }, denarii: 40 },
  { id: 'veteran', name: 'A veteran\'s son', text: 'Your father served 25 years and still knows a centurion or two.', stats: { virtus: 5, gratia: 12, litterae: 5 }, denarii: 50 },
];

// Who holds the purple, by year (until the player takes it).
export const REIGNS = [
  { from: 235, name: 'Maximinus Thrax', note: 'a Thracian giant who rose from the ranks, hailed by the troops who murdered Severus Alexander' },
  { from: 238, name: 'Gordian III', note: 'a boy of thirteen, after a year of six emperors' },
  { from: 244, name: 'Philip the Arab', note: 'the Praetorian prefect, whispered to have arranged Gordian\'s death' },
  { from: 249, name: 'Decius', note: 'the general the Danube legions forced to take the purple' },
  { from: 251, name: 'Trebonianus Gallus', note: 'after Decius and his son fell in the swamps at Abritus' },
  { from: 253, name: 'Valerian', note: 'an old senator, who makes his son Gallienus co-emperor' },
  { from: 260, name: 'Gallienus', note: 'ruling alone now, his father a prisoner of the Persian king' },
  { from: 268, name: 'Claudius Gothicus', note: 'a Danubian officer, after Gallienus is murdered by his own staff' },
  { from: 270, name: 'Aurelian', note: 'a Danubian cavalry general who rose from the ranks, after plague takes Claudius' },
  { from: 275, name: 'Tacitus', note: 'an old man chosen after Aurelian is murdered on the road to Persia' },
  { from: 276, name: 'Probus', note: 'another Danubian soldier' },
  { from: 282, name: 'Carus', note: 'the Praetorian prefect, hailed after Probus is killed by his own men' },
  { from: 283, name: 'Carinus and Numerian', note: 'the sons of Carus, who died on campaign in Persia' },
  { from: 284, name: 'Diocletian', note: 'a Dalmatian of humble birth who will end fifty years of chaos' },
];
export function emperorIn(year) {
  return REIGNS.findLast((r) => r.from <= year) ?? REIGNS[0];
}

// Campaign years on each front, from the history of the crisis. After 284 the dice decide.
const WARS = {
  rhine: [235, 236, 259, 260, 268, 270, 271, 274, 277, 278],
  danube: [236, 237, 238, 245, 246, 247, 248, 249, 250, 251, 253, 267, 268, 269, 270, 271],
  east: [241, 242, 243, 244, 252, 253, 256, 259, 260, 272, 273, 282, 283],
  africa: [238],
  britannia: [],
  rome: [],
};
const BATTLES = [
  { year: 244, front: 'east', name: 'Misiche', won: false, note: 'The Persians break the army and Gordian III dies on the campaign.' },
  { year: 251, front: 'danube', name: 'Abritus', won: false, note: 'The Goths draw the army into a swamp. The emperor Decius is lost with his son.' },
  { year: 259, front: 'rhine', name: 'Mediolanum', won: true, note: 'Gallienus\'s new cavalry catches the Alamanni raiding Italy.' },
  { year: 260, front: 'east', name: 'Edessa', won: false, note: 'Shapur\'s army surrounds the Romans and takes the emperor Valerian alive.' },
  { year: 268, front: 'rhine', name: 'Lake Benacus', won: true, note: 'Claudius smashes the Alamanni at the lake.' },
  { year: 269, front: 'danube', name: 'Naissus', won: true, note: 'The greatest Gothic host in memory is destroyed.' },
  { year: 272, front: 'east', name: 'Emesa', won: true, note: 'Aurelian breaks Queen Zenobia\'s armoured cavalry.' },
  { year: 274, front: 'rhine', name: 'Châlons', won: true, note: 'Aurelian takes the breakaway Gallic Empire back.' },
  { year: 283, front: 'east', name: 'Ctesiphon', won: true, note: 'Carus marches down the Tigris and takes the Persian capital.' },
];
const PLAGUE_YEARS = new Set([250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 270]);

export const DECORATIONS = {
  torques: 'Torques (gold neck-ring)',
  armillae: 'Armillae (gold armbands)',
  phalerae: 'Phalerae (silver discs for the breastplate)',
  muralis: 'Corona muralis (first over the wall)',
  vallaris: 'Corona vallaris (first into the enemy camp)',
  aurea: 'Corona aurea (gold crown for single combat)',
  hasta: 'Hasta pura (silver spear for a commander)',
};

// --- dice and small helpers ------------------------------------------------------------------

// mulberry32 over the run's own state, so a run's luck is fixed by the server's seed.
function dice(s) {
  return () => {
    let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pct = (p) => `${Math.round(p * 100)}%`;
const legion = (s) => legionById(s.legion);
const front = (s) => legion(s).front;
const officer = (s) => s.rank >= R.centurio;
// "on the Rhine", or where the emperor's own legion is when it fights.
const onFront = (s) => (front(s) === 'field' ? 'on campaign with the emperor' : `on ${FRONTS[front(s)]}`);
const pay = (s) => Math.round(30 * RANKS[s.rank].pay * (legion(s).pay ?? 1));

// Gains slow down as a stat climbs; losses don't.
function gain(s, key, n) {
  const before = s.stats[key];
  const step = n > 0 ? n * (1 - before / 125) : n;
  s.stats[key] = clamp(Math.round((before + step) * 10) / 10, 0, 100);
}
function cash(s, n) {
  s.denarii = Math.max(0, Math.round(s.denarii + n));
}
function heal(s, n) {
  s.health = clamp(s.health + n, 0, 100);
}
function log(s, text) {
  s.log.push({ year: s.year, half: s.half, text });
  if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
  return text;
}
function story(s, text) {
  s.story.push(`${s.year} AD: ${text}`);
}
function die(s, fate) {
  s.over = true;
  s.fate = `${fate}, ${s.year} AD`;
  s.queue = [];
  story(s, fate);
  return fate;
}
function hurt(s, n, fate) {
  s.health = clamp(s.health - n, 0, 100);
  if (s.health <= 0) die(s, fate);
}
function promote(s, to) {
  s.rank = to;
  s.best = Math.max(s.best, to);
  s.inRank = 0;
  story(s, `Became ${RANKS[to].name}`);
}
function decorate(s, key) {
  s.decorations.push(key);
  story(s, `Awarded the ${DECORATIONS[key]}`);
  return DECORATIONS[key];
}
const push = (s, id, args = {}) => s.queue.push({ id, args });
const next = (s, id, args = {}) => s.queue.splice(1, 0, { id, args });

// Is the legion's front at war this year? History until 284, then the dice.
function atWar(year, f, r) {
  if (f === 'rome') return false;
  if (f === 'field') return Object.entries(WARS).some(([k, ys]) => k !== 'africa' && ys.includes(year)) || (year > 284 && r() < 0.5);
  if (year > 284) return f !== 'britannia' ? r() < 0.35 : r() < 0.15;
  return WARS[f].includes(year);
}

// --- a new run -------------------------------------------------------------------------------

export function newRun(seed) {
  const s = {
    v: 1, seed: seed | 0, turn: 0, name: '', origin: null, background: null, legion: 'i-italica',
    year: START_YEAR, half: 0, age: 18, served: 0, rank: 0, best: 0, inRank: 0,
    stats: { virtus: 5, gratia: 5, litterae: 5, milites: 0 }, health: 100, denarii: 0, debt: 0,
    decorations: [], log: [], story: [], seen: [], queue: [], war: true, plot: 0, reign: 0,
    married: false, pietas: 0, works: 0, over: false, fate: null, ending: null,
  };
  push(s, 'origin');
  return s;
}

// --- the cards -------------------------------------------------------------------------------
// Each card: title(s, a), text(s, a), choices(s, a) → [{ label, hint?, off?, act(s, r, a) → log line }].

const CARDS = {};

CARDS.origin = {
  title: () => 'Where were you born?',
  text: () => 'Spring, 235 AD. You are eighteen and a Roman citizen, like every free man in the empire since Caracalla. The recruiting officer wants to know where you are from.',
  choices: () => ORIGINS.map((o) => ({
    label: o.name,
    hint: o.text,
    act(s, r) {
      s.origin = o.id;
      s.legion = o.legion;
      s.name = `${pick(r, PRAENOMINA)} ${pick(r, NOMINA)} ${pick(r, o.cognomina)}`;
      for (const [k, v] of Object.entries(o.bonus)) {
        if (k === 'denarii') cash(s, v);
        else if (k in s.stats) s.stats[k] += v;
      }
      push(s, 'background');
      return log(s, `You are ${s.name}, of ${o.name}.`);
    },
  })),
};

CARDS.background = {
  title: () => 'Your family',
  text: (s) => `You are ${s.name}. Who raised you?`,
  choices: () => BACKGROUNDS.map((b) => ({
    label: b.name,
    hint: b.text,
    act(s) {
      s.background = b.id;
      for (const [k, v] of Object.entries(b.stats)) s.stats[k] += v;
      cash(s, b.denarii);
      push(s, 'enlist');
      return log(s, `${b.name}, you take the oath (sacramentum) and are posted to ${legion(s).name} at ${legion(s).base}.`);
    },
  })),
};

CARDS.enlist = {
  title: () => 'The oath',
  text: (s) => `Severus Alexander is dead, cut down with his mother by his own soldiers at Moguntiacum. The army has hailed Maximinus, ${REIGNS[0].note.split(',')[0]}. Nobody has climbed from the ranks to the purple before. You swear to serve him for 25 years, and you start four months of drill as a tiro at ${legion(s).base}, on ${FRONTS[front(s)]}.`,
  choices: () => [{
    label: 'Begin training',
    act(s, r) {
      startYear(s, r);
      return log(s, 'Training begins: marching, swimming, the wooden sword and the heavy shield.');
    },
  }],
};

// The half-year's orders. What you choose here shapes what comes after it.
CARDS.orders = {
  title: (s) => `${HALVES[s.half]}, ${s.year} AD`,
  text(s) {
    if (s.rank === R.imperator) return `You rule the Roman world from the camp, as your predecessors did. ${s.war ? 'War is on the frontiers.' : 'The frontiers are quiet for now.'} Every emperor of your time has died by the sword. How do you spend these months?`;
    const where = `${legion(s).name}, ${legion(s).base}.`;
    const war = s.half === 0
      ? (s.war ? ` The legion is at war ${onFront(s)} this year.` : ' The frontier is quiet this year.')
      : ' The legion is in winter quarters.';
    return `${where}${war} What do you do with these months?`;
  },
  choices(s) {
    if (s.rank === R.imperator) return emperorOrders(s);
    const list = [];
    const campaign = s.half === 0 && s.war;
    list.push({ label: 'Drill hard', hint: 'virtus +', act(s2) { gain(s2, 'virtus', 4); return log(s2, 'You drill until your arms ache.'); } });
    if (campaign && s.rank >= R.miles && s.rank < R.castrorum) {
      list.push({
        label: officer(s) ? 'Lead raids across the frontier' : 'Volunteer for scouting and raids',
        hint: 'virtus ++, real danger',
        act(s2, r) {
          gain(s2, 'virtus', 9);
          const roll = r();
          if (roll < 0.035) return die(s2, 'Killed on a raid beyond the frontier');
          if (roll < 0.25) {
            hurt(s2, 15 + Math.floor(r() * 20), 'Died of wounds from a raid');
            if (s2.over) return s2.fate;
            return log(s2, 'You come back from a raid with a spear wound and a reputation.');
          }
          if (roll > 0.88) return log(s2, `Your raid captures an enemy chief. You are awarded the ${decorate(s2, officer(s2) ? 'phalerae' : 'armillae')}.`);
          if (officer(s2)) gain(s2, 'milites', 3);
          return log(s2, 'You lead the way on raids and come back each time.');
        },
      });
    }
    const lessons = officer(s) ? 40 : 15;
    list.push({
      label: officer(s) ? 'Read law and history with a tutor' : 'Study letters with the clerk',
      hint: `litterae +, ${lessons} denarii`,
      act(s2) {
        if (s2.denarii >= lessons) {
          cash(s2, -lessons);
          gain(s2, 'litterae', 5);
          return log(s2, officer(s2) ? 'You work through Frontinus on stratagems with a Greek tutor.' : 'You learn to read and keep accounts on wax tablets.');
        }
        gain(s2, 'litterae', 2);
        return log(s2, 'With no money for a teacher, you puzzle out letters on your own.');
      },
    });
    const gifts = s.rank >= R.castrorum ? 120 : officer(s) ? 60 : 20;
    list.push({
      label: s.rank >= R.castrorum ? 'Court the governor and the emperor\'s friends' : officer(s) ? 'Dine with the tribunes and the legate' : 'Wait on the officers',
      hint: `gratia +, ${gifts} denarii`,
      act(s2) {
        if (s2.denarii >= gifts) {
          cash(s2, -gifts);
          gain(s2, 'gratia', 5);
          return log(s2, 'Small gifts, the right greetings, and you are remembered.');
        }
        gain(s2, 'gratia', 1);
        return log(s2, 'Without gifts to bring, you are mostly ignored.');
      },
    });
    list.push({
      label: officer(s) ? 'Manage your affairs' : 'Take side work in the camp town',
      hint: 'denarii +',
      act(s2) {
        const got = Math.round(35 * Math.max(1, RANKS[s2.rank].pay / 2));
        cash(s2, got);
        return log(s2, `You bring in ${got} denarii.`);
      },
    });
    if (s.health < 100) list.push({ label: 'Rest and heal', hint: 'health +', act(s2) { heal(s2, 25); return log(s2, 'You rest and let the medicus see to you.'); } });
    if (officer(s)) {
      const feast = 30 + s.rank * 10;
      list.push({
        label: 'Spend on your men',
        hint: `milites +, ${feast} denarii`,
        off: s.denarii < feast,
        act(s2) { cash(s2, -feast); gain(s2, 'milites', 6); return log(s2, 'Extra wine, better boots, a feast on the emperor\'s birthday. The men notice.'); },
      });
      list.push({
        label: 'Sell leave and exemptions to your men',
        hint: 'denarii ++, milites −',
        act(s2) {
          const got = Math.round(50 * RANKS[s2.rank].pay / 5);
          cash(s2, got);
          gain(s2, 'milites', -6);
          return log(s2, `The men pay ${got} denarii to be excused duties, and hate you a little for it.`);
        },
      });
    }
    if (s.inRank >= 2 && s.rank >= R.miles) {
      list.push({ label: 'Seek a transfer to another legion', hint: 'new posting, gratia −', act(s2) { next(s2, 'transfer'); return log(s2, 'You ask about postings elsewhere.'); } });
    }
    if (s.rank >= R.legionis && s.half === 1 && s.stats.milites >= 40) {
      list.push({
        label: 'Sound out the officers about the purple',
        hint: 'treason: may make you emperor, or kill you',
        act(s2, r) {
          s2.plot++;
          if (r() < clamp(0.14 - s2.stats.gratia / 900, 0.04, 0.14)) return die(s2, 'Executed for plotting against the emperor');
          gain(s2, 'milites', 4);
          return log(s2, 'Quiet talks by lamplight. Some of the officers would follow you.');
        },
      });
    }
    return list;
  },
  // Orders are followed by whatever the half-year brings.
  after(s, r) {
    if (s.over) return;
    if (s.rank === R.imperator) {
      if (s.half === 0 && s.war && r() < 0.5) push(s, 'battle');
      if (r() < 0.45) push(s, 'event');
      return;
    }
    let casualties = 0;
    if (s.half === 0 && s.war && (r() < 0.75 || namedBattle(s))) {
      push(s, 'battle');
      casualties = 0.15;
    }
    if (PLAGUE_YEARS.has(s.year) && r() < 0.1) push(s, 'plague');
    if (s.rank === R.tiro) {
      push(s, 'sworn');
    } else if (s.rank < R.dux && s.inRank >= minHalves(s)) {
      // Fewer posts the higher you go: a legion has 59 centurions but one camp prefect.
      const base = s.rank >= R.centurio ? 0.12 : 0.22;
      const p = s.rank === R.primuspilus ? 1 : base + casualties + (PLAGUE_YEARS.has(s.year) ? 0.06 : 0);
      if (r() < p) push(s, 'board', { rival: pick(r, RIVALS), cause: casualties ? 'battle' : pick(r, ['death', 'retire', 'transfer']) });
    }
    if (s.rank >= R.legionis && s.stats.milites >= 55) {
      const transition = REIGNS.some((x) => x.from === s.year) ? 0.1 : 0;
      const p = 0.03 + s.plot * 0.06 + transition + (s.stats.milites - 55) / 400 + (s.year > 284 ? -0.02 : 0);
      if (r() < p) push(s, 'acclaim');
    }
    if (r() < 0.5) push(s, 'event');
    // `served` counts the halves before this one, so the winter that completes 25 years has 49.
    if (s.served >= 49 && (s.served - 49) % 10 === 0 && s.half === 1) push(s, 'discharge');
  },
};

function emperorOrders(s) {
  return [
    {
      label: 'Campaign at the head of the army',
      hint: 'virtus +, glory, danger',
      act(s2, r) {
        if (r() < 0.04) return die(s2, `Fell on campaign after ${reignWords(s2)} as emperor`);
        gain(s2, 'virtus', 6);
        gain(s2, 'milites', 4);
        s2.works++;
        return log(s2, 'You win a victory and take a new title for it.');
      },
    },
    {
      label: 'Pay a donative to the troops',
      hint: 'milites ++, 1500 denarii',
      off: s.denarii < 1500,
      act(s2) { cash(s2, -1500); gain(s2, 'milites', 12); return log(s2, 'Gold for every soldier. They cheer your name.'); },
    },
    {
      label: 'Win over the Senate and the court',
      hint: 'gratia +',
      act(s2) { gain(s2, 'gratia', 7); return log(s2, 'Letters to the Senate, honours for the right families.'); },
    },
    {
      label: 'Rebuild: walls, roads and honest coin',
      hint: 'lasting fame',
      act(s2) { s2.works += 2; return log(s2, 'New walls rise around cities that had none.'); },
    },
    {
      label: 'Abdicate and retire to grow cabbages',
      hint: 'ends the run safely',
      off: s.reign < 8,
      act(s2) {
        s2.ending = 'abdicated';
        story(s2, 'Laid down the purple');
        s2.over = true;
        s2.fate = `Abdicated after ${reignWords(s2)} as emperor, ${s2.year} AD`;
        s2.queue = [];
        return log(s2, 'You lay down the purple and go home, as almost no one ever has.');
      },
    },
  ];
}
const reignWords = (s) => {
  const years = Math.floor(s.reign / 2);
  return years >= 1 ? `${years} year${years === 1 ? '' : 's'}` : 'a few months';
};

CARDS.sworn = {
  title: () => 'Training ends',
  text: () => 'Your training is over. The centurion signs you into the century\'s rolls as a full legionary.',
  choices: () => [{
    label: 'Take your place in the century',
    act(s) { promote(s, R.miles); return log(s, 'You are a miles gregarius now: a common soldier of Rome.'); },
  }],
};

CARDS.transfer = {
  title: () => 'A transfer',
  text: () => 'A friend in the governor\'s office can move you. Where to?',
  choices: (s) => [
    ...LEGIONS.filter((l) => l.id !== s.legion && l.id !== 'praetoriani' && !(l.id === 'iii-augusta' && s.year >= 238 && s.year < 253)).map((l) => ({
      label: `${l.name}, ${l.base}`,
      hint: FRONTS[l.front],
      act(s2) {
        s2.legion = l.id;
        gain(s2, 'gratia', -6);
        gain(s2, 'milites', -10);
        s2.war = atWar(s2.year, l.front, () => 0.5);
        story(s2, `Transferred to ${l.name}`);
        return log(s2, `You move to ${l.name} at ${l.base}. New officers, new rivals.`);
      },
    })),
    { label: 'Stay where you are', act(s2) { return log(s2, 'You decide to stay.'); } },
  ],
};

// A vacancy in the rank above you.
CARDS.board = {
  title: (s) => `A vacancy: ${RANKS[s.rank + 1].name}`,
  text(s, a) {
    const to = RANKS[s.rank + 1];
    const why = { battle: 'The fighting has left a gap in the ranks above you.', death: 'Fever has taken an officer.', retire: 'An officer has served his time and gone home.', transfer: 'An officer has been moved to another legion.' }[a.cause];
    const primi = s.rank === R.primuspilus ? 'Your year as primus pilus is over, and the emperor has made you a knight (eques). Now you need a post worthy of it. ' : why + ' ';
    const legate = s.rank + 1 === R.legionis && s.year < LEGATES_UNTIL ? ' Senators still command most legions, so few knights get this far.' : '';
    return `${primi}The post of ${to.name} (${to.gloss}) is open. ${a.rival} wants it too.${legate}`;
  },
  choices(s) {
    const to = s.rank + 1;
    const cost = bribeCost(s);
    return [
      { label: 'Stand on your record', hint: pct(promotionChance(s, to, 0)), act: (s2, r, a) => board(s2, r, a, 0) },
      {
        label: 'Ask your patron to write for you',
        hint: `${pct(promotionChance(s, to, 7))}, costs gratia`,
        off: s.stats.gratia < 15,
        act(s2, r, a) { gain(s2, 'gratia', -10); return board(s2, r, a, 7); },
      },
      {
        label: `Pay ${cost} denarii to the right people`,
        hint: `${pct(promotionChance(s, to, 9))}, could backfire`,
        off: s.denarii < cost,
        act(s2, r, a) {
          cash(s2, -cost);
          if (r() < 0.2) {
            gain(s2, 'gratia', -12);
            return log(s2, `Your bribe is talked about. ${a.rival} gets the post, and you get a reputation.`);
          }
          return board(s2, r, a, 9);
        },
      },
      { label: 'Let it go', act(s2, r, a) { gain(s2, 'gratia', 1); return log(s2, `You step aside for ${a.rival}.`); } },
    ];
  },
};
// How long you must hold a rank before you're considered for the next.
function minHalves(s) {
  return s.rank >= R.centurio ? 4 : 2;
}
function bribeCost(s) {
  return Math.round(60 * RANKS[s.rank + 1].pay);
}
export function promotionChance(s, to, bonus) {
  const b = BOARDS[RANKS[to].id];
  const merit = b.w[0] * s.stats.virtus + b.w[1] * s.stats.gratia + b.w[2] * s.stats.litterae;
  const need = b.need + (to === R.legionis && s.year < LEGATES_UNTIL ? 10 : 0);
  return clamp(0.5 + (merit + bonus - need) / 20, 0.02, 0.85);
}
function board(s, r, a, bonus) {
  const to = s.rank + 1;
  if (r() < promotionChance(s, to, bonus)) {
    promote(s, to);
    // Knighthood brings money and the notice of the emperor's circle.
    if (to === R.castrorum) { cash(s, 1500); gain(s, 'gratia', 8); }
    return log(s, `You are made ${RANKS[to].name}.`);
  }
  gain(s, 'gratia', 1);
  return log(s, `The post goes to ${a.rival}.`);
}

function namedBattle(s) {
  if (s.half !== 0) return null;
  const f = front(s);
  return BATTLES.find((b) => b.year === s.year && (b.front === f || f === 'field')) ?? null;
}

CARDS.battle = {
  title(s) {
    const named = namedBattle(s);
    return named ? `The battle of ${named.name}` : `Battle ${onFront(s)}`;
  },
  text(s, a) {
    const named = namedBattle(s);
    if (s.rank === R.imperator) return 'Your army meets the enemy, and you are at its head.';
    if (named) return `The armies meet at ${named.name}. Where are you when the lines close?`;
    const kind = { field: 'The enemy has come out to fight in the open.', siege: 'The army storms a walled town held by the enemy.', camp: 'You attack the enemy\'s fortified camp at dawn.' }[a.kind ?? 'field'];
    return `${kind} Where are you when it starts?`;
  },
  choices(s) {
    const senior = s.rank >= R.castrorum;
    const labels = senior
      ? ['Lead the charge yourself', 'Command from the rear', 'Stay with the baggage']
      : officer(s)
        ? ['Lead your men from the front', 'Hold your century together', 'Stay behind the line']
        : ['Push into the front rank', 'Hold your place in the line', 'Hang back'];
    const hints = ['great glory, great danger', 'steady', 'safe, and people notice'];
    return labels.map((label, i) => ({ label, hint: hints[i], act: (s2, r, a) => battle(s2, r, a, i) }));
  },
};
// Before the card is shown, the battle's kind is fixed so the text doesn't change on reload.
CARDS.battle.prepare = (s, r, a) => {
  a.kind = pick(r, ['field', 'field', 'siege', 'camp']);
};
function battle(s, r, a, stance) {
  const named = namedBattle(s);
  const won = named ? named.won : r() < 0.62;
  const worse = won ? 1 : 2.2;
  const rankRisk = s.rank >= R.castrorum ? 0.5 : officer(s) ? 1.3 : 1;
  const death = [0.07, 0.03, 0.012][stance] * worse * rankRisk;
  const wound = [0.3, 0.15, 0.06][stance] * worse;
  const roll = r();
  const where = named ? `at ${named.name}` : onFront(s);
  if (roll < death) return die(s, s.rank === R.imperator ? `Fell in battle after ${reignWords(s)} as emperor` : `Fell in battle ${where}`);
  const outcome = named?.note ?? (won ? 'The enemy breaks and runs.' : 'The line gives way and the army falls back with heavy losses.');
  const lines = [outcome];
  if (roll < death + wound) {
    hurt(s, 15 + Math.floor(r() * 30), `Died of wounds from a battle ${where}`);
    if (s.over) return log(s, `${outcome} You are carried off the field and do not recover.`);
    lines.push('You are wounded.');
  }
  gain(s, 'virtus', [[10, 4, 0], [6, 2, 0]][won ? 0 : 1][stance]);
  // Hanging back is noticed, by the officers and by the men.
  if (stance === 2) gain(s, 'gratia', -3);
  if (officer(s)) {
    if (stance === 0) gain(s, 'milites', 5);
    if (stance === 2) gain(s, 'milites', -5);
  }
  if (stance === 0 && won && r() < 0.25) {
    const kind = a.kind ?? 'field';
    const key = s.rank >= R.castrorum ? 'hasta'
      : kind === 'siege' ? 'muralis'
        : kind === 'camp' ? 'vallaris'
          : officer(s) ? pick(r, ['aurea', 'phalerae']) : pick(r, ['torques', 'armillae', 'phalerae']);
    lines.push(`You are awarded the ${decorate(s, key)}.`);
  }
  if (won) cash(s, Math.round(25 * Math.max(1, RANKS[s.rank].pay / 3)));
  if (!s.over && named) story(s, `Fought at ${named.name}`);
  return log(s, lines.join(' '));
}

CARDS.plague = {
  title: () => 'Plague',
  text: () => 'The plague that came out of Egypt is in the camp. Men sicken and die within days, and the bodies are burned outside the walls.',
  choices: () => [
    {
      label: 'Nurse your comrades',
      hint: 'milites +, danger',
      act(s, r) {
        if (r() < 0.08) return die(s, 'Died of plague');
        gain(s, 'milites', 6);
        gain(s, 'gratia', 2);
        return log(s, 'You carry water to the sick. Some live, and they remember.');
      },
    },
    {
      label: 'Keep apart and pray',
      hint: 'safer',
      act(s, r) {
        if (r() < 0.03) return die(s, 'Died of plague');
        return log(s, 'You keep to yourself until it passes.');
      },
    },
  ],
};

CARDS.acclaim = {
  title: () => 'The purple',
  text: (s) => `The men raise you on a shield and hail you Imperator. ${emperorIn(s.year).name} still holds Rome, and armies will march against you. Refusing a hailing army is dangerous too.`,
  choices: (s) => [
    {
      label: 'Accept the purple',
      hint: pct(usurpChance(s)),
      act(s2, r) {
        if (r() < usurpChance(s2)) {
          promote(s2, R.imperator);
          s2.reign = 0;
          cash(s2, 3000);
          return log(s2, 'The rival emperor is murdered by his own guard. The Senate sends its congratulations. You are emperor of Rome.');
        }
        return die(s2, 'Killed when the bid for the purple failed');
      },
    },
    {
      label: 'Refuse, and send the cloak back',
      hint: 'loyal, but the men may not forgive you',
      act(s2, r) {
        if (r() < 0.15) return die(s2, 'Killed by his own soldiers for refusing the purple');
        gain(s2, 'milites', -15);
        gain(s2, 'gratia', 8);
        s2.plot = 0;
        return log(s2, 'You refuse. The emperor hears of it and is grateful, for now.');
      },
    },
  ],
};
export function usurpChance(s) {
  return clamp(0.14 + (s.stats.milites - 55) / 100 + (s.stats.virtus - 55) / 400 + (s.rank >= R.dux ? 0.1 : 0) + s.plot * 0.04, 0.04, 0.6);
}

CARDS.accession = {
  title: (s) => `A new emperor: ${emperorIn(s.year).name}`,
  text(s, a) {
    const r = emperorIn(s.year);
    const side = a.loser ? ' Your legion swore for the losing side, and the winners are making lists.' : '';
    return `News reaches ${legion(s).base}: ${r.name} holds the purple, ${r.note}.${side}`;
  },
  choices(s, a) {
    if (!a.loser) {
      const list = [{
        label: 'Swear the oath and take the donative',
        act(s2) {
          const got = Math.round(40 * Math.max(1, RANKS[s2.rank].pay / 2));
          cash(s2, got);
          return log(s2, `You swear to ${emperorIn(s2.year).name} and pocket ${got} denarii.`);
        },
      }];
      if (s.rank >= R.legionis && s.stats.milites >= 55) {
        list.push({ label: 'Let your men hail you instead', hint: 'treason', act(s2) { next(s2, 'acclaim'); return log(s2, 'You let it be known you would not refuse.'); } });
      }
      return list;
    }
    const purge = s.rank >= R.primuspilus ? 0.25 : officer(s) ? 0.12 : 0;
    return [
      {
        label: 'Go over to the winner before it ends',
        hint: 'gratia +, if you are not caught',
        act(s2, r) {
          if (r() < 0.15) {
            if (officer(s2)) return die(s2, 'Executed as a turncoat in the civil war');
            hurt(s2, 25, 'Died after a flogging for desertion');
            return s2.over ? s2.fate : log(s2, 'You are caught slipping away and flogged.');
          }
          gain(s2, 'gratia', 7);
          return log(s2, 'You reach the winning side in time and are welcomed.');
        },
      },
      {
        label: 'Stand by your oath',
        hint: purge ? `virtus +, ${pct(purge)} chance of the purge` : 'virtus +',
        act(s2, r) {
          gain(s2, 'virtus', 5);
          gain(s2, 'gratia', -10);
          if (r() < purge) return die(s2, 'Executed in the purge after the civil war');
          return log(s2, 'You keep your oath until it no longer matters. The new regime notes your name.');
        },
      },
      {
        label: 'Keep your head down',
        act(s2) { gain(s2, 'gratia', -5); return log(s2, 'You say nothing and swear to the new emperor with everyone else.'); },
      },
    ];
  },
};

CARDS.history = {
  title: (s, a) => HISTORY[a.key].title,
  text: (s, a) => HISTORY[a.key].text(s),
  choices: (s, a) => HISTORY[a.key].choices(s),
};
const HISTORY = {
  disband: {
    title: 'Your legion is struck off',
    text: () => 'Last year Legio III Augusta marched on Carthage and crushed the Gordians\' revolt. Now Gordian III rules, and he has dissolved the legion and erased its name from its monuments. Its men are scattered to other legions.',
    choices: () => LEGIONS.filter((l) => !['iii-augusta', 'praetoriani'].includes(l.id)).slice(0, 5).map((l) => ({
      label: `Go to ${l.name}`,
      hint: FRONTS[l.front],
      act(s) {
        s.legion = l.id;
        gain(s, 'gratia', -10);
        s.war = atWar(s.year, l.front, () => 0.5);
        story(s, `Transferred to ${l.name} when III Augusta was dissolved`);
        return log(s, `You march to ${l.base} with what is left of your century.`);
      },
    })),
  },
  plague: {
    title: 'A plague from the east',
    text: () => 'Travellers bring word of a sickness out of Ethiopia and Egypt. It kills in days, city by city, and it will burn for years.',
    choices: () => [{ label: 'Make an offering to Apollo the Healer', act(s) { return log(s, 'You burn incense for Apollo and hope.'); } }],
  },
  gallic: {
    title: 'The Gallic Empire',
    text: () => 'With Valerian a prisoner in Persia, the Rhine army has hailed its own general, Postumus, emperor of Gaul, Spain and Britain. Gallienus cannot touch him.',
    choices: () => [
      { label: 'Serve Postumus', hint: 'gratia +', act(s) { s.gallic = true; gain(s, 'gratia', 4); return log(s, 'You swear to Postumus. Gaul has its own emperor now.'); } },
      { label: 'Stay loyal to Gallienus and ask for a transfer', act(s) { next(s, 'transfer'); return log(s, 'You look for a way out of Gaul.'); } },
    ],
  },
  reconquest: {
    title: 'The west comes back',
    text: () => 'Aurelian has crushed the Gallic Empire at Châlons. Officers who served Postumus and his heirs are being watched.',
    choices: () => [{ label: 'Swear to Aurelian', act(s) { s.gallic = false; gain(s, 'gratia', -8); return log(s, 'You swear again, to a different emperor, with the same words.'); } }],
  },
  diocletian: {
    title: 'The end of the crisis',
    text: () => 'Diocletian, a soldier of humble birth, has taken the purple. He will rule for twenty years and reform everything. The age of soldier emperors is closing, and the purple will be harder to steal.',
    choices: () => [{ label: 'Swear to Diocletian', act(s) { return log(s, 'A new age begins.'); } }],
  },
};

CARDS.discharge = {
  title: () => 'Honesta missio',
  text: (s) => `You have served ${Math.floor(s.served / 2)} years. You may take an honourable discharge, the veteran's bonus and a farm, or stay on.`,
  choices: (s) => [
    {
      label: 'Take the discharge and the farm',
      hint: 'ends the run safely',
      act(s2) {
        cash(s2, officer(s2) ? 5000 : 3000);
        s2.ending = 'discharged';
        s2.over = true;
        s2.fate = `Retired with an honourable discharge as ${RANKS[s2.rank].name}, ${s2.year} AD`;
        s2.queue = [];
        story(s2, 'Retired with an honourable discharge');
        return log(s2, 'You hand in your shield and go home a veteran.');
      },
    },
    { label: 'Re-enlist and keep climbing', hint: s.rank < R.centurio ? 'as an evocatus' : undefined, act(s2) { return log(s2, 'You stay with the eagles.'); } },
  ],
};

// --- random events ---------------------------------------------------------------------------

const EVENTS = [
  {
    id: 'dice', when: () => true,
    title: 'Dice in the barracks',
    text: 'The tent group has a game of tali going, and the stakes are getting high.',
    choices: [
      { label: 'Throw for 30 denarii', act(s, r) { if (s.denarii < 30) return log(s, 'You have nothing to stake and just watch.'); const w = r() < 0.47; cash(s, w ? 30 : -30); return log(s, w ? 'Venus throw! You win 30 denarii.' : 'The dogs. You lose 30 denarii.'); } },
      { label: 'Just watch', act(s) { return log(s, 'You keep your purse shut.'); } },
    ],
  },
  {
    id: 'vitis', when: (s) => s.rank <= R.signifer,
    title: 'The vine stick',
    text: 'Your centurion carries a vine stick and uses it freely. The men call him "Bring me another", after the sticks he breaks on their backs.',
    choices: [
      { label: 'Pay him 25 denarii for easier duties', hint: 'health +', act(s) { if (s.denarii < 25) return log(s, 'You cannot afford his favour.'); cash(s, -25); heal(s, 10); return log(s, 'Coins change hands, and your name drops off the latrine roster.'); } },
      { label: 'Take the beatings', hint: 'virtus +, health −', act(s) { gain(s, 'virtus', 3); hurt(s, 10, 'Beaten to death by a centurion'); return s.over ? s.fate : log(s, 'You take it without a sound.'); } },
      { label: 'Complain to the tribune', hint: 'risky', act(s, r) { if (r() < 0.5) { gain(s, 'gratia', 5); return log(s, 'The tribune reins him in, and notes your name.'); } gain(s, 'gratia', -6); hurt(s, 15, 'Beaten to death by a centurion'); return s.over ? s.fate : log(s, 'The tribune does nothing, and the centurion finds out.'); } },
    ],
  },
  {
    id: 'home', when: () => true,
    title: 'A letter from home',
    text: 'A letter on papyrus, written for your mother by the village scribe. The harvest failed and the tax collector came anyway.',
    choices: [
      { label: 'Send her 40 denarii', act(s) { if (s.denarii < 40) return log(s, 'You send what little you have, and a promise.'); cash(s, -40); s.pietas++; return log(s, 'You send money home. Pietas: duty to family.'); } },
      { label: 'Write back with news, but no money', act(s) { return log(s, 'You write about camp life and say nothing about money.'); } },
    ],
  },
  {
    id: 'clerk', when: (s) => s.stats.litterae < 45,
    title: 'The clerk\'s offer',
    text: 'A librarius from headquarters offers to teach you letters and accounts, for a price.',
    choices: [
      { label: 'Pay 30 denarii for lessons', hint: 'litterae ++', act(s) { if (s.denarii < 30) return log(s, 'You cannot pay him.'); cash(s, -30); gain(s, 'litterae', 8); return log(s, 'Evenings with the clerk and his tablets. Clerks get promoted.'); } },
      { label: 'Decline', act(s) { return log(s, 'You have better things to do in the evenings.'); } },
    ],
  },
  {
    id: 'chest', when: (s) => s.rank === R.signifer,
    title: 'The savings bank is short',
    text: 'As signifer you keep the century\'s savings. The count is 80 denarii short, and you know which soldier took it.',
    choices: [
      { label: 'Cover it from your own savings', hint: 'gratia +', act(s) { if (s.denarii < 80) return log(s, 'You cannot cover it and have to report it.'); cash(s, -80); gain(s, 'gratia', 5); gain(s, 'milites', 3); return log(s, 'You make it good quietly.'); } },
      { label: 'Report the thief', hint: 'gratia +', act(s) { gain(s, 'gratia', 4); return log(s, 'The thief is flogged and the centurion approves.'); } },
      { label: 'Take a cut and keep quiet', hint: 'denarii +, risky', act(s, r) { if (r() < 0.25) { s.rank = R.tesserarius; s.inRank = 0; gain(s, 'gratia', -15); story(s, 'Demoted for theft'); return log(s, 'You are found out and broken back to tesserarius.'); } cash(s, 60); return log(s, 'Nobody notices.'); } },
    ],
  },
  {
    id: 'mithras', when: () => true,
    title: 'The mysteries of Mithras',
    text: 'An optio invites you to a cave temple outside the walls, where officers and men eat together before the god who slays the bull.',
    choices: [
      { label: 'Be initiated (20 denarii)', hint: 'gratia +', act(s) { if (s.denarii < 20) return log(s, 'You cannot pay the initiation.'); cash(s, -20); gain(s, 'gratia', 6); return log(s, 'You are initiated as a Raven. Some of the brothers outrank you.'); } },
      { label: 'Keep to the gods of your fathers', act(s) { return log(s, 'You politely decline.'); } },
    ],
  },
  {
    id: 'wife', when: (s) => !s.married && s.age >= 21,
    title: 'In the camp town',
    text: 'Soldiers may marry now, since Severus allowed it. There is a woman in the canabae outside the walls whose father sells wine to the legion.',
    choices: [
      { label: 'Marry her', hint: 'health +', act(s) { s.married = true; heal(s, 15); cash(s, 40); story(s, 'Married'); return log(s, 'You marry. Her dowry is a small vineyard and her cooking is better than the army\'s.'); } },
      { label: 'Not yet', act(s) { return log(s, 'You are married to the eagles for now.'); } },
    ],
  },
  {
    id: 'escort', when: () => true,
    title: 'The pay chest',
    text: 'The legion\'s pay is coming up the road from the provincial treasury, and the escort needs men.',
    choices: [
      { label: 'Go with the escort', hint: 'gratia +, some danger', act(s, r) { gain(s, 'gratia', 3); if (r() < 0.2) { gain(s, 'virtus', 5); hurt(s, 10 + Math.floor(r() * 15), 'Killed by bandits on the road'); return s.over ? s.fate : log(s, 'Bandits hit the convoy. You beat them off, with a cut to show for it.'); } return log(s, 'An uneventful march, and the paymaster knows your face.'); } },
      { label: 'Find an excuse', act(s) { return log(s, 'Someone else can go.'); } },
    ],
  },
  {
    id: 'fever', when: () => true,
    title: 'Fever',
    text: 'You wake shaking with fever.',
    choices: [
      { label: 'Pay the medicus (15 denarii)', act(s) { cash(s, -15); hurt(s, 5, 'Died of fever'); return s.over ? s.fate : log(s, 'Bitter herbs and bed rest. You recover.'); } },
      { label: 'Sweat it out', act(s) { hurt(s, 22, 'Died of fever'); return s.over ? s.fate : log(s, 'It takes weeks to get your strength back.'); } },
    ],
  },
  {
    id: 'inspect', when: () => true,
    title: 'Inspection',
    text: 'A tribune is inspecting kit tomorrow.',
    choices: [
      { label: 'Polish everything twice', hint: 'gratia +', act(s) { gain(s, 'gratia', 3); return log(s, 'Your mail shines. The tribune stops at you.'); } },
      { label: 'Buy new kit from the armourer (30 denarii)', hint: 'gratia +', act(s) { if (s.denarii < 30) { gain(s, 'gratia', 2); return log(s, 'You polish what you have.'); } cash(s, -30); gain(s, 'gratia', 5); return log(s, 'A new helmet with a brass crest. The tribune asks your name.'); } },
    ],
  },
  {
    id: 'deserters', when: () => true,
    title: 'Deserters',
    text: 'Three deserters have been dragged back to camp. The legate wants an example made.',
    choices: [
      { label: 'Volunteer for the punishment detail', hint: 'gratia +', act(s) { gain(s, 'gratia', 3); if (officer(s)) gain(s, 'milites', -3); return log(s, 'You do what you are told.'); } },
      { label: 'Speak up for mercy', hint: 'milites +, gratia −', act(s) { gain(s, 'gratia', -4); gain(s, 'milites', 5); return log(s, 'The men hear that you spoke for them.'); } },
    ],
  },
  {
    id: 'mutiny', when: (s) => s.rank <= R.primuspilus && s.rank >= R.miles,
    title: 'Mutiny talk',
    text: 'Pay is three months late and the coins are getting thinner. In the barracks men are talking about choosing an emperor who pays.',
    choices: [
      { label: 'Join the grumbling', hint: 'milites +, risky', act(s, r) { if (officer(s)) gain(s, 'milites', 5); if (r() < 0.15) { hurt(s, 20, 'Executed for sedition'); gain(s, 'gratia', -8); return s.over ? s.fate : log(s, 'You are named as a ringleader and flogged.'); } return log(s, 'The pay arrives before anything happens.'); } },
      { label: 'Report the ringleaders', hint: 'gratia ++, milites −', act(s) { gain(s, 'gratia', 8); gain(s, 'milites', -8); return log(s, 'The ringleaders are executed. The legate remembers who told him.'); } },
      { label: 'Stay out of it', act(s) { return log(s, 'You keep your head down.'); } },
    ],
  },
  {
    id: 'hoard', when: () => true,
    title: 'A buried hoard',
    text: 'Digging a ditch, your spade hits a pot full of silver coins. In these years people bury their savings and die before they can dig them up.',
    choices: [
      { label: 'Keep it quietly', hint: 'denarii ++, risky', act(s, r) { if (r() < 0.15) { gain(s, 'gratia', -10); return log(s, 'Someone saw. The hoard is confiscated and you are disgraced.'); } cash(s, 150); return log(s, 'You quietly keep 150 denarii.'); } },
      { label: 'Hand it in', hint: 'gratia +', act(s) { gain(s, 'gratia', 6); cash(s, 25); return log(s, 'The legate gives you a reward and a word of praise.'); } },
    ],
  },
  {
    id: 'games', when: () => true,
    title: 'Games in the amphitheatre',
    text: 'The governor is putting on gladiators and wild beasts in the legion\'s amphitheatre.',
    choices: [
      { label: 'Bet 50 denarii on the murmillo', act(s, r) { if (s.denarii < 50) return log(s, 'You have nothing to bet and just cheer.'); const w = r() < 0.48; cash(s, w ? 60 : -50); return log(s, w ? 'He wins. You collect 110 denarii.' : 'He goes down. So does your money.'); } },
      { label: 'Just watch', act(s) { return log(s, 'A good day out.'); } },
    ],
  },
  {
    id: 'lender', when: (s) => s.debt === 0,
    title: 'A moneylender',
    text: 'A retired veteran lends money to soldiers at interest, repaid out of their pay.',
    choices: [
      { label: 'Borrow 150 denarii', hint: 'repay 200', act(s) { cash(s, 150); s.debt = 200; return log(s, 'You borrow 150 denarii. He will take 200 from your pay.'); } },
      { label: 'No thanks', act(s) { return log(s, 'You stay out of debt.'); } },
    ],
  },
  {
    id: 'champion', when: (s) => s.half === 0 && s.war && s.rank < R.castrorum,
    title: 'A challenge',
    text: 'A huge warrior walks out in front of the enemy line and shouts for a Roman to fight him.',
    choices: [
      { label: 'Answer the challenge', hint: 'glory, or death', act(s, r) { const x = r(); if (x < 0.14) return die(s, 'Killed in single combat'); if (x < 0.42) { hurt(s, 25, 'Died of wounds from single combat'); if (s.over) return s.fate; gain(s, 'virtus', 6); return log(s, 'You kill him, but he cuts you badly first.'); } gain(s, 'virtus', 12); return log(s, `You kill him in front of both armies and are awarded the ${decorate(s, officer(s) ? 'aurea' : 'torques')}.`); } },
      { label: 'Let someone else go', act(s) { return log(s, 'Someone else answers. You do not see how it ends.'); } },
    ],
  },
  {
    id: 'review', when: (s) => s.rank < R.legionis,
    title: 'The emperor reviews the army',
    text: (s) => `${emperorIn(s.year).name} rides along the lines on parade.`,
    choices: [
      { label: 'Cheer loudest', act(s) { gain(s, 'gratia', 2); return log(s, 'Your voice is hoarse for days.'); } },
      { label: 'Show off your drill', act(s) { if (s.stats.virtus >= 40) { gain(s, 'gratia', 8); return log(s, 'The emperor stops and speaks to you by name.'); } gain(s, 'gratia', 1); return log(s, 'You stumble in front of the emperor.'); } },
    ],
  },
  {
    id: 'stars', when: (s) => !s.omen,
    title: 'An astrologer',
    text: 'A Chaldaean astrologer in the camp town offers to cast your horoscope.',
    choices: [
      { label: 'Pay 10 denarii for a reading', act(s, r) { cash(s, -10); s.omen = true; if (r() < 0.3) { gain(s, 'milites', 6); return log(s, 'He goes pale and whispers that he sees purple in your stars. Somehow the men hear of it.'); } return log(s, 'He promises a long life and many sons.'); } },
      { label: 'Laugh him off', act(s) { s.omen = true; return log(s, 'You laugh. He curses you, mildly.'); } },
    ],
  },
  {
    id: 'bridge', when: (s) => s.stats.litterae >= 25 && s.rank <= R.optio,
    title: 'Engineers needed',
    text: 'The legion is bridging the river and the architectus needs men who can measure and count.',
    choices: [
      { label: 'Volunteer', hint: 'litterae +, gratia +', act(s) { gain(s, 'litterae', 5); gain(s, 'gratia', 3); return log(s, 'Six weeks of surveying and piling. The bridge stands.'); } },
      { label: 'Not your trade', act(s) { return log(s, 'You leave it to the specialists.'); } },
    ],
  },
  {
    id: 'staff', when: (s) => s.stats.litterae >= 35 && s.rank >= R.immunis && s.rank <= R.optio,
    title: 'The governor\'s staff',
    text: 'The provincial governor needs a beneficiarius: a soldier who reads, writes and carries his authority on the roads.',
    choices: [
      { label: 'Join his staff', hint: 'gratia ++, virtus −', act(s) { gain(s, 'gratia', 12); gain(s, 'virtus', -4); return log(s, 'You spend months at the governor\'s side. Important people learn your name.'); } },
      { label: 'Stay with the century', act(s) { return log(s, 'You stay where the fighting is.'); } },
    ],
  },
  {
    id: 'rival', when: () => true,
    title: 'A rival',
    text: (s) => `${RIVALS[(s.turn * 7) % RIVALS.length]} is telling the officers you are a coward and a thief.`,
    choices: [
      { label: 'Confront him', hint: 'virtus +', act(s, r) { gain(s, 'virtus', 3); if (r() < 0.3) { hurt(s, 10, 'Killed in a brawl'); return s.over ? s.fate : log(s, 'It comes to fists. You both end up in the guardhouse.'); } return log(s, 'He backs down in front of everyone.'); } },
      { label: 'Outshine him with the officers (30 denarii)', act(s) { if (s.denarii < 30) { gain(s, 'gratia', -3); return log(s, 'You have nothing to outshine him with.'); } cash(s, -30); gain(s, 'gratia', 3); return log(s, 'A few dinners and the story is forgotten.'); } },
      { label: 'Ignore it', act(s) { gain(s, 'gratia', -4); return log(s, 'The story spreads.'); } },
    ],
  },
  {
    id: 'rations', when: (s) => officer(s) && s.rank < R.imperator,
    title: 'Grumbling about rations',
    text: 'Your men say the grain is rotten and the wine is vinegar.',
    choices: [
      { label: 'Buy better from your own purse (40 denarii)', hint: 'milites +', act(s) { if (s.denarii < 40) return log(s, 'You cannot afford it.'); cash(s, -40); gain(s, 'milites', 7); return log(s, 'Fresh bread and decent wine. They notice.'); } },
      { label: 'Flog the loudest', hint: 'milites −, gratia +', act(s) { gain(s, 'milites', -6); gain(s, 'gratia', 2); return log(s, 'Discipline is restored, on the surface.'); } },
      { label: 'Ignore it', act(s) { gain(s, 'milites', -3); return log(s, 'The grumbling goes on.'); } },
    ],
  },
  {
    id: 'smuggler', when: (s) => s.rank >= R.miles,
    title: 'A trader\'s offer',
    text: 'A trader crossing the frontier offers you silver to look away from what is in his carts.',
    choices: [
      { label: 'Take the silver', hint: 'denarii ++, risky', act(s, r) { if (r() < 0.2) { gain(s, 'gratia', -12); return log(s, 'He is caught at the next post and names you.'); } cash(s, 90); return log(s, 'You take 90 denarii and see nothing.'); } },
      { label: 'Search his carts', hint: 'gratia +', act(s) { gain(s, 'gratia', 5); return log(s, 'Weapons for the barbarians. The legate is pleased.'); } },
    ],
  },
  {
    id: 'snow', when: (s) => s.half === 1,
    title: 'A hard winter',
    text: 'Snow buries the fort and firewood runs short.',
    choices: [
      { label: 'Share your firewood', hint: 'milites +, health −', act(s) { gain(s, 'milites', 4); hurt(s, 6, 'Died of cold'); return s.over ? s.fate : log(s, 'Your tent group gets through it together.'); } },
      { label: 'Keep warm', act(s) { heal(s, 5); return log(s, 'You keep your fire going.'); } },
    ],
  },
  {
    id: 'coins', when: (s) => s.year >= 258 && !s.debased,
    title: 'The new coins',
    text: 'The new silver coins are barely silver at all: bronze with a wash that rubs off. Prices in the camp town double.',
    choices: [
      { label: 'Buy gold now, at a loss', hint: 'lose 10%', act(s) { s.debased = true; cash(s, -s.denarii * 0.1); return log(s, 'You turn your savings into a few gold aurei.'); } },
      { label: 'Hope it passes', hint: 'lose 30%', act(s) { s.debased = true; cash(s, -s.denarii * 0.3); return log(s, 'It does not pass. Your savings are worth far less.'); } },
    ],
  },
  {
    id: 'patron', when: (s) => s.stats.gratia >= 25,
    title: 'Your patron dies',
    text: 'The officer who has been speaking for you is dead of a fever.',
    choices: [
      { label: 'Find a new patron fast (50 denarii)', act(s) { if (s.denarii < 50) { gain(s, 'gratia', -12); return log(s, 'You have nothing to offer a new patron.'); } cash(s, -50); gain(s, 'gratia', -4); return log(s, 'Gifts to a new patron, who agrees to remember you.'); } },
      { label: 'Mourn him and start again', act(s) { gain(s, 'gratia', -12); return log(s, 'You walk in his funeral procession.'); } },
    ],
  },
  {
    id: 'hunt', when: (s) => s.rank >= R.optio,
    title: 'A boar hunt',
    text: 'The officers are hunting boar in the forest and you are invited.',
    choices: [
      { label: 'Join the hunt', hint: 'gratia +, small danger', act(s, r) { gain(s, 'gratia', 5); if (r() < 0.1) { hurt(s, 20, 'Killed by a boar'); return s.over ? s.fate : log(s, 'The boar gets you in the thigh.'); } return log(s, 'You make the kill and the tribune toasts you.'); } },
      { label: 'Stay in camp', act(s) { return log(s, 'You stay in camp.'); } },
    ],
  },
  {
    id: 'recruits', when: (s) => s.rank >= R.optio && s.rank < R.imperator,
    title: 'Raw recruits',
    text: 'Forty recruits from the villages arrive, half of them sons of soldiers who had no choice.',
    choices: [
      { label: 'Train them yourself', hint: 'milites +, virtus +', act(s) { gain(s, 'milites', 4); gain(s, 'virtus', 2); return log(s, 'You make soldiers of them.'); } },
      { label: 'Leave it to the drill instructors', act(s) { return log(s, 'The campidoctor takes them.'); } },
    ],
  },
  {
    id: 'raid', when: (s) => s.half === 1 && ['rhine', 'danube'].includes(front(s)) && s.rank < R.imperator,
    title: 'The river freezes',
    text: 'The river has frozen solid, and raiders are crossing on the ice to burn farms on the Roman side.',
    choices: [
      { label: 'Lead a pursuit', hint: 'virtus +, danger', act(s, r) { gain(s, 'virtus', 7); const x = r(); if (x < 0.03) return die(s, 'Killed chasing raiders across the ice'); if (x < 0.2) { hurt(s, 15, 'Died of wounds from a winter raid'); return s.over ? s.fate : log(s, 'You catch them and pay for it.'); } return log(s, 'You catch them before they reach the far bank.'); } },
      { label: 'Hold the fort', act(s) { gain(s, 'virtus', 1); return log(s, 'You hold the walls and let the farms burn.'); } },
    ],
  },
  {
    id: 'guard', when: (s) => s.legion !== 'praetoriani' && s.rank >= R.miles && s.rank <= R.optio && s.stats.virtus >= 30,
    title: 'The Praetorian Guard',
    text: 'Since Severus, the Guard recruits its men from the best of the legions. A tribune of the Guard offers you a place in Rome: triple pay, close to the emperor, and in the middle of every coup.',
    choices: [
      { label: 'Go to Rome', hint: 'pay ++, gratia +, coups are deadly', act(s) { s.legion = 'praetoriani'; s.war = false; gain(s, 'gratia', 6); story(s, 'Joined the Praetorian Guard'); return log(s, 'You march into the Castra Praetoria in Rome.'); } },
      { label: 'Stay with the legion', act(s) { return log(s, 'You stay with your legion.'); } },
    ],
  },
  {
    id: 'plot', when: (s) => s.rank === R.imperator,
    title: 'A plot',
    text: 'Your freedman hands you a list of names: officers of your own guard who are planning to kill you.',
    choices: [
      { label: 'Execute them all', hint: 'gratia −, safer', act(s) { gain(s, 'gratia', -6); gain(s, 'milites', -3); return log(s, 'The list is shorter now, and so is your list of friends.'); } },
      { label: 'Pay them off', hint: '800 denarii', act(s) { cash(s, -800); gain(s, 'milites', 5); return log(s, 'Gold buys loyalty, for a while.'); } },
      { label: 'Ignore it', act(s, r) { if (r() < 0.35) return die(s, `Murdered by his own guard after ${reignWords(s)} as emperor`); return log(s, 'Nothing happens. Perhaps the list was false.'); } },
    ],
  },
];
const EVENT = Object.fromEntries(EVENTS.map((e) => [e.id, e]));

CARDS.event = {
  title: (s, a) => EVENT[a.id].title,
  text: (s, a) => (typeof EVENT[a.id].text === 'function' ? EVENT[a.id].text(s) : EVENT[a.id].text),
  choices: (s, a) => EVENT[a.id].choices,
  prepare(s, r, a) {
    const open = EVENTS.filter((e) => e.when(s) && !s.seen.includes(e.id));
    const pool = open.length ? open : EVENTS.filter((e) => e.when(s));
    a.id = pick(r, pool).id;
    s.seen.push(a.id);
    if (s.seen.length > 12) s.seen.shift();
  },
};

// --- time ------------------------------------------------------------------------------------

// A new year: is the legion's front at war, and what history happens to you?
function startYear(s, r) {
  s.war = atWar(s.year, front(s), r);
  if (s.rank !== R.imperator) {
    if (s.year > START_YEAR && REIGNS.some((x) => x.from === s.year)) {
      s.stats.gratia = Math.round(s.stats.gratia * 0.88);
      const loserChance = s.legion === 'praetoriani' ? 0.5 : 0.3;
      push(s, 'accession', { loser: s.year < 284 && r() < loserChance });
    }
    if (s.year === 239 && s.legion === 'iii-augusta') push(s, 'history', { key: 'disband' });
    if (s.year === 250) push(s, 'history', { key: 'plague' });
    if (s.year === 260 && ['rhine', 'britannia'].includes(front(s))) push(s, 'history', { key: 'gallic' });
    if (s.year === 274 && s.gallic) push(s, 'history', { key: 'reconquest' });
    if (s.year === 284) push(s, 'history', { key: 'diocletian' });
  }
  push(s, 'orders');
}

// The half-year is over: pay, healing, age, and the next half-year's orders.
function endHalf(s, r) {
  let wage = s.rank === R.imperator ? 1200 : pay(s);
  if (s.debt > 0) {
    const paid = Math.min(s.debt, Math.ceil(wage / 2));
    s.debt -= paid;
    wage -= paid;
  }
  cash(s, wage);
  heal(s, 6);
  s.served++;
  s.inRank++;
  if (s.rank === R.imperator) {
    s.reign++;
    const risk = clamp(0.17 - s.stats.milites / 1000 - s.stats.gratia / 1500 - (s.year > 284 ? 0.03 : 0), 0.05, 0.22);
    if (r() < risk) return die(s, pick(r, ['Murdered by the Praetorians', 'Killed by his own soldiers', 'Murdered by his officers']) + ` after ${reignWords(s)} as emperor`);
  }
  s.half = 1 - s.half;
  if (s.half === 0) {
    s.year++;
    s.age++;
    // Patrons die or forget, men are discharged and replaced, and age slows everyone.
    gain(s, 'gratia', -2);
    if (officer(s)) gain(s, 'milites', -3);
    if (s.age > 48) gain(s, 'virtus', -2);
    if (s.age >= 48 && r() < (s.age - 47) * 0.012) return die(s, `Died of old age${s.rank === R.imperator ? ' on the throne' : ''}`);
    if (s.age >= 70 && s.rank !== R.imperator) {
      s.ending = 'discharged';
      s.over = true;
      s.fate = `Retired at last, aged 70, as ${RANKS[s.rank].name}, ${s.year} AD`;
      return s.fate;
    }
    startYear(s, r);
  } else {
    push(s, 'orders');
  }
}

// --- playing ---------------------------------------------------------------------------------

function current(s) {
  return s.queue[0] ?? null;
}

// Fix whatever the card in front draws on (an event's pick, a battle's kind) before it is shown.
function settle(s, r) {
  const c = current(s);
  if (c && !c.ready) {
    CARDS[c.id].prepare?.(s, r, c.args);
    c.ready = true;
  }
}

// Start a run: the first card is ready to show.
export function start(seed) {
  const s = newRun(seed);
  settle(s, dice(s));
  return s;
}

// Answer the card in front with choice `i`. Returns { error } or { ok, line }.
export function choose(s, i) {
  if (s.over) return { error: 'This career is over.' };
  const c = current(s);
  if (!c) return { error: 'Nothing to answer.' };
  const card = CARDS[c.id];
  const options = card.choices(s, c.args);
  const option = options[i];
  if (!option || option.off) return { error: 'You can\'t do that.' };
  const r = dice(s);
  s.turn++;
  const line = option.act(s, r, c.args);
  if (!s.over) {
    s.queue.shift();
    if (c.id === 'orders') card.after(s, r);
    if (!s.queue.length) endHalf(s, r);
    if (!s.over) settle(s, r);
  }
  return { ok: true, line };
}

export function score(s) {
  const st = s.stats;
  const base = RANKS[s.best].points + st.virtus / 2 + st.gratia / 4 + st.litterae / 4
    + s.decorations.length * 20 + Math.floor(s.served / 2) * 3 + Math.floor(s.denarii / 500)
    + s.reign * 30 + s.works * 10 + s.pietas * 3;
  const bonus = s.ending === 'abdicated' ? 250 : s.ending === 'discharged' ? 40 : 0;
  return Math.round(base + bonus);
}

// What the page shows: never the seed.
export function view(s) {
  const c = current(s);
  let card = null;
  if (c) {
    const def = CARDS[c.id];
    card = {
      title: def.title(s, c.args),
      text: def.text(s, c.args),
      choices: def.choices(s, c.args).map(({ label, hint, off }) => ({ label, hint: hint ?? null, off: Boolean(off) })),
    };
  }
  return {
    turn: s.turn,
    name: s.name,
    origin: ORIGINS.find((o) => o.id === s.origin)?.name ?? null,
    legion: s.origin ? legion(s).name : null,
    base: s.origin ? legion(s).base : null,
    front: s.origin ? FRONTS[front(s)] : null,
    year: s.year,
    season: HALVES[s.half],
    age: s.age,
    years: Math.floor(s.served / 2),
    emperor: s.rank === R.imperator ? s.name : emperorIn(s.year).name,
    rank: s.rank,
    best: s.best,
    ranks: RANKS.map(({ name, gloss }) => ({ name, gloss })),
    stats: { ...s.stats },
    officer: officer(s),
    health: s.health,
    denarii: s.denarii,
    debt: s.debt,
    decorations: s.decorations.map((k) => DECORATIONS[k]),
    log: s.log.slice(-12),
    story: s.story,
    card,
    over: s.over,
    fate: s.fate,
    score: score(s),
  };
}
