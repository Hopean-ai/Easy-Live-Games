// Everything about CFO that is a number or a name, kept apart from the rules so the design can be
// tuned without touching logic. Values marked PLACEHOLDER were not in Miles's spreadsheet
// (CFO_Game.xlsb) and are guesses to make the first version playable.

// Miles: every dollar amount is scaled up, for appearances, so the books read like a real
// company's. Amounts below are written at their original design size and multiplied by this.
export const MONEY_SCALE = 100;
export const M = (n) => n * MONEY_SCALE;
const usd = (n) => `$${M(n).toLocaleString('en-US')}`;

export const CONFIG = {
  minPlayers: 2,
  maxPlayers: 6, // Miles: 2-6
  startCompanyCash: M(3000), // PLACEHOLDER: contributed capital
  startPersonalCash: M(500), // PLACEHOLDER
  salary: M(200), // PLACEHOLDER: Miles: at each fiscal year end the company pays you automatically: this base salary...
  salaryBonus: 0.2, // ...plus this share of the year's profit before your pay (taxed as personal income)
  corporateTax: 0.2, // PLACEHOLDER
  personalTax: 0.2, // PLACEHOLDER: on money paid from your company to yourself
  depreciation: 0.1, // PLACEHOLDER: straight line, 10 years
  landRent: 0.1, // PLACEHOLDER: share of the land price, doubled for a full colour set
  liquidation: 0.5, // PLACEHOLDER: the bank buys assets back at half their cost
  personalAssetPrice: M(1000), // PLACEHOLDER: personal cash paid per Personal Assets draw
  // Miles: landing on a Personal Assets square is a chance of a free card, a discount, or nothing.
  // A discount is off one card bought that turn. PLACEHOLDER odds; they add up to 1.
  personalSquareOdds: [
    { chance: 1 / 6, free: true },
    { chance: 1 / 3, discount: 0.5 },
    { chance: 1 / 2, discount: 0.25 }, // Miles: no "nothing" result; its 1 in 4 went to the smallest discount
  ],
  portfolioGoal: M(35000), // spreadsheet had $100k (~93 draws); lowered so a player who pays themselves can reach it in a full game
  // Miles (design principles, change 1): the value win counts total shareholder return, the share
  // price plus every dividend paid per share, for the company's original 100 shares. Paying out
  // dividends doesn't set a company back in the race; paying the CFO bonuses does.
  valueTarget: M(75000), // PLACEHOLDER: shareholder value that wins (bot tournament: reached around year 12-13, hoarding no better than paying dividends)
  maxYears: 12, // room setting (Miles, change 4: eras give the game an arc, so the default is shorter; was 16): end once every company has closed this many years (0 = no limit). Playtests ran past 100 years without one.
  // Miles: fraud is a big deal. Getting caught is an immediate loss, and every fraud committed
  // adds to the chance, but fraud should break even at about 3-4 frauds. A check's chance is this
  // x the square of the frauds on record (PLACEHOLDER), and one fraud ages off every few years.
  // Bot playtests: holding up to 4 matches a clean player's net worth; 6 or more falls behind.
  auditFraudChance: 0.006, // at an Interim Review (or island Customs)
  fraudExpiryYears: 4, // PLACEHOLDER: one fraud ages off the record every this many fiscal years
  fyeFraudChance: 0.0006, // at each fiscal year end
  misstatementFine: M(100), // PLACEHOLDER: per wrong or missing entry or statement line found at an Interim Review
  cleanBooksBonus: M(200), // PLACEHOLDER: for filing a fiscal year with no misstatements
  ipoYears: 3, // PLACEHOLDER: fiscal years a company needs before it can go public
  ipoShares: 25, // PLACEHOLDER: new shares sold at an IPO (every company starts with 100)
  publicPremium: 1.2, // PLACEHOLDER: the market values a public company at this x what a private one is worth (1.5 made going public the best move in every playtest)
  // Miles (change 2): the market prices companies on earnings. Cash counts at face value; the rest
  // of the equity (the business) at its return over the return investors require (the textbook
  // justified price-to-book), so idle cash adds no more than itself and cash put to work at a good
  // return adds more. Earnings are averaged over recent years.
  requiredReturn: 0.1, // PLACEHOLDER
  earningsYears: 2, // PLACEHOLDER
  priceToBook: [0.5, 3], // PLACEHOLDER: the lowest and highest the market will go
  activistCash: 0.4, // PLACEHOLDER: Activist Investor card: cash above this share of total assets is excess...
  activistPayout: 0.5, // ...and this share of the excess must be paid out as a dividend
  publicScrutiny: 2, // PLACEHOLDER: public companies are twice as likely to be caught, and fined twice as much
  acquirePremium: 1.5, // PLACEHOLDER: buying a rival outright costs this x its market value...
  acquireMin: M(10000), // ...and never less than this, so an early or nearly broke company isn't a cheap kill
  subsidiaryMin: M(1000), // PLACEHOLDER: least a parent must put into a new subsidiary
  managerShares: 25, // PLACEHOLDER: share of a subsidiary its hired manager owns
  // Miles: you are the company's CFO, not its owner. You start holding this many of its 100 shares;
  // the founders hold the rest. Investing buys new shares; once the company is public, the profit
  // share of your salary is paid in new shares at the market price (a stock award).
  cfoShares: 20, // PLACEHOLDER
  minIssuePrice: M(1), // PLACEHOLDER: new shares are never issued below this, even when equity is gone
  bookkeeperFee: M(3), // PLACEHOLDER: per document a bookkeeper posts at the year end (about $10k for a typical year); no clean-books bonus
  seatBonus: M(100), // PLACEHOLDER: extra starting capital for each seat after the first (going first won 59% of 2-player playtests, 52% with this)
  personalUnit: 1, // Miles: personal cash is as granular as company cash (one cent); this used to be $10,000
  salvage: 0.5, // PLACEHOLDER: Miles: destroyed PP&E (upgrading or rezoning) returns this share of its book value
  transportLand: 0.3, // PLACEHOLDER: Miles: a transport tile's price is 30% land, 70% PP&E (track, depots, runways) that depreciates
  rezoneFee: 0.25, // PLACEHOLDER: Miles: rezoning costs this share of the land's price, and the PP&E on it must be rebuilt
  propertyTax: 0.015, // PLACEHOLDER: Miles: a property tax, this share of each lot's list price plus its building's cost, at each fiscal year end
  loanLimit: M(5000), // Bank corner (Claude's idea for the unlabeled corner): most a company may owe
  loanInterest: 0.1, // charged on the loan balance at each fiscal year end
  rowSize: 3, // face-up zoning cards
  ppeRowSize: 5, // face-up PP&E cards: more choice, so a row of unaffordable cards is rare
  maxBankOptions: 2, // PLACEHOLDER: extra private PP&E choices from owning Banking buildings
  settlement: M(5000), // PLACEHOLDER: paid at island Customs to settle one fraud and clear it from your record
  islandFare: M(1500), // PLACEHOLDER: company cash paid to an airport's owner to fly to or from the island
  // Miles (change 8): every company shares one calendar. The fiscal year ends for everyone at once
  // after this many rounds (about one lap of the board on average); the FYE corner gives an extra
  // board decision instead.
  roundsPerYear: 9, // PLACEHOLDER
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

// ---- The island ----
// Miles: a late-game area in the middle, 24 squares including its corners, reached only by
// paying an airport's owner a fare. You loop it; the only way off is a flight from its Terminal,
// so a player stuck there without their own transport network falls behind. Positions 62-85,
// laid out as a 7 x 7 ring with the Terminal at its top-left.
export const ISLAND_START = BOARD_SIZE;
export const ISLAND_SIZE = 24;
export const ISLAND_CORNERS = { 0: 'terminal', 6: 'haven', 12: 'customs', 18: 'exchange' };
export const onIsland = (pos) => pos >= ISLAND_START;
export const nextPos = (pos) => (onIsland(pos)
  ? ISLAND_START + ((pos - ISLAND_START + 1) % ISLAND_SIZE)
  : (pos + 1) % BOARD_SIZE);
// The island's 20 other squares, in order: four pricier land sets, two decks and two landmarks.
const ISLAND_SPACES = ['set', 'set', 'set', 'market', 'set', 'set', 'set', 'set', 'resort', 'set', 'set', 'set',
  'set', 'personal', 'set', 'set', 'set', 'port', 'set', 'set'];
// Miles: perhaps some special buildings. Landmarks are sold with their building already up, and
// with a zone of their own. PLACEHOLDER numbers.
export const LANDMARKS = {
  resort: { name: 'Grand Resort', zone: 'residential', price: M(1200), building: M(3000) },
  port: { name: 'Free Port', zone: 'retail', price: M(1200), building: M(3000) },
};

export function posOfSpace(n) {
  if (n <= 20) return n;
  if (n <= 29) return n + 1;
  if (n <= 49) return n + 2;
  return n + 3;
}

// Transport squares come from the labels beside the board. The spreadsheet left three spaces for
// decks; Miles asked for more, so three lots became decks too: one per side gets a Fraud or
// Market Forces square, and the main board now has 44 lots (PLACEHOLDER positions).
const TRANSPORT_SPACES = { 5: 'rail', 25: 'rail', 45: 'rail', 11: 'truck', 40: 'truck', 16: 'air', 34: 'air', 54: 'air' };
const DECK_SPACES = { 8: 'market', 18: 'fraud', 28: 'fraud', 37: 'market', 48: 'personal', 57: 'market' };

export const MODES = {
  truck: { name: 'Trucking', companies: ['Iron Mile Logistics', 'Steel Ridge Transport'] },
  rail: { name: 'Railway', companies: ['Norfolk Western Railway', 'BNSF Railway', 'LBJ Railway'] },
  // Miles: airports are expensive, since they are the way to the island. PLACEHOLDER price.
  air: { name: 'Airport', companies: ['Ascendance Airlines', 'Titan Air Cargo', 'NorthStar Logistics'], price: M(1200) },
};
export const TRANSPORT_PRICE = M(400); // PLACEHOLDER
export const TRANSPORT_RENT = M(50); // PLACEHOLDER: doubles for each other tile of the same mode owned

// Land sets in board order, from the Assets sheet. The spreadsheet left every other set without a
// colour; they get placeholder colours so they still form sets.
export const SETS = [
  { name: 'Brown', color: '#8b5a2b', size: 4, price: M(80) },
  { name: 'Pink', color: '#e58fb5', size: 3, price: M(100), placeholder: true },
  { name: 'Baby Blue', color: '#9fd3f0', size: 4, price: M(120) },
  { name: 'Teal', color: '#2a9d8f', size: 3, price: M(140), placeholder: true },
  { name: 'Red', color: '#d64545', size: 3, price: M(160) },
  { name: 'Lime', color: '#a3c940', size: 3, price: M(180), placeholder: true },
  { name: 'Orange', color: '#f08a24', size: 3, price: M(200) },
  { name: 'Tan', color: '#c9a66b', size: 3, price: M(220), placeholder: true },
  { name: 'Yellow', color: '#f2d33c', size: 3, price: M(240) },
  { name: 'Olive', color: '#7d8b3a', size: 3, price: M(260), placeholder: true },
  { name: 'Green', color: '#3fa34d', size: 3, price: M(280) },
  { name: 'Lavender', color: '#b39ddb', size: 3, price: M(300), placeholder: true },
  { name: 'Blue', color: '#2f5fd0', size: 2, price: M(350) },
  { name: 'Gray', color: '#8a8f98', size: 2, price: M(400), placeholder: true },
  { name: 'Purple', color: '#7b3fa0', size: 2, price: M(450) },
  // Island sets: PLACEHOLDER names, colours and prices.
  { name: 'Coral', color: '#ff7f6e', size: 4, price: M(600), island: true },
  { name: 'Lagoon', color: '#1fb5c9', size: 4, price: M(700), island: true },
  { name: 'Palm', color: '#5fbf6a', size: 4, price: M(800), island: true },
  { name: 'Gold Coast', color: '#d4af37', size: 4, price: M(1000), island: true },
];

// One entry per position: { kind, ... }.
export const SQUARES = buildSquares();

function buildSquares() {
  const squares = new Array(BOARD_SIZE + ISLAND_SIZE);
  for (const [pos, corner] of Object.entries(CORNERS)) squares[pos] = { kind: corner };
  const modeCount = { truck: 0, rail: 0, air: 0 };
  const landSlots = [];
  for (let n = 1; n <= 58; n++) {
    const pos = posOfSpace(n);
    if (TRANSPORT_SPACES[n]) {
      const mode = TRANSPORT_SPACES[n];
      squares[pos] = { kind: 'transport', space: n, mode, name: MODES[mode].companies[modeCount[mode]++], price: MODES[mode].price ?? TRANSPORT_PRICE };
    } else if (DECK_SPACES[n]) {
      squares[pos] = { kind: 'deck', space: n, deck: DECK_SPACES[n] };
    } else {
      landSlots.push([n, pos]);
    }
  }
  const islandSlots = [];
  for (let k = 0; k < ISLAND_SIZE; k++) {
    const pos = ISLAND_START + k;
    if (ISLAND_CORNERS[k]) {
      squares[pos] = { kind: ISLAND_CORNERS[k], island: true };
      continue;
    }
    islandSlots.push(pos);
  }
  let i = 0;
  let j = 0;
  ISLAND_SPACES.forEach((what, k) => {
    const pos = islandSlots[k];
    if (what === 'market' || what === 'personal') squares[pos] = { kind: 'deck', deck: what, island: true };
    else if (LANDMARKS[what]) squares[pos] = { kind: 'land', island: true, landmark: what, name: LANDMARKS[what].name, price: LANDMARKS[what].price };
  });
  SETS.forEach((set, s) => {
    for (let k = 0; k < set.size; k++) {
      let n = null;
      let pos;
      if (set.island) {
        while (ISLAND_SPACES[j] !== 'set') j++;
        pos = islandSlots[j++];
      } else {
        [n, pos] = landSlots[i++];
      }
      squares[pos] = { kind: 'land', space: n, set: s, name: `${set.name} ${k + 1}`, price: set.price, ...(set.island ? { island: true } : {}) };
    }
  });
  if (i !== landSlots.length || j !== ISLAND_SPACES.length) throw new Error('land sets do not fill the board');
  return squares;
}

// ---- Zoning (60 cards, one per lot) ----
// What a building does depends on the zone of the land under it (Miles: Industrial makes
// widgets, Retail sells them, Residential collects rent, Banking earns interest). Every building
// also charges visitors `rent` x its cost. The rates are PLACEHOLDERS:
// - Industrial: makes widgets at the end of each of its owner's turns, planned to what their stores
//   need, up to `produce` x the square root of (PP&E cost x land price) a turn, so the building and
//   the land count equally. Landing on it runs an overtime shift of `overtime` turns' worth. The
//   widgets wait in the factory until the company ships them.
//   Costs (economies of scale): each widget takes `variableCost` in materials and labour, and each
//   factory carries `overhead` per widget of capacity every turn. Overhead is absorbed into the
//   widgets made, so a widget always goes into inventory at variableCost + overhead; the share of
//   overhead on capacity left idle is expensed that turn. A full factory makes the cheapest widgets.
// - Retail: sells widgets at the end of every one of the owner's turns (see RETAIL below).
// - Residential (Miles): passive income. Tenants pay `yearly` x cost at each fiscal year end;
//   visitors pay only the land rent.
// - Banking: earns `interest` of the company's cash, plus `yearly` x cost in fees, each fiscal year.
// One card per lot: the spreadsheet's 47, less 3 Industrial for the lots that became deck squares,
// plus 16 for the island's lots (2 Industrial, 6 Retail, 2 Banking, 6 Residential).
export const ZONES = {
  industrial: { name: 'Industrial', count: 25, rent: 0.1, produce: 0.32, overtime: 12, variableCost: 0.6, overhead: 0.2 },
  retail: { name: 'Retail', count: 16, rent: 0.2 },
  banking: { name: 'Banking', count: 6, rent: 0.1, yearly: 0.25, interest: 0.05 },
  residential: { name: 'Residential', count: 13, rent: 0, yearly: 0.75 },
};

// Widgets are counted in units. The spreadsheet's widget tiers are
// denominations of that count, like bills: a Platinum widget is 10,000 Common ones.
export const WIDGET_TIERS = [
  ['Platinum', 10000], ['Gold', 1000], ['Silver', 100], ['Bronze', 10], ['Common', 1],
];

// Miles: widgets sell throughout the rounds, and landing on Retail gives more control that turn.
// A store's PP&E sets its price per widget and its land sets how many it sells. PLACEHOLDERS.
export const RETAIL = {
  perLandDollar: 1, // each store sells up to this x its land price in widgets at the end of each of your turns
  prices: { common: 2, uncommon: 2.25, rare: 2.5, landmark: 2.5, epic: 2.75, legendary: 3 }, // per widget, by the store's PP&E
  // Choices when you land on your own Retail square, as multiples of a normal turn's volume and price.
  sales: {
    clearance: { name: 'Clearance sale', volume: 3, price: 0.75 },
    premium: { name: 'Premium launch', volume: 1, price: 1.5 },
  },
  commission: 0.25, // landing on someone else's Retail: sell through their store, they keep this share
  // Miles: a pricing dial. Each company sets its stores' prices; cheaper sells more widgets a turn.
  pricing: {
    low: { name: 'Low prices', price: 0.8, volume: 1.5 },
    normal: { name: 'Normal prices', price: 1, volume: 1 },
    premium: { name: 'Premium prices', price: 1.25, volume: 0.6 },
  },
  // Stores on the same side of the board compete: each rival store there with lower prices than
  // yours takes this share of your customers, and each with higher prices sends you as many more.
  competition: 0.1,
  freight: 0.2, // per widget shipped from a factory on a side where you own no transport line: paid to a rival's line there, or a hired carrier
};


// The supply chain (see `operate` in rules.js). Each company sets a production level (Miles: a
// dial). Stores are restocked up to `cover` turns of their sales. Matching demand, factories make
// only what that needs; at full capacity they run flat out and stores stock deeper, with the rest
// waiting in the factories; idle, they make nothing. PLACEHOLDERS.
// Miles: trade credit. Part of each store's sales is on credit (Accounts receivable), collected a
// few of the owner's turns later; widget materials are bought on credit (Accounts payable) and paid
// a few turns later. Cards change those periods. PLACEHOLDER numbers.
export const CREDIT = {
  salesShare: 0.5, // share of normal store sales made on credit
  collectTurns: 2, // customers pay this many of your turns after the sale
  payTurns: 2, // suppliers are paid this many of your turns after the purchase
  factoringFee: 0.03, // a factor buys receivables now for this much less
  fastCollect: 1, // Credit Department: customers pay in this many turns
  slowPay: 4, // Supplier Negotiation: suppliers are paid in this many turns
  disputeDelay: 4, // Bogus Quality Dispute: every bill owed moves back this many turns
  badDebt: 0.1, // Customer Default: share of receivables written off
};

// Miles (design principles, change 3): every turn holds one board decision, wherever you land.
// After moving, a CFO may take one of these. PLACEHOLDER amounts.
export const BOARD = {
  marketing: { name: 'Marketing campaign', perStore: M(250), boost: 0.3, text: 'Advertise: every store you own sells this much more for the rest of the fiscal year.' },
  research: { name: 'Process improvement', cost: M(1000), saving: 0.05, levels: 3, text: 'Research and development that cuts what each widget costs to make, for good (up to three times).' },
  financing: { name: 'Call the bank', text: 'Arrange a loan by phone: borrow or repay as if you were at the Bank this turn.' },
  restructure: { name: 'Restructure', text: 'Sell one building or lot to the bank for half its cost, to raise cash or leave a market.' },
};
// Change 3b: once per fiscal year, a CFO can plan a move of 1 to 6 squares instead of rolling.
export const PLANNED_MOVE = { min: 1, max: 6 };

// Miles (design principles, change 4): the economy moves through three eras on the shared
// calendar. Each era sets the largest PP&E that can be built, what's open, and the Bank's rate.
// saturation scales every store's sales once markets mature. PLACEHOLDERS.
export const ERAS = [
  { id: 'startup', name: 'Startup era', from: 1, maxRarity: 'rare', ipo: false, buyouts: false, island: false, loanInterest: 0.06, saturation: 1,
    text: 'Cheap money and small buildings: up to Rare PP&E, Bank loans at 6%. No IPOs, buyouts or island flights yet.' },
  { id: 'growth', name: 'Growth era', from: 5, maxRarity: 'epic', ipo: true, buyouts: true, island: false, loanInterest: 0.1, saturation: 1,
    text: 'Capital markets open: IPOs and buyouts, Epic PP&E, Bank loans at 10%.' },
  { id: 'maturity', name: 'Maturity era', from: 10, maxRarity: 'legendary', ipo: true, buyouts: true, island: true, loanInterest: 0.12, saturation: 0.85,
    text: 'Markets saturate: stores sell 15% less, Legendary PP&E and the island open, Bank loans at 12%. Returning cash to shareholders matters more.' },
];
// Change 4b: the economic outlook shows the next events that will hit every company, one firing at
// each shared year end, so players can prepare.
export const OUTLOOK = { size: 2, events: ['recession', 'boom', 'rates', 'housing', 'shortage', 'rezoning', 'holiday', 'spoilage', 'default', 'crunch', 'shipping', 'activist'] };

export const SUPPLY = {
  levels: {
    idle: { name: 'Idle', cover: 2, make: false },
    demand: { name: 'Match demand', cover: 2, make: true },
    full: { name: 'Full capacity', cover: 4, make: true, flatOut: true },
  },
};

// ---- PP&E (60 cards, one per lot; the Assets sheet had 47) ----
// Each step up costs about 4x the last, so the top cards take saving for (Miles: the right feel).
export const RARITIES = {
  common: { name: 'Common', count: 21, price: M(100) },
  uncommon: { name: 'Uncommon', count: 18, price: M(400) },
  rare: { name: 'Rare', count: 12, price: M(1500) },
  epic: { name: 'Epic', count: 6, price: M(6000) },
  legendary: { name: 'Legendary', count: 3, price: M(15000) },
  landmark: { name: 'Landmark', count: 0, price: M(3000) }, // only on the island's landmark squares
  transport: { name: 'Transport', count: 0, price: 0 }, // the structures on a transport tile, bought with it
};

// ---- Draw decks (Draw Decks sheet) ----
// keep: the card goes to your hand to play on a later turn; otherwise it happens at once.
export const FRAUD_CARDS = {
  bribe: { name: 'Bribe the Zoning Board', count: 5, keep: true, text: `Pay ${usd(100)} per card to replace the available zoning cards.` },
  embezzle: { name: 'Embezzle', count: 4, keep: true, placeholder: true, text: `Move up to ${usd(2000)} from your company to yourself with no personal tax, booked as an expense.` },
  cook: { name: 'Cook the Books', count: 3, keep: true, placeholder: true, text: `Book up to ${usd(2000)} of this year's expenses as PP&E instead, so profits and the company's value look higher.` },
  kickback: { name: 'Kickback', count: 3, keep: true, placeholder: true, text: `Every other company pays yours ${usd(200)}.` },
  stuffing: { name: 'Channel Stuffing', count: 3, keep: true, placeholder: true, text: `Book next year's sales now: sell up to ${M(500).toLocaleString('en-US')} of your widgets, wherever they are, at your store price.` },
  insider: { name: 'Insider Trading', count: 2, keep: true, placeholder: true, text: 'Buy up to 10 shares of a public company at half the market price.' },
  evasion: { name: 'Tax Evasion', count: 3, keep: true, placeholder: true, text: 'Pay no personal tax on what you take out of companies for the rest of this fiscal year.' },
  shell: { name: 'Shell Company', count: 2, keep: true, placeholder: true, text: `Borrow ${usd(1500)} through a front, on top of your Bank loan limit.` },
  ponzi: { name: 'Ponzi Scheme', count: 2, keep: true, placeholder: true, text: `Every other player pays you ${usd(100)} of personal cash.` },
  shred: { name: 'Shred the Evidence', count: 2, keep: true, placeholder: true, text: 'Clear two frauds from your record. Shredding is itself a fraud, so it counts as one.' },
  backdate: { name: 'Backdated Invoice', count: 3, keep: true, placeholder: true, text: 'Build one of the available PP&E cards for half its price.' },
  dispute: { name: 'Bogus Quality Dispute', count: 2, keep: true, placeholder: true, text: `Claim your suppliers' goods were faulty: every bill you owe them is paid 4 turns later than due.` },
  fictitious: { name: 'Fictitious Receivables', count: 2, keep: true, placeholder: true, text: `Book up to ${usd(1500)} of sales on credit to customers who don't exist. Profit and company value rise until the fiscal year end, when the bills are written off as bad debts.` },
};

export const MARKET_CARDS = {
  alienation: {
    name: 'Alienation of Affection', count: 5, keep: true,
    text: `Pay ${usd(1000)} to the bank to take all "Spouse" cards from another player. If you already have Spouse cards, discard them.`,
  },
  limitations: { name: 'Statute of Limitations', count: 2, keep: true, placeholder: true, text: 'Clear one fraud from your record.' },
  contractor: { name: 'Contractor Connections', count: 5, keep: true, text: 'Search the PP&E deck and build any card for 90% of its price.' },
  recession: { name: 'Recession', count: 3, placeholder: true, text: 'Every company loses 10% of its cash.' },
  boom: { name: 'Boom', count: 3, placeholder: true, text: `Every company earns ${usd(500)}.` },
  lawsuit: { name: 'Lawsuit', count: 2, placeholder: true, text: `Your company pays ${usd(750)}.` },
  shipping: { name: 'Shipping Rates Rise', count: 2, placeholder: true, text: `Owners of transport tiles earn ${usd(150)} for each one they own.` },
  rates: { name: 'Interest Rate Hike', count: 2, placeholder: true, text: 'Every company with a Bank loan pays 10% of it in interest now.' },
  housing: { name: 'Housing Boom', count: 2, placeholder: true, text: 'Owners of Residential PP&E collect half of each building\'s cost in rent.' },
  shortage: { name: 'Widget Shortage', count: 2, placeholder: true, text: 'Every store sells a normal turn\'s worth of widgets right now at $3 each.' },
  rezoning: { name: 'Zoning Reform', count: 2, placeholder: true, text: 'The available zoning cards are replaced for free.' },
  holiday: { name: 'Tax Holiday', count: 2, placeholder: true, text: 'No company pays corporate tax at its next fiscal year end.' },
  spoilage: { name: 'Supply Chain Disruption', count: 2, placeholder: true, text: 'Every company writes off 10% of its widgets.' },
  factoring: { name: 'Invoice Factoring', count: 3, keep: true, placeholder: true, text: 'Sell everything your customers owe you to a factor: collect it all now, less a 3% fee.' },
  creditDept: { name: 'Credit Department', count: 2, keep: true, placeholder: true, text: 'Chase customers harder: for the rest of this fiscal year, they pay 1 turn after a sale instead of 2.' },
  supplierTerms: { name: 'Supplier Negotiation', count: 2, keep: true, placeholder: true, text: 'Win longer terms: for the rest of this fiscal year, you pay suppliers 4 turns after a purchase instead of 2.' },
  default: { name: 'Customer Default', count: 2, placeholder: true, text: 'A big customer goes under: every company writes off 10% of what its customers owe it.' },
  crunch: { name: 'Credit Crunch', count: 2, placeholder: true, text: 'Suppliers demand cash: every company pays everything it owes them now.' },
  activist: { name: 'Activist Investor', count: 2, placeholder: true, text: 'An activist fund targets idle cash: every company holding more than 40% of its assets in cash pays half the excess out as a dividend.' },
  whistle: { name: 'Whistleblower', count: 2, keep: true, placeholder: true, text: `Tip off the regulators about a rival: they face a fraud check at Interim Review odds. If they're convicted, you collect a ${usd(1000)} reward.` },
};

export const PERSONAL_CARDS = {
  loyal: {
    name: 'Loyal Spouse', count: 1, value: M(10000), spouse: true,
    text: `Cannot be discarded or transferred, and protects your other Spouse cards. With several Attractive Spouses you only pay ${usd(25)} a year.`,
  },
  attractive: {
    name: 'Attractive Spouse', count: 3, value: M(2000), spouse: true,
    text: `Pay ${usd(10)} x 10 for each of these you hold beyond the first, each fiscal year, discarding them until you can.`,
  },
  wealthy: { name: 'Wealthy Spouse', count: 2, value: M(1000), spouse: true, text: `Receive ${usd(10)} x 10 for each of these you hold beyond the first, each fiscal year.` },
  intelligent: { name: 'Intelligent Spouse', count: 2, value: M(1000), spouse: true, text: `Deduct ${usd(100)} from your personal taxes each fiscal year.` },
  // Miles: small effects, nothing too disruptive; the Beach House ties to the island. PLACEHOLDER amounts.
  horses: { name: 'Horses', count: 5, value: M(25), prize: M(250), text: `The first time you roll doubles each fiscal year, each of your horses wins ${usd(250)} at the races.` },
  beach: { name: 'Beach House', count: 5, value: M(250), lap: M(250), text: `Rent it to tourists: receive ${usd(250)} each time you complete a lap of the island.` },
  cabin: { name: 'Mountain Cabin', count: 5, value: M(250), yearly: M(100), text: `Study at your cabin: you never sit out a turn at Continuing Professional Education. Rent it out for ${usd(100)} each fiscal year.` },
  mansion: { name: 'Country Mansion', count: 5, value: M(1500), yearly: M(250), text: `Host weddings and events: receive ${usd(250)} each fiscal year.` },
};

export function deckOf(cards) {
  const deck = [];
  for (const [id, c] of Object.entries(cards)) for (let i = 0; i < c.count; i++) deck.push(id);
  return deck;
}
