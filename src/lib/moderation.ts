// ============================================================
// Kifaayat content moderation engine (V1) — TS port of kifaayat_moderation.py
//
// Applies to comments, private messages, listing descriptions, review text,
// and any free-text field. Returns:
//   BLOCK  — reject the submission (show a generic reason).
//   REVIEW — allow but flag to the moderation queue (soft signal).
//   ALLOW  — clean.
//
// Obfuscation (leet, repeats, accents, spacing, masking) is handled by
// normalisation, not by enumerating spellings. Phone/number detection is
// guarded against sizes/prices/measurements. Payment-app names are REVIEW
// (Stripe/PayPal/Wise are legit payout rails), not BLOCK.
// ============================================================

export type Verdict = "BLOCK" | "REVIEW" | "ALLOW";
export interface ModReason {
  category: string;
  tier: "BLOCK" | "REVIEW";
  match: string;
}
export interface ModResult {
  verdict: Verdict;
  reasons: ModReason[];
}

// ---- 1. WORDLISTS ----
const PROFANITY = [
  "fuck","fucker","fucked","fucking","fuckin","motherfucker","mofo",
  "shit","shite","shitty","bullshit","bullshitter","horseshit",
  "bitch","bitches","bitching","son of a bitch",
  "bastard","bollocks","bugger","wanker","wank","tosser","twat",
  "prick","knob","knobhead","dickhead","dick","dickwad","cock",
  "arse","arsehole","asshole","ass","asses","jackass","dumbass",
  "piss","pissed","pissing","pisshead",
  "crap","crappy","dipshit","shithead","shitshow","shitbag",
  "douche","douchebag","scumbag","sleazebag","git","minger",
  "goddamn","goddamned","damn","damned","dammit","hell","bloody hell",
];
const SLURS_HATE = [
  "nigger","nigga","niggah","coon","spic","wetback","beaner",
  "chink","gook","jap","slope","wog","gyppo","gypo","pikey",
  "paki","pakis","curry muncher","dot head","dothead","raghead",
  "towelhead","sand nigger","abcd",
  "kike","yid","heeb","hymie",
  "islamist pig","mudslime","mussie","durka",
  "chamar","bhangi","chuhra","chura","achut","neech jaat",
  "faggot","faggots","fag","fags","dyke","tranny","trannie",
  "shemale","he-she","homo","queer bait",
  "retard","retarded","spastic","spaz","mongoloid","cripple","midget",
];
const SEXUAL = [
  "cunt","pussy","pussies","clit","clitoris","vagina","penis",
  "cum","cumming","jizz","jerk off","jack off","blowjob","blow job",
  "handjob","rimjob","deepthroat","cumshot","creampie","gangbang",
  "boobs","boobies","titties","titty","tits","nipple","nipples",
  "horny","milf","gilf","slut","slutty","whore","hoe","thot",
  "porn","porno","pornhub","xxx","nsfw","nudes","send nudes",
  "sexy time","hook up","fuck buddy","one night stand","escort service",
  "sugar daddy","sugar baby","onlyfans","only fans","fansly",
  "dick pic","nude pic","sext","sexting",
];
const THREATS = [
  "kill you","kill yourself","kys","i will kill","gonna kill",
  "i'll kill","hunt you down","find you","beat you up","beat the shit",
  "rape","raped","rapist","molest","die bitch","die slut",
  "burn your house","watch your back","you're dead","youre dead",
  "i know where you live","come to your house","slit your throat",
  "bash you","smash your face","acid attack","throw acid",
  "stalk you","scam you","expose you","leak your","dox you","doxx",
];
const DESI_ABUSE = [
  "madarchod","madarchild","mc","bhenchod","behenchod","bhosdike",
  "bhosdi","bhosda","bsdk","bkl","bakland","bakchod","bakchodi",
  "chutiya","chutiye","chutya","chut","gaandu","gandu","gaand",
  "gand","lauda","lund","lawda","loda","lodu","randi","raand",
  "randibaaz","harami","haramzada","haramzadi","harampna","kutta",
  "kutti","kutte","kaminey","kamina","kameena","kanjar","chinaal",
  "chinal","tatti","gadha","suar","suvar","saala","saali","kutiya",
  "bhadwa","bhadva","dalla","chakka","hijra insult","napunsak",
  "jhaant","jhant","jhatu","chodu","chod","chodna","gaandmasti",
  "teri maa","teri ma","maa ki","maa chuda","behen ke",
  "pehnchod","phuddu","phudu","gasti","kanjri","bhen di",
  "gaandu su","bhosad",
  "banchod","magi","khanki","chudir","boka choda",
  "punda","poolu","thevidiya","sunni","koodhi","modda",
];
const MILD = [
  "damn","damned","dammit","hell","crap","crappy","bloody",
  "bugger","git","sod off","screw you","screwed",
];
const PAYMENT_TERMS = [
  "paypal","pay pal","venmo","cashapp","cash app","zelle","beem",
  "beem it","payid","pay id","osko","bank transfer","direct deposit",
  "bsb","account number","acc number","acc no","e-transfer",
  "etransfer","interac","revolut","monzo","wise","western union",
  "remitly","upi","gpay","g pay","google pay","phonepe","phone pe",
  "paytm","send money",
];
const OFF_PLATFORM = [
  "off the app","off app","off platform","off-platform","off the site",
  "outside the app","outside the platform","outside kifaayat",
  "avoid fees","avoid the fee","save on fees","no fees","without fees",
  "cheaper directly","cheaper direct","buy direct","buy directly",
  "sell direct","sell directly","direct sale","deal directly",
  "contact me directly","reach me","reach out to me","text me",
  "call me","ring me","message me on","msg me on","hit me up",
  "email me","dm me","pm me","slide into","add me on","follow me on",
  "find me on","my number is","my mobile is","my cell","my phone number",
  "here is my number","heres my number","whatsapp me","hmu",
  "pay directly","pay me directly","pay you directly","paid directly",
  "my paypal","my venmo","your paypal","pay outside","pay off app",
  "my snap","my insta","my ig","my instagram","my tiktok","my discord",
  "my telegram","my handle","my username","add my","snap is","insta is",
];
const PLATFORM_NAMES = [
  "instagram","insta","instagrm","ig handle","the gram","snapchat",
  "snap chat","add my snap","tiktok","tik tok","facebook","fb dot com",
  "messenger","whatsapp","whats app","wsp","watsapp","telegram",
  "signal app","kik","viber","wechat","we chat","discord",
  "linktree","linktr","beacons page",
];
const PLATFORM_SHORT = ["ig","fb","sc","tt","wa","dm","dms","pm","tg","insta"];

const CATEGORIES: Array<[string, string[], "BLOCK" | "REVIEW"]> = [
  ["profanity", PROFANITY, "BLOCK"],
  ["slur_hate", SLURS_HATE, "BLOCK"],
  ["sexual", SEXUAL, "BLOCK"],
  ["threat", THREATS, "BLOCK"],
  ["desi_abuse", DESI_ABUSE, "BLOCK"],
  ["off_platform", OFF_PLATFORM, "BLOCK"],
  ["platform_name", PLATFORM_NAMES, "BLOCK"],
  ["mild", MILD, "REVIEW"],
  ["payment", PAYMENT_TERMS, "REVIEW"],
];

// ---- 2. FALSE-POSITIVE GUARDS ----
const ALLOW_SUBSTR = [
  "scunthorpe","penistone","sussex","cockburn","hancock","hitchcock",
  "peacock","cockpit","cockatoo","cockerel","shuttlecock","class",
  "classic","glass","brass","grass","compass","passion","passport",
  "assassin","assess","assemble","assembly","assist","assign",
  "associate","assorted","assure","embarrass","harassment","harass",
  "analysis","analyst","cumin","circumstance","accumulate","document",
  "arsenal","arsenic","shiitake","dickens","dickinson","titan",
  "constitute","matriculate",
];
const MEASURE_UNITS =
  'cm|mm|m|in|inch|inches|"|ft|feet|kg|kgs|g|gram|grams|lb|lbs|oz|' +
  "ml|l|litre|litres|size|us|uk|eu|au|nz|bust|waist|hip|hips|length|" +
  "shoulder|sleeve|chest|inseam|yr|yrs|year|years|month|months";

// ---- 3. NORMALISATION ----
const LEET_MAP: Record<string, string> = {
  "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","8":"b","9":"g",
  "@":"a","$":"s","!":"i","|":"i","+":"t","(":"c","€":"e","£":"l",
};

function fold(text: string): string {
  let t = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.toLowerCase();
  t = t.replace(/./g, (c) => LEET_MAP[c] ?? c);
  t = t.replace(/(.)\1{2,}/g, "$1$1"); // fuuuuck -> fuuck
  return t;
}
function lettersOnly(text: string): string {
  return fold(text).replace(/[^a-z]/g, "");
}

// ---- 4. NUMBER-WORD NORMALISATION (spelled-out phone evasion) ----
const ONES: Record<string, string> = {
  zero:"0",oh:"0",o:"0",nought:"0",naught:"0",
  one:"1",two:"2",three:"3",four:"4",five:"5",
  six:"6",seven:"7",eight:"8",nine:"9",
};
const TEENS: Record<string, string> = {
  ten:"10",eleven:"11",twelve:"12",thirteen:"13",fourteen:"14",
  fifteen:"15",sixteen:"16",seventeen:"17",eighteen:"18",nineteen:"19",
};
const TENS: Record<string, string> = {
  twenty:"2",thirty:"3",forty:"4",fifty:"5",sixty:"6",seventy:"7",eighty:"8",ninety:"9",
};
const MULT: Record<string, number> = { double:2, triple:3, treble:3, quadruple:4 };
const NUMWORDS = new Set([...Object.keys(ONES), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(MULT)]);

function convertNumberWords(text: string): { converted: string; maxRun: number } {
  const tokens = text.toLowerCase().match(/[a-z]+|[^a-z]+/g) || [];
  const out: string[] = [];
  let i = 0;
  let maxRun = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!NUMWORDS.has(tok)) { out.push(tok); i++; continue; }
    let digits = ""; let wordsUsed = 0; let mult: number | null = null;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t in MULT) { mult = MULT[t]; wordsUsed++; i++; continue; }
      if (t in TENS) {
        const d = TENS[t];
        let j = i + 1;
        if (j < tokens.length && !/^[a-z]+$/.test(tokens[j].trim())) j++;
        if (j < tokens.length && tokens[j] in ONES && tokens[j] !== "oh" && tokens[j] !== "o") {
          digits += d + ONES[tokens[j]]; wordsUsed += 2; i = j + 1;
        } else { digits += d + "0"; wordsUsed++; i++; }
        mult = null; continue;
      }
      if (t in TEENS) { digits += TEENS[t]; wordsUsed++; i++; mult = null; continue; }
      if (t in ONES) { digits += ONES[t].repeat(mult || 1); wordsUsed++; i++; mult = null; continue; }
      if (!/^[a-z]+$/.test(t.trim())) {
        const nxt = i + 1 < tokens.length ? tokens[i + 1] : "";
        if (NUMWORDS.has(nxt)) { i++; continue; }
      }
      break;
    }
    out.push(digits);
    maxRun = Math.max(maxRun, wordsUsed);
  }
  return { converted: out.join(""), maxRun };
}

// ---- 5. STRUCTURAL DETECTORS ----
const TLD =
  "com|net|org|co|io|in|pk|bd|lk|np|me|xyz|shop|store|link|app|gg|tv|to|" +
  "ly|be|uk|au|nz|ca|us|info|biz|online|site|page|bio|ee";
const RE_URL = new RegExp(
  "(https?://\\S+" +
  "|www\\.\\S+" +
  "|\\b[a-z0-9][a-z0-9-]{1,}\\.(?:" + TLD + ")\\b(?:/\\S*)?" +
  "|\\b[a-z0-9-]+\\s*(?:\\.|\\(dot\\)|\\[dot\\]|\\bdot\\b)\\s*(?:" + TLD + ")\\b)",
  "gi",
);
const RE_EMAIL = new RegExp(
  "([a-z0-9._%+\\-]+\\s*(?:@|\\(at\\)|\\[at\\]|\\bat\\b|at the rate)\\s*" +
  "[a-z0-9.\\-]+\\s*(?:\\.|\\(dot\\)|\\[dot\\]|\\bdot\\b)\\s*[a-z]{2,})",
  "gi",
);
const RE_HANDLE = /(?<![\w.])@[a-z0-9._]{2,30}\b/gi;
const RE_PHONE_REGIONAL = new RegExp(
  "(\\+?\\s*(?:61|64|1|44|91|92)[\\s.\\-]*\\(?\\d[\\d\\s.\\-]{6,}\\d" +
  "|\\b0\\d[\\d\\s.\\-]{6,}\\d" +
  "|\\(\\d{2,4}\\)[\\s.\\-]*\\d[\\d\\s.\\-]{5,}\\d)",
  "g",
);
const PHONE_MIN_DIGITS = 7;
const WORDNUM_BLOCK_RUN = 5;
const WORDNUM_REVIEW_RUN = 3;

function looksLikeMeasureOrPrice(segment: string): boolean {
  if (/[$£€₹]\s*\d/.test(segment)) return true;
  if (/\b\d[\d,]*\.\d{1,2}\b/.test(segment)) return true;
  if (new RegExp("\\b\\d+\\s*(?:" + MEASURE_UNITS + ")\\b", "i").test(segment)) return true;
  return false;
}
function* digitRuns(text: string): Generator<{ digits: string; span: [number, number]; raw: string }> {
  const re = /\d[\d\s().\-]{5,}\d/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    yield { digits: m[0].replace(/\D/g, ""), span: [m.index, m.index + m[0].length], raw: m[0] };
  }
}

// ---- 6. MATCHER ----
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compileWordlist(words: string[]): RegExp {
  const esc = [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRe(w.toLowerCase()).replace(/\\ /g, "\\s+"));
  return new RegExp("\\b(?:" + esc.join("|") + ")\\b", "gi");
}
const COMPILED: Record<string, RegExp> = {};
for (const [name, words] of CATEGORIES) COMPILED[name] = compileWordlist(words);
const SHORT_RE = compileWordlist(PLATFORM_SHORT);

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const LEET_VARIANTS: Record<string, string> = {
  a:"a@4",e:"e3",i:"i1!|",o:"o0",u:"uv",s:"s5$",t:"t7+",b:"b8",g:"g9",l:"l1|",c:"c(",
};
function maskRegex(term: string): RegExp {
  const parts: string[] = [];
  for (const ch of term) {
    let variants = LEET_VARIANTS[ch] ?? ch;
    if (VOWELS.has(ch)) variants += "*#";
    const cls = [...new Set(variants)].map((c) => escapeRe(c)).join("");
    parts.push(VOWELS.has(ch) ? `[${cls}]?` : `[${cls}]`);
    parts.push("[\\W_0-9]*");
  }
  return new RegExp("\\b" + parts.join("") + "\\b", "i");
}
const MASK_TERMS = [
  ...new Set([...PROFANITY, ...SLURS_HATE, ...SEXUAL, ...DESI_ABUSE].filter((w) => !w.includes(" ") && w.length >= 4)),
].sort((a, b) => b.length - a.length);
const MASK_RE: Array<[RegExp, string]> = MASK_TERMS.map((t) => [maskRegex(t), t]);

const DESPACED_TERMS = [
  ...new Set(
    [...PROFANITY, ...SLURS_HATE, ...SEXUAL, ...DESI_ABUSE]
      .map((w) => w.replace(/[^a-z]/g, ""))
      .filter((w) => w.length >= 4),
  ),
].sort((a, b) => b.length - a.length);

function despacedHits(text: string): string[] {
  let squeezed = lettersOnly(text);
  for (const safe of ALLOW_SUBSTR) squeezed = squeezed.split(safe).join(" ".repeat(safe.length));
  const hits: string[] = [];
  for (const term of DESPACED_TERMS) if (squeezed.includes(term)) hits.push(term);
  return hits;
}

const TIER_BY_CAT: Record<string, "BLOCK" | "REVIEW"> = {};
for (const [name, , tier] of CATEGORIES) TIER_BY_CAT[name] = tier;

/**
 * Moderate a free-text string. Returns a verdict + the reasons that fired.
 */
export function moderate(text: string): ModResult {
  const reasons: ModReason[] = [];
  let verdict: Verdict = "ALLOW";
  const add = (cat: string, tier: "BLOCK" | "REVIEW", match: string) => {
    reasons.push({ category: cat, tier, match: String(match) });
    if (tier === "BLOCK") verdict = "BLOCK";
    else if (tier === "REVIEW" && verdict !== "BLOCK") verdict = "REVIEW";
  };

  const folded = fold(text);

  // 6a. Wordlist categories.
  for (const [name] of CATEGORIES) {
    const re = COMPILED[name];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded))) add(name, TIER_BY_CAT[name], m[0]);
  }
  // 6b. Short platform codes.
  SHORT_RE.lastIndex = 0;
  { let m: RegExpExecArray | null; while ((m = SHORT_RE.exec(folded))) add("platform_name", "BLOCK", m[0]); }

  // 6c. Mask / leet / spaced evasion for core terms.
  for (const [rx, term] of MASK_RE) {
    const m = rx.exec(text);
    if (m) {
      const squeezed = m[0].toLowerCase().replace(/[^a-z]/g, "");
      if (ALLOW_SUBSTR.some((safe) => squeezed.includes(safe))) continue;
      add("obfuscated_abuse", "BLOCK", term);
    }
  }
  // 6c-ii. De-spaced backup pass.
  for (const term of despacedHits(text)) add("obfuscated_abuse", "BLOCK", term);

  // 6d. URLs.
  RE_URL.lastIndex = 0;
  { let m: RegExpExecArray | null; while ((m = RE_URL.exec(text))) add("url", "BLOCK", m[0].trim()); }
  // 6e. Emails.
  RE_EMAIL.lastIndex = 0;
  { let m: RegExpExecArray | null; while ((m = RE_EMAIL.exec(text))) add("email", "BLOCK", m[0].trim()); }
  // 6f. @handles.
  RE_HANDLE.lastIndex = 0;
  { let m: RegExpExecArray | null; while ((m = RE_HANDLE.exec(text))) add("handle", "BLOCK", m[0]); }

  // 6g. Phone numbers.
  const { converted, maxRun } = convertNumberWords(text);
  RE_PHONE_REGIONAL.lastIndex = 0;
  { let m: RegExpExecArray | null;
    while ((m = RE_PHONE_REGIONAL.exec(converted))) {
      const seg = converted.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
      if (!looksLikeMeasureOrPrice(seg)) add("phone", "BLOCK", m[0].trim());
    }
  }
  for (const { digits, span, raw } of digitRuns(converted)) {
    if (digits.length >= PHONE_MIN_DIGITS) {
      const seg = converted.slice(Math.max(0, span[0] - 12), span[1] + 12);
      if (!looksLikeMeasureOrPrice(seg)) add("phone", "BLOCK", raw.trim());
    }
  }
  // 6h. Consecutive spelled-out number words.
  if (maxRun >= WORDNUM_BLOCK_RUN) add("spelled_number", "BLOCK", `${maxRun} consecutive number words`);
  else if (maxRun >= WORDNUM_REVIEW_RUN) add("spelled_number", "REVIEW", `${maxRun} consecutive number words`);

  // De-duplicate.
  const seen = new Set<string>();
  const uniq: ModReason[] = [];
  for (const r of reasons) {
    const key = `${r.category}|${r.match.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(r); }
  }
  return { verdict, reasons: uniq };
}
