// Everything about CFO that is a number or a name, kept apart from the rules so the design can be
// tuned without touching logic. Values marked PLACEHOLDER were not in Miles's spreadsheet
// (CFO_Game.xlsb) and are guesses to make the first version playable.

export const CONFIG = {
  minPlayers: 2,
  maxPlayers: 6, // Miles: 2-6
  startCompanyCash: 3000, // PLACEHOLDER: contributed capital
  startPersonalCash: 500, // PLACEHOLDER
  baseRevenue: 500, // PLACEHOLDER: every company's core business earns this at each fiscal year end
  corporateTax: 0.2, // PLACEHOLDER
  personalTax: 0.2, // PLACEHOLDER: on money paid from your company to yourself
  depreciation: 0.1, // PLACEHOLDER: straight line, 10 years
  landRent: 0.1, // PLACEHOLDER: share of the land price, doubled for a full colour set
  liquidation: 0.5, // PLACEHOLDER: the bank buys assets back at half their cost
  personalAssetPrice: 1000, // PLACEHOLDER: personal cash paid per Personal Assets draw
  portfolioGoal: 100000, // spreadsheet: $100k personal asset portfolio (~93 draws)
  maxYears: 8, // PLACEHOLDER: game ends once every company has closed this many fiscal years
  fraudFine: 1000, // PLACEHOLDER: per fraud found at an Interim Review
  loanLimit: 2000, // Bank corner (Claude's idea for the unlabeled corner): most a company may owe
  loanInterest: 0.1, // charged on the loan balance at each fiscal year end
  rowSize: 3, // PLACEHOLDER: face-up zoning and PP&E cards to choose from
  turnSeconds: 0, // 0 = no turn timer (Miles: off for now). Set to e.g. 60 to auto-play idle turns.
};

// ---- Board ----
// The spreadsheet board is a loop: the FYE corner, spaces 1-20 along the top, a corner, 21-29
// down the right, the CPE corner, 30-49 along the bottom, Interim Review, then 50-58 back up.
// Positions here count every square including corners, 0-61. The unlabeled top-right corner is
// a Bank where companies can borrow (PLACEHOLDER until Miles decides).
export const BOARD_SIZE = 62;
export const CORNERS = { 0: 'fye', 21: 'bank', 31: 'cpe', 52: 'review' };
export const CPE_POS = 31;

export function posOfSpace(n) {
  if (n <= 20) return n;
  if (n <= 29) return n + 1;
  if (n <= 49) return n + 2;
  return n + 3;
}

// Transport squares come from the labels beside the board; deck squares are the three spaces
// left over once 47 land and 8 transport tiles are placed (PLACEHOLDER positions).
const TRANSPORT_SPACES = { 5: 'rail', 25: 'rail', 45: 'rail', 11: 'truck', 40: 'truck', 16: 'air', 34: 'air', 54: 'air' };
const DECK_SPACES = { 8: 'market', 28: 'fraud', 48: 'personal' };

export const MODES = {
  truck: { name: 'Trucking', companies: ['Iron Mile Logistics', 'Steel Ridge Transport'] },
  rail: { name: 'Railway', companies: ['Norfolk Western Railway', 'BNSF Railway', 'LBJ Railway'] },
  air: { name: 'Airport', companies: ['Ascendance Airlines', 'Titan Air Cargo', 'NorthStar Logistics'] },
};
export const TRANSPORT_PRICE = 400; // PLACEHOLDER
export const TRANSPORT_RENT = 50; // PLACEHOLDER: doubles for each other tile of the same mode owned

// Land sets in board order, from the Assets sheet. The spreadsheet left every other set without a
// colour; they get placeholder colours so they still form sets.
export const SETS = [
  { name: 'Brown', color: '#8b5a2b', size: 4, price: 80 },
  { name: 'Pink', color: '#e58fb5', size: 4, price: 100, placeholder: true },
  { name: 'Baby Blue', color: '#9fd3f0', size: 4, price: 120 },
  { name: 'Teal', color: '#2a9d8f', size: 4, price: 140, placeholder: true },
  { name: 'Red', color: '#d64545', size: 3, price: 160 },
  { name: 'Lime', color: '#a3c940', size: 4, price: 180, placeholder: true },
  { name: 'Orange', color: '#f08a24', size: 3, price: 200 },
  { name: 'Tan', color: '#c9a66b', size: 3, price: 220, placeholder: true },
  { name: 'Yellow', color: '#f2d33c', size: 3, price: 240 },
  { name: 'Olive', color: '#7d8b3a', size: 3, price: 260, placeholder: true },
  { name: 'Green', color: '#3fa34d', size: 3, price: 280 },
  { name: 'Lavender', color: '#b39ddb', size: 3, price: 300, placeholder: true },
  { name: 'Blue', color: '#2f5fd0', size: 2, price: 350 },
  { name: 'Gray', color: '#8a8f98', size: 2, price: 400, placeholder: true },
  { name: 'Purple', color: '#7b3fa0', size: 2, price: 450 },
];

// One entry per position: { kind, ... }.
export const SQUARES = buildSquares();

function buildSquares() {
  const squares = new Array(BOARD_SIZE);
  for (const [pos, corner] of Object.entries(CORNERS)) squares[pos] = { kind: corner };
  const modeCount = { truck: 0, rail: 0, air: 0 };
  const landSlots = [];
  for (let n = 1; n <= 58; n++) {
    const pos = posOfSpace(n);
    if (TRANSPORT_SPACES[n]) {
      const mode = TRANSPORT_SPACES[n];
      squares[pos] = { kind: 'transport', space: n, mode, name: MODES[mode].companies[modeCount[mode]++], price: TRANSPORT_PRICE };
    } else if (DECK_SPACES[n]) {
      squares[pos] = { kind: 'deck', space: n, deck: DECK_SPACES[n] };
    } else {
      landSlots.push([n, pos]);
    }
  }
  let i = 0;
  SETS.forEach((set, s) => {
    for (let k = 0; k < set.size; k++) {
      const [n, pos] = landSlots[i++];
      squares[pos] = { kind: 'land', space: n, set: s, name: `${set.name} ${k + 1}`, price: set.price };
    }
  });
  if (i !== landSlots.length) throw new Error('land sets do not fill the board');
  return squares;
}

// ---- Zoning (47 cards, Assets sheet) ----
// What a building does depends on the zone of the land under it (Miles: Industrial makes
// widgets, Retail sells them, Residential collects rent, Banking earns interest). Every building
// also charges visitors `rent` x its cost. The rates are PLACEHOLDERS:
// - Industrial: each fiscal year, spends `produce` x cost of company cash making widgets (inventory).
// - Retail: each fiscal year, sells widgets for up to `sell` x cost, at WIDGET_MARKUP x what they cost to make.
// - Residential: tenants pay `yearly` x cost each fiscal year, on top of the high visitor rent.
// - Banking: earns `interest` of the company's cash, plus `yearly` x cost in fees, each fiscal year.
export const ZONES = {
  industrial: { name: 'Industrial', count: 26, rent: 0.1, produce: 0.3 },
  retail: { name: 'Retail', count: 10, rent: 0.2, sell: 1.2 },
  banking: { name: 'Banking', count: 4, rent: 0.1, yearly: 0.1, interest: 0.03 },
  residential: { name: 'Residential', count: 7, rent: 0.5, yearly: 0.15 },
};
export const WIDGET_MARKUP = 2;

// ---- PP&E (47 cards, Assets sheet) ----
export const RARITIES = {
  common: { name: 'Common', count: 25, price: 100 },
  uncommon: { name: 'Uncommon', count: 13, price: 200 },
  rare: { name: 'Rare', count: 5, price: 1000 },
  epic: { name: 'Epic', count: 3, price: 10000 },
  legendary: { name: 'Legendary', count: 1, price: 100000 },
};

// ---- Draw decks (Draw Decks sheet) ----
// keep: the card goes to your hand to play on a later turn; otherwise it happens at once.
export const FRAUD_CARDS = {
  bribe: { name: 'Bribe the Zoning Board', count: 5, keep: true, text: 'Pay $100 per card to replace the available zoning cards.' },
  embezzle: { name: 'Embezzle', count: 4, keep: true, placeholder: true, text: 'Move up to $2,000 from your company to yourself with no personal tax, booked as an expense.' },
  cook: { name: 'Cook the Books', count: 3, keep: true, placeholder: true, text: 'Your company pays no tax at its next fiscal year end.' },
  kickback: { name: 'Kickback', count: 3, keep: true, placeholder: true, text: 'Every other company pays yours $200.' },
};

export const MARKET_CARDS = {
  alienation: {
    name: 'Alienation of Affection', count: 5, keep: true,
    text: 'Pay $1,000 to the bank to take all "Spouse" cards from another player. If you already have Spouse cards, discard them.',
  },
  contractor: { name: 'Contractor Connections', count: 5, keep: true, text: 'Search the PP&E deck and build any card for 90% of its price.' },
  recession: { name: 'Recession', count: 3, placeholder: true, text: 'Every company loses 10% of its cash.' },
  boom: { name: 'Boom', count: 3, placeholder: true, text: 'Every company earns $500.' },
  lawsuit: { name: 'Lawsuit', count: 2, placeholder: true, text: 'Your company pays $750.' },
  shipping: { name: 'Shipping Rates Rise', count: 2, placeholder: true, text: 'Owners of transport tiles earn $150 for each one they own.' },
};

export const PERSONAL_CARDS = {
  loyal: {
    name: 'Loyal Spouse', count: 1, value: 10000, spouse: true,
    text: 'Cannot be discarded or transferred, and protects your other Spouse cards. With several Attractive Spouses you only pay $25 a year.',
  },
  attractive: {
    name: 'Attractive Spouse', count: 3, value: 2000, spouse: true,
    text: 'Pay $10 raised to the number of these you hold each fiscal year, discarding them until you can.',
  },
  wealthy: { name: 'Wealthy Spouse', count: 2, value: 1000, spouse: true, text: 'Receive $10 raised to the number of these you hold each fiscal year.' },
  intelligent: { name: 'Intelligent Spouse', count: 2, value: 1000, spouse: true, text: 'Deduct $100 from your personal taxes each fiscal year.' },
  horses: { name: 'Horses', count: 5, value: 25 },
  beach: { name: 'Beach House', count: 5, value: 250 },
  cabin: { name: 'Mountain Cabin', count: 5, value: 250 },
  mansion: { name: 'Country Mansion', count: 5, value: 1500 },
};

export function deckOf(cards) {
  const deck = [];
  for (const [id, c] of Object.entries(cards)) for (let i = 0; i < c.count; i++) deck.push(id);
  return deck;
}
