// Legio's encounters: the things that happen to you between orders. Each one names the ranks it
// fits (`ranks: [lowest, highest]`, as indexes into RANKS), so a legate is never sent to dig a
// ditch and a recruit is never asked to sentence a deserter. Some start a story that a later
// encounter finishes: `later(s, key, halves)` marks it, and the follow-up (`follow: true`) waits on
// `due`, then comes before anything else.
// A label can be a function of the run, for the few choices worded differently by rank.
// The rules hand in their helpers (rules.js), so this file holds only words and choices.

export function encounters(h) {
  const { R, gain, cash, heal, hurt, die, log, story, decorate, officer, front, legion, emperorIn, reignWords } = h;

  // Tiers of the ladder, as [lowest, highest] rank.
  const LOW = [R.miles, R.signifer];
  const MID = [R.optio, R.primuspilus];
  const HIGH = [R.castrorum, R.dux];
  const RANKED = [R.miles, R.dux]; // everyone but recruits and emperors
  const LOWMID = [R.miles, R.primuspilus];
  const MIDHIGH = [R.optio, R.dux];
  const EMPEROR = [R.imperator, R.imperator];

  const RIVERS = { rhine: 'the Rhine', danube: 'the Danube', east: 'the Euphrates', africa: 'the wadi', britannia: 'the Wall ditch', field: 'the river', rome: 'the Tiber' };
  const ENEMIES = { rhine: 'Alamanni', danube: 'Goths', east: 'Persians', africa: 'Moorish raiders', britannia: 'Caledonians', field: 'enemy', rome: 'enemy' };
  const river = (s) => RIVERS[front(s)];
  const enemy = (s) => ENEMIES[front(s)];
  const base = (s) => legion(s).base;
  const threads = (s) => (s.threads ??= {});
  const later = (s, key, halves) => { threads(s)[key] = s.served + halves; };
  const due = (s, key) => threads(s)[key] != null && s.served >= threads(s)[key];
  const done = (s, key) => { delete threads(s)[key]; };
  const pay = (s, n, line, poor = 'You cannot afford it.') => {
    if (s.denarii < n) return { poor: log(s, poor) };
    cash(s, -n);
    return { line };
  };
  const wounded = (s, n, fate, line) => {
    hurt(s, n, fate);
    return s.over ? s.fate : log(s, line);
  };

  return [
    // --- the ranks: miles to signifer --------------------------------------------------------
    {
      id: 'dice', ranks: LOW,
      title: 'Knucklebones',
      text: (s) => `In the barrack room at ${base(s)}, Bithus the Thracian has his knucklebones out on an upturned shield. The pot is thirty denarii, and he has won four throws running.`,
      choices: [
        { label: 'Throw against him for 30 denarii', act(s, r) { if (s.denarii < 30) return log(s, 'You have nothing to stake, so you watch.'); const w = r() < 0.47; cash(s, w ? 30 : -30); return log(s, w ? 'Four different faces: the Venus throw. Bithus swears in Thracian and pays.' : 'Four ones: the dogs. Bithus grins and sweeps your coins away.'); } },
        { label: 'Watch his hands', hint: 'virtus +, risky', act(s, r) { if (r() < 0.5) { gain(s, 'virtus', 3); gain(s, 'gratia', 2); return log(s, 'His bones are weighted. You say so in front of the room, and he gives everyone their money back.'); } return wounded(s, 12, 'Knifed in a barrack-room brawl', 'You accuse him and he puts a knife in your forearm. Nobody saw anything.'); } },
        { label: 'Go to bed', act(s) { return log(s, 'You hear him winning until well after the watch changes.'); } },
      ],
    },
    {
      id: 'vitis', ranks: LOW,
      title: '"Bring me another"',
      text: 'Your centurion, Valerius Crispus, breaks his vine stick across a man\'s back at morning parade and calls for a fresh one. The men have a nickname for him from that, and he knows it.',
      choices: [
        { label: 'Pay him 25 denarii to be left off the latrine roster', hint: 'health +', act(s) { const p = pay(s, 25, 'Crispus pockets the coins without a word, and your name disappears from the roster.', 'You have nothing to buy him off with.'); if (p.line) heal(s, 10); return p.line ?? p.poor; } },
        { label: 'Take the beatings without a sound', hint: 'virtus +, health −', act(s) { gain(s, 'virtus', 3); return wounded(s, 10, 'Beaten to death by his centurion', 'You stand there and take it. By the end of the month Crispus stops bothering.'); } },
        { label: 'Complain to the tribune', hint: 'risky', act(s, r) { if (r() < 0.5) { gain(s, 'gratia', 5); return log(s, 'The tribune is a young knight who hates Crispus. He reins him in and remembers your face.'); } gain(s, 'gratia', -6); return wounded(s, 15, 'Beaten to death by his centurion', 'The tribune does nothing. Crispus finds out by evening.'); } },
      ],
    },
    {
      id: 'clerk', ranks: LOW, when: (s) => s.stats.litterae < 45,
      title: 'The clerk\'s offer',
      text: 'Flavius Ammonius, a librarius from headquarters with ink on every finger, says he will teach you to read the duty rosters and keep accounts in the evenings. Clerks, he points out, get promoted.',
      choices: [
        { label: 'Pay him 30 denarii for lessons', hint: 'litterae ++', act(s) { const p = pay(s, 30, 'Evenings with Ammonius and his wax tablets. By spring you can read the rosters yourself.', 'You cannot pay him.'); if (p.line) gain(s, 'litterae', 8); return p.line ?? p.poor; } },
        { label: 'Offer to clean his kit instead', hint: 'litterae +', act(s) { gain(s, 'litterae', 3); return log(s, 'He agrees, grudgingly, and teaches you the letters while you polish his boots.'); } },
        { label: 'Decline', act(s) { return log(s, 'You have better things to do in the evenings.'); } },
      ],
    },
    {
      id: 'chest', ranks: [R.signifer, R.signifer],
      title: 'The savings bank is short',
      text: 'As signifer you keep the century\'s savings in the strongroom under the shrine of the standards. The count is 80 denarii short, and only Aurelius Pudens had the key last week.',
      choices: [
        { label: 'Cover it from your own savings', hint: 'gratia +', act(s) { const p = pay(s, 80, 'You make it good quietly. Pudens looks at you differently after that.', 'You cannot cover it, and have to report it.'); if (p.line) { gain(s, 'gratia', 5); gain(s, 'milites', 3); } return p.line ?? p.poor; } },
        { label: 'Report Pudens', hint: 'gratia +', act(s) { gain(s, 'gratia', 4); return log(s, 'Pudens is flogged in front of the century and the money is docked from his pay.'); } },
        { label: 'Take a cut and keep quiet', hint: 'denarii +, risky', act(s, r) { if (r() < 0.25) { s.rank = R.tesserarius; s.inRank = 0; gain(s, 'gratia', -15); story(s, 'Demoted for theft'); return log(s, 'The quartermaster counts the chest again. You are broken back to tesserarius.'); } cash(s, 60); return log(s, 'Pudens says nothing, and neither do you.'); } },
      ],
    },
    {
      id: 'escort', ranks: LOW,
      title: 'The pay chest',
      text: (s) => `The legion's pay is coming up the road to ${base(s)} from the provincial treasury: four mule-carts of coin, and an escort of twenty men who will be blamed if a single sack goes missing.`,
      choices: [
        { label: 'Volunteer for the escort', hint: 'gratia +, some danger', act(s, r) { gain(s, 'gratia', 3); if (r() < 0.2) { gain(s, 'virtus', 5); return wounded(s, 10 + Math.floor(r() * 15), 'Killed by bandits on the pay road', 'Bandits hit the carts at a ford. You hold the last cart and take a sword cut doing it.'); } return log(s, 'Six days on the road and nothing happens. The paymaster learns your name.'); } },
        { label: 'Find an excuse', act(s) { return log(s, 'You report sick with a sudden fever.'); } },
      ],
    },
    {
      id: 'inspect', ranks: LOW,
      title: 'Inspection',
      text: 'The tribune Iulius Rufinus inspects the cohort tomorrow. He is known for pulling men out of line over a rusty buckle.',
      choices: [
        { label: 'Polish everything twice', hint: 'gratia +', act(s) { gain(s, 'gratia', 3); return log(s, 'Your mail shines. Rufinus stops in front of you and nods.'); } },
        { label: 'Buy a new helmet from the armourer (30 denarii)', hint: 'gratia +', act(s) { const p = pay(s, 30, 'A new helmet with a brass crest-knob. Rufinus asks your name.'); if (p.line) gain(s, 'gratia', 5); else gain(s, 'gratia', 2); return p.line ?? log(s, 'You polish what you have.'); } },
        { label: 'Borrow a comrade\'s kit for the morning', hint: 'risky', act(s, r) { if (r() < 0.3) { gain(s, 'gratia', -5); return log(s, 'Rufinus notices the name scratched inside the helmet is not yours.'); } gain(s, 'gratia', 3); return log(s, 'Nobody notices.'); } },
      ],
    },
    {
      id: 'deserters_low', ranks: LOW,
      title: 'Deserters',
      text: 'Three deserters from your cohort were caught in a barn two days\' march away. The legate wants them beaten to death by their own comrades: the fustuarium.',
      choices: [
        { label: 'Swing your club with the rest', hint: 'gratia +', act(s) { gain(s, 'gratia', 3); return log(s, 'You do what you are told. You do not sleep well.'); } },
        { label: 'Swing it lightly', hint: 'risky', act(s, r) { if (r() < 0.25) { gain(s, 'gratia', -6); return log(s, 'The optio sees you holding back and marks you down.'); } return log(s, 'One of them crawls away alive. Nobody stops him.'); } },
      ],
    },
    {
      id: 'mutiny_low', ranks: LOW,
      title: 'Mutiny talk',
      text: 'Pay is three months late and the new coins are thinner than the old. In the barracks, Septimius Varus says the legion should choose an emperor who pays.',
      choices: [
        { label: 'Agree with him loudly', hint: 'risky', act(s, r) { if (r() < 0.2) { gain(s, 'gratia', -8); return wounded(s, 20, 'Executed for sedition', 'Someone repeats what you said to the tribune. You are flogged as a ringleader.'); } gain(s, 'virtus', 1); return log(s, 'The pay arrives before anything comes of it.'); } },
        { label: 'Tell the optio who is talking', hint: 'gratia ++', act(s) { gain(s, 'gratia', 8); return log(s, 'Varus is sent to a quarry in chains. The officers remember who told them. So do the men.'); } },
        { label: 'Stay out of it', act(s) { return log(s, 'You keep your head down until the pay comes.'); } },
      ],
    },
    {
      id: 'hoard', ranks: LOW,
      title: 'A pot in the ditch',
      text: (s) => `Recutting the ditch outside ${base(s)}, your spade hits a clay pot. It is full of silver coins with the head of Severus Alexander on them. In these years people bury their savings and die before they can dig them up.`,
      choices: [
        { label: 'Keep it quietly', hint: 'denarii ++, risky', act(s, r) { if (r() < 0.15) { gain(s, 'gratia', -10); return log(s, 'The man digging beside you talks. The coins are confiscated and you are fined besides.'); } cash(s, 150); return log(s, 'You count 150 denarii that night, under your blanket.'); } },
        { label: 'Hand it in', hint: 'gratia +', act(s) { gain(s, 'gratia', 6); cash(s, 25); return log(s, 'The camp prefect gives you a reward and calls you an honest man in front of the cohort.'); } },
        { label: 'Share it with the men digging beside you', hint: 'denarii +', act(s) { cash(s, 50); gain(s, 'virtus', 1); return log(s, 'Five ways, fifty denarii each, and four friends for life.'); } },
      ],
    },
    {
      id: 'bridge', ranks: [R.immunis, R.signifer], when: (s) => s.stats.litterae >= 25,
      title: 'The architect\'s mistake',
      text: (s) => `The legion is bridging ${river(s)}, and you have been helping the architectus, Claudius Hermes, measure the piers. His figures for the third pier are wrong by a full foot.`,
      choices: [
        { label: 'Tell him quietly', hint: 'gratia +, litterae +', act(s) { gain(s, 'gratia', 4); gain(s, 'litterae', 3); return log(s, 'Hermes rechecks, goes pale, and from then on asks your opinion first.'); } },
        { label: 'Tell the legate', hint: 'gratia ++, risky', act(s, r) { if (r() < 0.5) { gain(s, 'gratia', 8); return log(s, 'The legate is impressed. Hermes is not.'); } gain(s, 'gratia', -4); return log(s, 'Hermes convinces the legate you misread the tablet.'); } },
        { label: 'Say nothing', act(s) { return log(s, 'The pier settles crooked in the spring floods. Nobody knows why.'); } },
      ],
    },
    {
      id: 'staff', ranks: [R.immunis, R.signifer], when: (s) => s.stats.litterae >= 35,
      title: 'The governor\'s staff',
      text: 'The provincial governor needs a beneficiarius: a soldier who can read, write and carry his authority on the roads, with a lance-shaped badge to prove it.',
      choices: [
        { label: 'Join his staff for a year', hint: 'gratia ++, virtus −', act(s) { gain(s, 'gratia', 12); gain(s, 'virtus', -4); return log(s, 'A year of roadside posts, tax disputes and sealed letters. Important people learn your name.'); } },
        { label: 'Stay with the century', act(s) { return log(s, 'You stay where the fighting is.'); } },
      ],
    },
    {
      id: 'guard', ranks: LOW, when: (s) => s.legion !== 'praetoriani' && s.stats.virtus >= 30,
      title: 'The Praetorian Guard',
      text: 'Since Severus, the Guard has recruited from the best men of the frontier legions. A Guard tribune is looking over your cohort: triple pay, Rome, and a front-row seat at every murder of an emperor.',
      choices: [
        { label: 'Go to Rome', hint: 'pay ++, gratia +, coups are deadly', act(s) { s.legion = 'praetoriani'; s.war = false; gain(s, 'gratia', 6); story(s, 'Joined the Praetorian Guard'); return log(s, 'You march through the gate of the Castra Praetoria with a new white tunic.'); } },
        { label: 'Stay with the legion', act(s) { return log(s, 'You stay with the eagle you swore to.'); } },
      ],
    },
    {
      id: 'dizo', ranks: LOW, when: (s) => s.stats.litterae >= 15 && !threads(s).dizo,
      title: 'A letter for Dizo',
      text: 'Aurelius Dizo shares your tent: a big, quiet Thracian who cannot read or write. His mother in Serdica has not heard from him in two years. He asks if you would write to her for him.',
      choices: [
        { label: 'Write it for him', hint: 'a friend', act(s) { later(s, 'dizo', 3); gain(s, 'litterae', 1); return log(s, '"Dizo to his mother, many greetings. I am well, the food is bad, send socks." You add a line saying he is brave.'); } },
        { label: 'Charge him 10 denarii', act(s) { cash(s, 10); return log(s, 'He pays, and does not ask you again.'); } },
        { label: 'Tell him to ask the clerk', act(s) { return log(s, 'He nods and goes away.'); } },
      ],
    },
    {
      id: 'dizo_return', follow: true, ranks: LOWMID, when: (s) => due(s, 'dizo'),
      title: 'Dizo pays his debt',
      text: (s) => `Crossing ${river(s)} on a pontoon in the dark, the planks give way and you go under in full armour. A hand grabs your belt. It is Dizo, who got a letter back from his mother last month and has been waiting for a chance.`,
      choices: [
        { label: 'Thank him', act(s) { done(s, 'dizo'); heal(s, 10); gain(s, 'milites', 3); story(s, 'Saved from drowning by Aurelius Dizo'); return log(s, 'You lie on the bank coughing water. Dizo says his mother sent the socks.'); } },
      ],
    },
    {
      id: 'bassus', ranks: LOW, when: (s) => !threads(s).bassus,
      title: 'The old veteran',
      text: (s) => `In a wine shop in the camp town outside ${base(s)}, an old man with one ear and a veteran's bronze diploma on a cord sits alone. Gaius Iulius Bassus served thirty years and says he can teach you things the drill instructors never will, for the price of a jug.`,
      choices: [
        { label: 'Buy him a jug (5 denarii)', hint: 'virtus +', act(s) { cash(s, -5); gain(s, 'virtus', 4); later(s, 'bassus', 6); return log(s, 'He shows you how to fight with the shield rim, and where a Goth keeps his second knife.'); } },
        { label: 'Leave him to his wine', act(s) { return log(s, 'He calls you a pretty boy as you leave.'); } },
      ],
    },
    {
      id: 'bassus_funeral', follow: true, ranks: RANKED, when: (s) => due(s, 'bassus'),
      title: 'Bassus is dead',
      text: 'A boy from the wine shop finds you. Old Bassus died in the night and left a wax tablet with your name on it: his sword, and a request that someone pay for his funeral and a stone.',
      choices: [
        { label: 'Pay for a stone (40 denarii)', hint: 'pietas', act(s) { done(s, 'bassus'); const p = pay(s, 40, 'The stone says: "To the shades of Gaius Iulius Bassus, veteran, he lived 63 years. His friend set this up."', 'You cannot afford a stone. You pay for a plain burial.'); if (p.line) s.pietas += 2; gain(s, 'virtus', 2); return p.line ?? p.poor; } },
        { label: 'Take the sword and go', act(s) { done(s, 'bassus'); gain(s, 'virtus', 2); return log(s, 'It is a good sword. The burial club buries him in the common pit.'); } },
      ],
    },
    {
      id: 'curse', ranks: LOW,
      title: 'Stolen at the baths',
      text: 'Someone stole your belt from the changing room of the legion\'s bathhouse, silver fittings and all. Men in your century say the gods punish thieves if you ask properly.',
      choices: [
        { label: 'Scratch a curse on a lead tablet', hint: 'needs letters', act(s, r) { if (s.stats.litterae < 15) return log(s, 'You cannot write it. You buy a new belt.'); gain(s, 'litterae', 1); if (r() < 0.4) { cash(s, 20); return log(s, '"Whoever took my belt, may he lose his eyes." Three days later it is back on your bunk.'); } return log(s, 'You throw the tablet in the spring. The belt does not come back.'); } },
        { label: 'Search the barracks', hint: 'risky', act(s, r) { if (r() < 0.5) { gain(s, 'virtus', 2); return log(s, 'You find it under a recruit\'s blanket and give him a lesson he deserves.'); } gain(s, 'gratia', -3); return log(s, 'You turn out half the century\'s kit and find nothing. The optio is not amused.'); } },
        { label: 'Buy a new one (20 denarii)', act(s) { cash(s, -20); return log(s, 'Plain bronze this time.'); } },
      ],
    },
    {
      id: 'sentry', ranks: LOW, when: (s) => s.half === 1,
      title: 'The night watch',
      text: (s) => `You are on the rampart at ${base(s)} in the third watch. Out in the dark beyond ${river(s)} something is moving: torches, or perhaps just your eyes.`,
      choices: [
        { label: 'Sound the alarm', hint: 'gratia + or −', act(s, r) { if (r() < 0.4) { gain(s, 'gratia', 6); gain(s, 'virtus', 2); return log(s, `It is a ${enemy(s)} raiding party, and the gate is shut in time. The tribune asks who saw them first.`); } gain(s, 'gratia', -3); return log(s, 'The whole fort turns out for a herd of deer. The men call you "Hannibal" for a month.'); } },
        { label: 'Send for the tesserarius', act(s) { gain(s, 'gratia', 1); return log(s, 'He watches with you until dawn. Whatever it was goes away.'); } },
        { label: 'Watch and wait', act(s, r) { if (r() < 0.15) return wounded(s, 20, 'Killed on the rampart by night raiders', 'An arrow out of the dark takes you in the shoulder.'); return log(s, 'The lights fade before dawn.'); } },
      ],
    },
    {
      id: 'informer', ranks: LOWMID, when: (s) => !threads(s).informer && s.legion !== 'praetoriani',
      title: 'The grain officer',
      text: 'A frumentarius from Rome arrives, supposedly to inspect the granaries. Everyone knows what frumentarii really are: the emperor\'s spies. He takes you aside and asks what your officers say about the emperor at dinner.',
      choices: [
        { label: 'Tell him what you have heard', hint: 'gratia ++, dangerous later', act(s) { gain(s, 'gratia', 8); later(s, 'informer', 4); return log(s, 'He writes it all down and gives you a small purse. Two officers are recalled to Rome in the spring.'); } },
        { label: 'Say you have heard nothing', act(s) { return log(s, 'He looks at you for a long moment and moves on.'); } },
      ],
    },
    {
      id: 'informer_known', follow: true, ranks: RANKED, when: (s) => due(s, 'informer'),
      title: 'They know',
      text: 'Someone has worked out who talked to the frumentarius. There is a dead rat in your boots, and men stop talking when you enter the bathhouse.',
      choices: [
        { label: 'Ask for a transfer', hint: 'gratia −', act(s) { done(s, 'informer'); gain(s, 'gratia', -4); gain(s, 'milites', -5); return log(s, 'You let it be known you would welcome a posting elsewhere. Nobody is sorry.'); } },
        { label: 'Face them down', hint: 'risky', act(s, r) { done(s, 'informer'); gain(s, 'milites', -8); if (r() < 0.2) return wounded(s, 30, 'Murdered by his own comrades as an informer', 'Three men catch you behind the granary.'); return log(s, 'You stare them down. It does not make you friends.'); } },
      ],
    },
    {
      id: 'champion', ranks: LOWMID, when: (s) => s.half === 0 && s.war,
      title: 'A challenge',
      text: (s) => `Before the battle lines close, a huge ${enemy(s)} warrior with a gold torc walks out between the armies and shouts for a Roman to come and fight him.`,
      choices: [
        { label: 'Answer the challenge', hint: 'glory, or death', act(s, r) { const x = r(); if (x < 0.14) return die(s, 'Killed in single combat'); if (x < 0.42) { gain(s, 'virtus', 6); return wounded(s, 25, 'Died of wounds from single combat', 'You kill him, but he opens your thigh first.'); } gain(s, 'virtus', 12); return log(s, `You kill him in front of both armies and take his torc. You are awarded the ${decorate(s, officer(s) ? 'aurea' : 'torques')}.`); } },
        { label: 'Let someone else go', act(s) { return log(s, 'A cavalryman from Pannonia rides out instead. You do not see how it ends.'); } },
      ],
    },
    {
      id: 'review', ranks: LOWMID,
      title: 'The emperor reviews the army',
      text: (s) => `${emperorIn(s.year).name} rides along the lines on a white horse, with the Guard behind him and the eagles dipped in salute.`,
      choices: [
        { label: 'Cheer loudest', act(s) { gain(s, 'gratia', 2); return log(s, 'Your voice is gone for days.'); } },
        { label: (s) => (officer(s) ? 'Put your century through its drill' : 'Show off your drill'), act(s) { if (s.stats.virtus >= 40) { gain(s, 'gratia', 8); return log(s, 'The emperor reins in, watches, and asks your name.'); } gain(s, 'gratia', 1); return log(s, 'Someone stumbles in the turn. The emperor rides on.'); } },
      ],
    },
    {
      id: 'scout', ranks: LOWMID, when: (s) => s.half === 0 && s.war,
      title: 'A prisoner',
      text: (s) => `Your patrol catches a ${enemy(s)} scout hiding in a reed bed: a boy of sixteen with a bow and no arrows left. He says he knows where his chief is camped.`,
      choices: [
        { label: 'Bring him to the tribune', hint: 'gratia +', act(s) { gain(s, 'gratia', 5); return log(s, 'The boy talks. The chief\'s camp is burned two days later, and the tribune mentions your patrol by name.'); } },
        { label: 'Let him go', hint: 'milites +', act(s) { gain(s, 'virtus', 1); if (officer(s)) gain(s, 'milites', 2); return log(s, 'You cut his bonds and point him home. Your men pretend not to see.'); } },
        { label: 'Sell him to the slave dealers', hint: 'denarii +', act(s) { cash(s, 60); return log(s, 'A dealer following the army pays 60 denarii.'); } },
      ],
    },

    // --- the officers: optio to primus pilus -------------------------------------------------
    {
      id: 'deserters_mid', ranks: MID,
      title: 'The deserters of your century',
      text: 'Two men of your own century ran during the last alarm and were caught at a ferry. The legate leaves their punishment to you.',
      choices: [
        { label: 'Have them flogged and returned to duty', hint: 'milites +', act(s) { gain(s, 'milites', 4); return log(s, 'They take forty lashes each and are back in the line within the month. They do not run again.'); } },
        { label: 'Hand them to the legate for execution', hint: 'gratia +, milites −', act(s) { gain(s, 'gratia', 4); gain(s, 'milites', -5); return log(s, 'The legate approves. The century watches them die and looks at you differently.'); } },
        { label: 'Lose the paperwork', hint: 'risky', act(s, r) { if (r() < 0.3) { gain(s, 'gratia', -8); return log(s, 'The camp prefect finds the missing report. He is not amused.'); } gain(s, 'milites', 6); return log(s, 'Somehow the case is never heard. Your men know why.'); } },
      ],
    },
    {
      id: 'mutiny_mid', ranks: MID,
      title: 'The pay is late',
      text: 'Pay is four months late. Your men are talking in the barracks about choosing an emperor who pays, and they are looking at you to see what you will do.',
      choices: [
        { label: 'Lend them money from your own purse', hint: 'milites ++', act(s) { const p = pay(s, 100, 'You advance a month\'s wages out of your own savings. The talk stops.'); if (p.line) gain(s, 'milites', 8); return p.line ?? p.poor; } },
        { label: 'Report the ringleaders', hint: 'gratia ++, milites −', act(s) { gain(s, 'gratia', 8); gain(s, 'milites', -8); return log(s, 'Two men are executed. The legate thanks you. Your men will never trust you again.'); } },
        { label: 'Let them talk', hint: 'milites +, risky', act(s, r) { gain(s, 'milites', 4); if (r() < 0.15) { gain(s, 'gratia', -10); return log(s, 'The tribune hears that your century is the loudest, and that you did nothing.'); } return log(s, 'The pay arrives and the talk dies away.'); } },
      ],
    },
    {
      id: 'rations', ranks: MID,
      title: 'Rotten grain',
      text: 'Your men show you the grain from the latest delivery: weevils in every handful. The contractor, a Syrian merchant called Barsemis, has friends on the governor\'s staff.',
      choices: [
        { label: 'Buy better grain from your own purse (40 denarii)', hint: 'milites +', act(s) { const p = pay(s, 40, 'Fresh bread for a week. Your men notice who paid.'); if (p.line) gain(s, 'milites', 7); return p.line ?? p.poor; } },
        { label: 'Confront Barsemis', hint: 'risky', act(s, r) { if (r() < 0.5) { gain(s, 'milites', 5); cash(s, 30); return log(s, 'Barsemis replaces the grain and slips you 30 denarii to forget it.'); } gain(s, 'gratia', -6); return log(s, 'Barsemis complains to the governor\'s secretary, who complains to your legate.'); } },
        { label: 'Tell the men to stop complaining', hint: 'milites −', act(s) { gain(s, 'milites', -5); gain(s, 'gratia', 1); return log(s, 'They eat it. They do not forget.'); } },
      ],
    },
    {
      id: 'recruits', ranks: MID,
      title: 'Forty recruits',
      text: 'Forty recruits arrive from the villages of the province: half of them sons of veterans who had no choice, a few of them barely seventeen. One has brought his mother.',
      choices: [
        { label: 'Train them yourself', hint: 'milites +, virtus +', act(s) { gain(s, 'milites', 4); gain(s, 'virtus', 2); return log(s, 'Four months of marching, swimming and the wooden sword. You make soldiers of most of them.'); } },
        { label: 'Leave it to the campidoctor', act(s) { return log(s, 'The drill instructor takes them off your hands.'); } },
        { label: 'Sell exemptions to the rich ones', hint: 'denarii +, milites −', act(s) { cash(s, 120); gain(s, 'milites', -4); return log(s, 'Three of the recruits have fathers with money. They spend their service as clerks.'); } },
      ],
    },
    {
      id: 'will', ranks: MID, when: (s) => !threads(s).will,
      title: 'A dying man\'s will',
      text: 'Flavius Celer, a centurion of your cohort, is dying of a fever in the hospital. He asks you to witness his will and see that his savings, 900 denarii in the legion bank, go to his brother in Sirmium.',
      choices: [
        { label: 'Swear to carry it out', hint: 'pietas', act(s) { s.pietas++; gain(s, 'gratia', 2); return log(s, 'You send the money to Sirmium with a letter. His brother writes back to thank you.'); } },
        { label: 'Keep a tenth for your trouble', hint: 'denarii +, risky', act(s) { cash(s, 90); later(s, 'will', 4); return log(s, 'Nobody will miss ninety denarii, you tell yourself.'); } },
      ],
    },
    {
      id: 'will_brother', follow: true, ranks: RANKED, when: (s) => due(s, 'will'),
      title: 'Celer\'s brother',
      text: 'A man in a dusty cloak is waiting at your quarters: Flavius Celer\'s brother, from Sirmium, with a copy of the will and the legion bank\'s receipt. He can count.',
      choices: [
        { label: 'Pay him back, with interest (150 denarii)', act(s) { done(s, 'will'); cash(s, -150); return log(s, 'You pay. He leaves without shaking your hand.'); } },
        { label: 'Deny everything', hint: 'risky', act(s, r) { done(s, 'will'); if (r() < 0.5) { gain(s, 'gratia', -12); return log(s, 'He takes it to the legate, who believes him.'); } return log(s, 'He has no witnesses. He goes home with nothing and a curse for you.'); } },
      ],
    },
    {
      id: 'altar', ranks: MID,
      title: 'An altar to Jupiter',
      text: (s) => `The stonemasons outside ${base(s)} offer to carve you an altar to Jupiter Best and Greatest for the safety of the emperor, with your name and rank on it, to stand in front of headquarters. Every senior centurion has one.`,
      choices: [
        { label: 'Commission it (80 denarii)', hint: 'gratia +', act(s) { const p = pay(s, 80, `"To Jupiter Best and Greatest, for the safety of our lord ${emperorIn(s.year).name}, ${s.name}, ${h.RANKS[s.rank].name}, gladly and deservedly fulfilled his vow."`); if (p.line) { gain(s, 'gratia', 6); s.works++; } return p.line ?? p.poor; } },
        { label: 'Save your money', act(s) { return log(s, 'Let the others show off.'); } },
      ],
    },
    {
      id: 'marriage_mid', ranks: MID, when: (s) => !s.married,
      title: 'A good match',
      text: 'Ulpius Marcellus, a town councillor who supplies the legion with leather, has a widowed daughter and would like a centurion in the family. Her dowry is a farm and a house with a heated floor.',
      choices: [
        { label: 'Marry her', hint: 'denarii +, health +', act(s) { s.married = true; cash(s, 400); heal(s, 10); story(s, 'Married into the family of a town councillor'); return log(s, 'The wedding feast lasts two days. Marcellus starts calling you "my son the centurion".'); } },
        { label: 'Not yet', act(s) { return log(s, 'You thank him and say the army is your wife.'); } },
      ],
    },
    {
      id: 'omens', ranks: MID, when: (s) => s.half === 0 && s.war,
      title: 'The sacred chickens',
      text: 'On the morning of the march, the pullarius reports that the sacred chickens will not eat. The legate asks his senior centurions whether the army should march.',
      choices: [
        { label: '"Throw them in the river. If they will not eat, let them drink."', hint: 'virtus +, risky', act(s, r) { gain(s, 'virtus', 3); if (r() < 0.3) { gain(s, 'gratia', -6); return log(s, 'The legate laughs, but the priests write to Rome about your impiety.'); } gain(s, 'milites', 3); return log(s, 'The men laugh. The army marches, and the gods do not object.'); } },
        { label: 'Advise waiting a day', hint: 'gratia +', act(s) { gain(s, 'gratia', 3); return log(s, 'The chickens eat the next morning. The legate thanks you for your piety.'); } },
      ],
    },
    {
      id: 'customs', ranks: MID,
      title: 'The customs post',
      text: (s) => `You command the post where the road crosses ${river(s)}. A trader called Malchus has four carts covered in hides, and offers you a purse to not look underneath.`,
      choices: [
        { label: 'Take the purse', hint: 'denarii ++, risky', act(s, r) { if (r() < 0.2) { gain(s, 'gratia', -12); return log(s, `Malchus is caught at the next post selling swords to the ${enemy(s)}, and he names you.`); } cash(s, 200); return log(s, 'Two hundred denarii, and you see nothing.'); } },
        { label: 'Search the carts', hint: 'gratia +', act(s) { gain(s, 'gratia', 6); return log(s, `Swords for the ${enemy(s)}. Malchus is sent to the mines, and the governor writes to thank you.`); } },
      ],
    },
    {
      id: 'son', ranks: MIDHIGH, when: (s) => s.married && s.age >= 38 && !threads(s).son,
      title: 'Your son',
      text: 'Your son is fifteen, tall and impatient. He wants to enlist in your legion this year. His mother wants him sent to a grammarian in the city to learn rhetoric.',
      choices: [
        { label: 'Let him enlist', hint: 'milites +', act(s) { threads(s).son = 1; gain(s, 'milites', 3); story(s, 'His son enlisted'); return log(s, 'He swears the oath in front of you. The men call him "the little centurion".'); } },
        { label: 'Pay for the grammarian (200 denarii)', hint: 'pietas', act(s) { threads(s).son = 1; const p = pay(s, 200, 'He goes to the city with a slave to carry his books. His letters home improve.'); if (p.line) s.pietas += 2; return p.line ?? p.poor; } },
      ],
    },

    // --- the commanders: camp prefect to dux --------------------------------------------------
    {
      id: 'deserters_high', ranks: HIGH,
      title: 'Desertion',
      text: 'Forty men of a frontier cohort have deserted together and are living as bandits in the hills. The governor wants an example made. You command the province\'s troops.',
      choices: [
        { label: 'Hunt them down and decimate them', hint: 'gratia +, milites −', act(s) { gain(s, 'gratia', 5); gain(s, 'milites', -6); return log(s, 'The hills are cleared. One in ten is executed in front of the army.'); } },
        { label: 'Offer a pardon if they come back', hint: 'milites +, risky', act(s, r) { gain(s, 'milites', 5); if (r() < 0.4) { gain(s, 'gratia', -6); return log(s, 'Half come back. The governor writes to Rome that you are soft.'); } return log(s, 'They come back to a man and fight well in the next campaign.'); } },
      ],
    },
    {
      id: 'governor', ranks: HIGH, when: (s) => !threads(s).feud,
      title: 'The governor',
      text: 'The governor of the province, the senator Clodius Celsinus, blames you in a letter to the emperor for the loss of a border fort. The fort was lost because he refused to send you the men you asked for.',
      choices: [
        { label: 'Write to the emperor yourself', hint: 'risky', act(s) { later(s, 'feud', 3); return log(s, 'You send the emperor your own letter, with copies of your requests and the governor\'s refusals.'); } },
        { label: 'Swallow it, and send Celsinus a gift', hint: '300 denarii', act(s) { const p = pay(s, 300, 'A silver dinner service. Celsinus writes a second letter withdrawing the first.'); if (!p.line) gain(s, 'gratia', -8); return p.line ?? log(s, 'With nothing to soften him, his complaint stands.'); } },
      ],
    },
    {
      id: 'governor_inquiry', follow: true, ranks: HIGH, when: (s) => due(s, 'feud'),
      title: 'The inquiry',
      text: 'An imperial commissioner has come to settle your quarrel with the governor Celsinus. Both of your letters lie on the table in front of him.',
      choices: [
        { label: 'Bring the fort\'s survivors as witnesses', hint: 'gratia + or −', act(s, r) { done(s, 'feud'); if (r() < 0.6) { gain(s, 'gratia', 10); return log(s, 'The survivors tell the story. Celsinus is recalled to Rome in disgrace.'); } gain(s, 'gratia', -10); return log(s, 'The commissioner is Celsinus\'s cousin. You lose.'); } },
        { label: 'Bribe the commissioner (600 denarii)', hint: 'risky', act(s, r) { done(s, 'feud'); const p = pay(s, 600, 'The commissioner finds for you.'); if (!p.line) { gain(s, 'gratia', -10); return log(s, 'You have nothing to offer him, and he finds for the governor.'); } if (r() < 0.2) { gain(s, 'gratia', -15); return log(s, 'He takes your money and finds for the governor anyway.'); } gain(s, 'gratia', 6); return p.line; } },
      ],
    },
    {
      id: 'envoys', ranks: HIGH,
      title: 'Envoys',
      text: (s) => `Envoys of the ${enemy(s)} are waiting outside your headquarters with gifts: furs, amber and a fine horse. They offer peace on the frontier for a yearly payment of gold.`,
      choices: [
        { label: 'Pay them, and buy time', hint: 'denarii −, safer frontier', act(s) { const p = pay(s, 500, 'They ride home happy. The frontier is quiet, and the emperor need never know the price.'); if (p.line) s.war = false; return p.line ?? log(s, 'You cannot pay what they ask. They ride home angry.'); } },
        { label: 'Send them home with nothing', hint: 'virtus +', act(s) { gain(s, 'virtus', 4); gain(s, 'milites', 2); return log(s, '"Rome pays in iron." The men cheer when they hear what you said.'); } },
        { label: 'Demand hostages, and their chief\'s sons', hint: 'gratia +, risky', act(s, r) { if (r() < 0.5) { gain(s, 'gratia', 8); return log(s, 'They agree. Three young princes go to Rome to be educated as Romans.'); } s.war = true; gain(s, 'virtus', 2); return log(s, 'They take it as an insult. War comes in the spring.'); } },
      ],
    },
    {
      id: 'grain_high', ranks: HIGH,
      title: 'The grain fleet is late',
      text: 'Storms have held the grain barges, and the army has eleven days of bread left. The cities of the province have full granaries and an exemption from the emperor.',
      choices: [
        { label: 'Seize the city granaries', hint: 'milites +, gratia −', act(s) { gain(s, 'milites', 6); gain(s, 'gratia', -6); return log(s, 'The men eat. The city councils send a delegation to the emperor.'); } },
        { label: 'Buy grain at famine prices (400 denarii)', act(s) { const p = pay(s, 400, 'You pay three times the usual price out of your own funds.'); if (p.line) gain(s, 'milites', 3); else gain(s, 'milites', -6); return p.line ?? log(s, 'You cannot pay. The men go hungry for a week.'); } },
        { label: 'Cut rations and wait', hint: 'milites −', act(s) { gain(s, 'milites', -6); return log(s, 'The barges arrive on the tenth day. The men do not forget the hunger.'); } },
      ],
    },
    {
      id: 'conspiracy', ranks: HIGH,
      title: 'A tribune\'s proposal',
      text: (s) => `Over dinner, the tribune Aelius Mucianus says what others only whisper: that ${emperorIn(s.year).name} will not last the year, and that the army could do better. He watches you as he says it.`,
      choices: [
        { label: 'Hear him out', hint: 'treason, milites +', act(s) { s.plot++; gain(s, 'milites', 3); return log(s, 'He names three legates who would follow you. You say nothing, but you do not report him.'); } },
        { label: 'Report him to the emperor', hint: 'gratia ++', act(s) { gain(s, 'gratia', 10); gain(s, 'milites', -3); return log(s, 'Mucianus is arrested at dawn. The emperor writes to thank you in his own hand.'); } },
        { label: 'Change the subject', act(s) { return log(s, 'You talk about horses for the rest of the evening.'); } },
      ],
    },
    {
      id: 'levy', ranks: HIGH,
      title: 'The emperor wants men',
      text: (s) => `${emperorIn(s.year).name} is gathering an army for a campaign on another frontier and orders you to send him your best cohorts.`,
      choices: [
        { label: 'Send the best', hint: 'gratia +, milites −', act(s) { gain(s, 'gratia', 6); gain(s, 'milites', -4); return log(s, 'Your veterans march away. The emperor praises your loyalty.'); } },
        { label: 'Send the sick and the recruits', hint: 'milites +, risky', act(s, r) { gain(s, 'milites', 3); if (r() < 0.4) { gain(s, 'gratia', -10); return log(s, 'The emperor\'s staff sees what you sent him.'); } return log(s, 'Nobody at court counts the scars.'); } },
      ],
    },
    {
      id: 'games_high', ranks: HIGH,
      title: 'Games for the army',
      text: (s) => `It is the anniversary of ${emperorIn(s.year).name}'s accession. The amphitheatre at ${base(s)} can hold the whole army, if someone pays for the beasts and the gladiators.`,
      choices: [
        { label: 'Pay for three days of games (500 denarii)', hint: 'milites ++', act(s) { const p = pay(s, 500, 'Bears from the mountains, a lion from Africa, and a pair of famous gladiators. Your name is on every lip.'); if (p.line) gain(s, 'milites', 9); return p.line ?? p.poor; } },
        { label: 'Hold a sacrifice and a parade instead', act(s) { gain(s, 'gratia', 2); return log(s, 'Correct and cheap.'); } },
      ],
    },
    {
      id: 'walls', ranks: HIGH,
      title: 'The town has no walls',
      text: (s) => `The town outside ${base(s)} grew up in the long peace and has no walls. The council asks you to lend soldiers to build them, since raiders now come every year.`,
      choices: [
        { label: 'Lend them a cohort for the summer', hint: 'lasting fame', act(s) { s.works += 2; gain(s, 'gratia', 3); return log(s, 'By autumn there is a wall, two gates and an inscription with your name on it.'); } },
        { label: 'Refuse: the army has its own work', act(s) { return log(s, 'The council grumbles and hires masons.'); } },
      ],
    },

    // --- anyone in the ranks or above ----------------------------------------------------------
    {
      id: 'home', ranks: LOWMID,
      title: 'A letter from home',
      text: (s) => `A letter on papyrus, written for your mother by the village scribe. The harvest failed, the tax collector came anyway, and your brother has run away to ${s.age > 30 ? 'join the fleet' : 'be a gladiator'}.`,
      choices: [
        { label: 'Send her money', hint: 'pietas', act(s) { const n = officer(s) ? 150 : 40; const p = pay(s, n, `You send ${n} denarii home with a trader you trust.`, 'You send what little you have, and a promise.'); if (p.line) s.pietas++; return p.line ?? p.poor; } },
        { label: 'Write back with news, but no money', act(s) { return log(s, 'You write about the weather and the food and say nothing about money.'); } },
      ],
    },
    {
      id: 'mithras', ranks: RANKED, when: (s) => !s.mithras,
      title: 'The cave of Mithras',
      text: (s) => (s.rank >= R.castrorum
        ? 'The officers of the legion meet in a cave temple outside the walls to eat before the god who slays the bull. They would be honoured if the camp prefect would join them as a Father of the mysteries.'
        : 'An optio invites you to a cave temple outside the walls, where officers and men eat together on stone benches before the god who slays the bull. Some of the brothers outrank you.'),
      choices: [
        { label: 'Be initiated (20 denarii)', hint: 'gratia +', act(s) { const p = pay(s, 20, 'Blindfolded, you take the oath of the Raven in the dark. Your new brothers greet you by name.'); if (p.line) { s.mithras = true; gain(s, 'gratia', 6); } return p.line ?? p.poor; } },
        { label: 'Keep to the gods of your fathers', act(s) { s.mithras = true; return log(s, 'You politely decline.'); } },
      ],
    },
    {
      id: 'wife', ranks: LOW, when: (s) => !s.married && s.age >= 21,
      title: 'In the camp town',
      text: 'Soldiers may marry now, since Severus allowed it. In the camp town there is a woman named Aurelia Severa whose father sells wine to the legion, and she has started saving you a cup.',
      choices: [
        { label: 'Marry her', hint: 'health +', act(s) { s.married = true; heal(s, 15); cash(s, 40); story(s, 'Married Aurelia Severa'); return log(s, 'You marry. Her dowry is a small vineyard and her cooking is better than the army\'s.'); } },
        { label: 'Not yet', act(s) { return log(s, 'You are married to the eagles for now.'); } },
      ],
    },
    {
      id: 'fever', ranks: RANKED,
      title: 'Fever',
      text: (s) => (s.rank >= R.castrorum ? 'You wake shaking with fever. Your physician, a Greek from Pergamum, wants to bleed you; the legion\'s medicus wants to give you wormwood and send you to bed.' : 'You wake shaking with fever. The hospital is full and the medicus is tired.'),
      choices: [
        { label: 'Pay for a physician', hint: 'denarii −', act(s) { cash(s, s.rank >= R.castrorum ? -60 : -15); return wounded(s, 5, 'Died of fever', 'Bitter herbs and bed rest. You recover.'); } },
        { label: 'Sweat it out', act(s) { return wounded(s, 22, 'Died of fever', 'It takes weeks to get your strength back.'); } },
      ],
    },
    {
      id: 'games', ranks: LOWMID,
      title: 'Games in the amphitheatre',
      text: 'The governor is putting on games in the legion\'s amphitheatre. The star is a murmillo called Pugnax, who has won seventeen fights, against a young Thracian nobody has heard of.',
      choices: [
        { label: 'Bet 50 denarii on Pugnax', act(s, r) { if (s.denarii < 50) return log(s, 'You have nothing to bet, so you cheer.'); const w = r() < 0.6; cash(s, w ? 25 : -50); return log(s, w ? 'Pugnax wins. The odds were short, but you collect.' : 'The Thracian puts Pugnax down in the first exchange. So much for your money.'); } },
        { label: 'Bet 50 denarii on the Thracian', act(s, r) { if (s.denarii < 50) return log(s, 'You have nothing to bet, so you cheer.'); const w = r() < 0.35; cash(s, w ? 100 : -50); return log(s, w ? 'The Thracian wins! You collect 150 denarii.' : 'Pugnax wins in a minute. Your money is gone.'); } },
        { label: 'Just watch', act(s) { return log(s, 'A good day out.'); } },
      ],
    },
    {
      id: 'lender', ranks: LOWMID, when: (s) => s.debt === 0,
      title: 'A moneylender',
      text: 'Iulius Pudens, a retired optio, lends money to soldiers at interest and collects it from the paymaster on payday, before the borrower ever sees his wages.',
      choices: [
        { label: 'Borrow 150 denarii', hint: 'repay 200', act(s) { cash(s, 150); s.debt = 200; return log(s, 'You borrow 150 denarii. Pudens will take 200 out of your pay.'); } },
        { label: 'No thanks', act(s) { return log(s, 'You stay out of debt.'); } },
      ],
    },
    {
      id: 'stars', ranks: RANKED, when: (s) => !s.omen,
      title: 'An astrologer',
      text: 'A Chaldaean astrologer with a brass star chart sets up his table in the camp town. He says he cast the horoscope of Maximinus himself, before anyone had heard of him.',
      choices: [
        { label: 'Pay 10 denarii for a reading', act(s, r) { cash(s, -10); s.omen = true; if (r() < 0.3) { gain(s, 'milites', 6); return log(s, 'He goes pale and whispers that he sees purple in your stars. By evening the whole camp has heard.'); } return log(s, 'He promises a long life and many sons.'); } },
        { label: 'Laugh him off', act(s) { s.omen = true; return log(s, 'You laugh. He curses you, mildly.'); } },
      ],
    },
    {
      id: 'rival', ranks: LOWMID,
      title: 'A rival',
      text: (s) => `${h.RIVALS[(s.turn * 7) % h.RIVALS.length]}, who wants the same promotion you do, is telling the officers you were drunk on watch.`,
      choices: [
        { label: 'Confront him', hint: 'virtus +', act(s, r) { gain(s, 'virtus', 3); if (r() < 0.3) return wounded(s, 10, 'Killed in a brawl', 'It comes to fists. You both spend a night in the guardhouse.'); return log(s, 'He backs down in front of everyone.'); } },
        { label: 'Outshine him with the officers (30 denarii)', act(s) { const p = pay(s, 30, 'A few dinners, and the story is forgotten.'); if (p.line) gain(s, 'gratia', 3); else gain(s, 'gratia', -3); return p.line ?? log(s, 'You have nothing to outshine him with.'); } },
        { label: 'Ignore it', act(s) { gain(s, 'gratia', -4); return log(s, 'The story spreads.'); } },
      ],
    },
    {
      id: 'rival_high', ranks: HIGH,
      title: 'A rival general',
      text: 'Cassius Licinus, who commands the next province, has written to the emperor that you are slow, timid and too friendly with your men. A friend at court sends you a copy.',
      choices: [
        { label: 'Win a victory to answer him', hint: 'virtus +, risky', act(s, r) { gain(s, 'virtus', 4); if (r() < 0.15) return wounded(s, 25, 'Killed on a raid he led to answer his critics', 'You lead a raid across the frontier yourself and come back with a spear wound and a column of prisoners.'); gain(s, 'gratia', 4); return log(s, 'You raid across the frontier and send the emperor the captured standards.'); } },
        { label: 'Send gifts to the emperor\'s friends (300 denarii)', act(s) { const p = pay(s, 300, 'Your friends at court make sure Licinus\'s letter is read with a smile.'); if (p.line) gain(s, 'gratia', 4); else gain(s, 'gratia', -5); return p.line ?? log(s, 'With nothing to send, his letter does its work.'); } },
      ],
    },
    {
      id: 'snow', ranks: LOWMID, when: (s) => s.half === 1 && ['rhine', 'danube', 'britannia'].includes(front(s)),
      title: 'A hard winter',
      text: (s) => `Snow buries the fort at ${base(s)} to the top of the rampart, and the firewood is running out.`,
      choices: [
        { label: (s) => (officer(s) ? 'Share your own firewood with your men' : 'Share your firewood with the tent group'), hint: 'milites +, health −', act(s) { gain(s, 'milites', 4); return wounded(s, 6, 'Died of cold', 'You get through it together.'); } },
        { label: 'Keep warm', act(s) { heal(s, 5); return log(s, 'You keep your own fire going.'); } },
      ],
    },
    {
      id: 'raid', ranks: LOWMID, when: (s) => s.half === 1 && ['rhine', 'danube'].includes(front(s)),
      title: 'The river freezes',
      text: (s) => `${river(s)[0].toUpperCase()}${river(s).slice(1)} has frozen solid, and ${enemy(s)} are crossing on the ice at night to burn the farms on the Roman bank.`,
      choices: [
        { label: (s) => (officer(s) ? 'Lead your men after them' : 'Volunteer for the pursuit'), hint: 'virtus +, danger', act(s, r) { gain(s, 'virtus', 7); const x = r(); if (x < 0.03) return die(s, 'Killed chasing raiders across the ice'); if (x < 0.2) return wounded(s, 15, 'Died of wounds from a winter raid', 'You catch them on the ice, and pay for it.'); return log(s, 'You catch them before they reach the far bank and bring back the cattle.'); } },
        { label: 'Hold the walls', act(s) { gain(s, 'virtus', 1); return log(s, 'You hold the walls and watch the farms burn.'); } },
      ],
    },
    {
      id: 'coins', ranks: RANKED, when: (s) => s.year >= 258 && !s.debased,
      title: 'The new coins',
      text: 'The new silver coins are barely silver at all: bronze with a wash that rubs off on your fingers. Prices in the camp town double in a month.',
      choices: [
        { label: 'Buy gold now, at a loss', hint: 'lose 10%', act(s) { s.debased = true; cash(s, -s.denarii * 0.1); return log(s, 'You turn your savings into a handful of gold aurei and sew them into your belt.'); } },
        { label: 'Hope it passes', hint: 'lose 30%', act(s) { s.debased = true; cash(s, -s.denarii * 0.3); return log(s, 'It does not pass. Your savings are worth far less.'); } },
      ],
    },
    {
      id: 'patron', ranks: RANKED, when: (s) => s.stats.gratia >= 25,
      title: 'Your patron dies',
      text: 'The man who has been speaking for you to those above is dead of a fever, and his friends are already looking for other friends.',
      choices: [
        { label: 'Find a new patron fast', hint: 'denarii −', act(s) { const n = s.rank >= R.castrorum ? 300 : 50; const p = pay(s, n, 'Gifts to a new patron, who agrees to remember you.'); gain(s, 'gratia', p.line ? -4 : -12); return p.line ?? log(s, 'You have nothing to offer a new patron.'); } },
        { label: 'Mourn him and start again', act(s) { gain(s, 'gratia', -12); return log(s, 'You walk in his funeral procession.'); } },
      ],
    },
    {
      id: 'hunt', ranks: MIDHIGH,
      title: 'A boar hunt',
      text: (s) => (s.rank >= R.castrorum ? 'The governor is hunting boar in the forest with his friends, and you are invited.' : 'The tribunes are hunting boar in the forest, and for once a centurion is invited.'),
      choices: [
        { label: 'Join the hunt', hint: 'gratia +, small danger', act(s, r) { gain(s, 'gratia', 5); if (r() < 0.1) return wounded(s, 20, 'Killed by a boar', 'The boar gets you in the thigh before you get it.'); return log(s, 'You make the kill, and the boar\'s head is carried back in front of you.'); } },
        { label: 'Stay in camp', act(s) { return log(s, 'You stay in camp.'); } },
      ],
    },

    // --- the emperor ---------------------------------------------------------------------------
    {
      id: 'plot', ranks: EMPEROR,
      title: 'A list of names',
      text: 'Your freedman hands you a wax tablet he found in the latrine of the palace: a list of names, officers of your own guard, with a date.',
      choices: [
        { label: 'Execute them all', hint: 'gratia −, safer', act(s) { gain(s, 'gratia', -6); gain(s, 'milites', -3); return log(s, 'The list is shorter now, and so is your list of friends.'); } },
        { label: 'Pay them off', hint: '800 denarii', act(s) { cash(s, -800); gain(s, 'milites', 5); return log(s, 'Gold buys loyalty, for a while.'); } },
        { label: 'Ignore it', act(s, r) { if (r() < 0.35) return die(s, `Murdered by his own guard after ${reignWords(s)} as emperor`); return log(s, 'Nothing happens. Perhaps the list was false.'); } },
      ],
    },
    {
      id: 'usurper', ranks: EMPEROR,
      title: 'A rival emperor',
      text: 'A general on another frontier has been hailed by his troops and is striking coins with his own face. Two provinces have already gone over to him.',
      choices: [
        { label: 'March against him', hint: 'virtus +, danger', act(s, r) { if (r() < 0.12) return die(s, `Killed in civil war after ${reignWords(s)} as emperor`); gain(s, 'virtus', 6); gain(s, 'milites', 4); s.works++; return log(s, 'His army goes over to you before the battle, and brings you his head.'); } },
        { label: 'Offer him a share of the empire', hint: 'gratia −, safer', act(s) { gain(s, 'gratia', -6); return log(s, 'He accepts the title of Caesar and the West. For now.'); } },
      ],
    },
    {
      id: 'coinage', ranks: EMPEROR,
      title: 'Your coins',
      text: 'The mint master asks what your new coins should say. The army reads coins more closely than it reads proclamations.',
      choices: [
        { label: '"The loyalty of the army"', hint: 'milites +', act(s) { gain(s, 'milites', 4); return log(s, 'FIDES MILITVM: soldiers clasping hands around a standard.'); } },
        { label: '"Restorer of the world"', hint: 'lasting fame', act(s) { s.works++; return log(s, 'RESTITVTOR ORBIS: you raise a kneeling woman, the world, to her feet.'); } },
        { label: '"Unconquered Sun, my companion"', hint: 'gratia +', act(s) { gain(s, 'gratia', 4); return log(s, 'SOLI INVICTO COMITI: the sun god hands you a globe.'); } },
      ],
    },
    {
      id: 'heir', ranks: EMPEROR, when: (s) => !threads(s).heir,
      title: 'An heir',
      text: 'Your friends say an emperor without an heir is an invitation to murder. You could name a colleague as Caesar to share the burden and the risk.',
      choices: [
        { label: 'Name a trusted general as Caesar', hint: 'safer, gratia +', act(s) { threads(s).heir = 1; gain(s, 'gratia', 5); gain(s, 'milites', 3); return log(s, 'You choose a hard-bitten Danubian like yourself. The army approves.'); } },
        { label: 'Rule alone', act(s) { threads(s).heir = 1; return log(s, 'You will share the purple with no one.'); } },
      ],
    },
  ];
}
