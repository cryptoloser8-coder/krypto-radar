'use strict';
// Punktacja momentum i flagi ryzyka. Czyste funkcje – bez sieci i bez stanu.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const n = (v) => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : 0;
};
const round1 = (x) => Math.round(x * 10) / 10;

const RISK_DEFAULTS = {
  critLiquidityUsd: 5000,
  lowLiquidityUsd: 25000,
  youngHours: 1,
  turnoverWarn: 30, // wolumen 24h / płynność
  fdvToLiqWarn: 100,
  dumpH1: -50,
  dumpH6: -70,
  fallH1: -20,
  fallH6: -40,
  pumpedH24: 500,
};

const PENALTY = { crit: 30, warn: 6, info: 0 };

function ageHours(t, now) {
  if (!t.createdAt) return null;
  return Math.max(0, (now - t.createdAt) / 3.6e6);
}

function momentumParts(t, now) {
  const vol = t.vol || {};
  const tx = t.txns || {};
  const chg = t.chg || {};
  const age = ageHours(t, now);
  const v1 = n(vol.h1), v6 = n(vol.h6), v24 = n(vol.h24), v5 = n(vol.m5);

  // 1) Przyspieszenie wolumenu: ostatnia godzina względem średniej godzinowej
  //    z 6 h i 24 h. Okna skracamy do wieku tokena, żeby świeży token nie
  //    dostawał punktów za sam fakt, że nie ma historii.
  const eff6 = age == null ? 6 : clamp(age, 1, 6);
  const eff24 = age == null ? 24 : clamp(age, 1, 24);
  const ratios = [];
  if (v6 > 0) ratios.push([v1 / (v6 / eff6), 0.6]);
  if (v24 > 0) ratios.push([v1 / (v24 / eff24), 0.4]);
  let accel = 0;
  if (ratios.length && v1 >= 500) {
    const wsum = ratios.reduce((s, r) => s + r[1], 0);
    const a = ratios.reduce((s, r) => s + r[0] * r[1], 0) / wsum;
    accel = 20 * clamp(Math.log2(Math.max(a, 1e-9)) / 2); // 1× → 0, 4× → 20
  }
  // Krótki impuls: ostatnie 5 min w przeliczeniu na godzinę względem godziny.
  let burst = 0;
  if (v1 > 0 && v5 >= 200) {
    const rs = (v5 * 12) / v1;
    burst = 8 * clamp(Math.log2(Math.max(rs, 1e-9)) / Math.log2(3)); // 3× → 8
  }

  // 2) Aktywność: liczba transakcji i wolumen w dolarach w ostatniej godzinie.
  const b1 = n(tx.h1 && tx.h1.buys), s1 = n(tx.h1 && tx.h1.sells);
  const tx1 = b1 + s1;
  const act =
    12 * clamp(Math.log10(tx1 + 1) / Math.log10(2000)) +
    8 * clamp((Math.log10(v1 + 1) - 3) / 3); // $1k → 0, $1M → 8

  // 3) Przewaga kupujących (liczona tylko przy min. 20 transakcjach).
  const buyRatio = tx1 > 0 ? b1 / tx1 : null;
  const buy = tx1 >= 20 ? 15 * clamp((buyRatio - 0.45) / 0.25) : 0; // 45% → 0, 70% → 15

  // 4) Trend ceny – spadki nie odejmują, wzrosty mają sufit.
  const price =
    10 * clamp(n(chg.h1) / 30) + 6 * clamp(n(chg.h6) / 60) + 4 * clamp(n(chg.h24) / 100);

  // 5) Uwaga: w ilu niezależnych miejscach token jest teraz „gorący”.
  const src = t.sources || [];
  const has = (s) => src.includes(s);
  let attn = 0;
  if (has('gt-trending')) attn += 4;
  if (has('cg-trending')) attn += 4;
  if ((t.metas || []).some((m) => m.hot)) attn += 3;
  if (has('ds-cto')) attn += 2;
  if (has('ds-boost-top') || has('ds-boost-new')) attn += 2;
  if (has('ds-profile')) attn += 1;
  if (has('pump-live')) attn += 2;
  if (has('pump-replies')) attn += 1 + 2 * clamp(Math.log10(n(t.pump && t.pump.replyCount) + 1) / 3);
  if (has('pump-active')) attn += 1;
  const so = t.socials || {};
  if (so.twitter) attn += 1;
  if (so.website || so.telegram) attn += 1;
  attn = Math.min(attn, 17);

  return {
    vol: round1(accel + burst), // maks. 28
    act: round1(act), // maks. 20
    buy: round1(buy), // maks. 15
    price: round1(price), // maks. 20
    attn: round1(attn), // maks. 17
    buyRatio,
    tx1,
    ageH: age,
  };
}

function riskFlags(t, now, riskCfg) {
  const R = Object.assign({}, RISK_DEFAULTS, riskCfg || {});
  const flags = [];
  const add = (sev, code, text) => flags.push({ sev, code, text });
  const vol = t.vol || {}, tx = t.txns || {}, chg = t.chg || {};
  const liq = t.liquidityUsd;
  const age = ageHours(t, now);
  const usd = (x) => '$' + Math.round(x).toLocaleString('en-US');

  if (liq == null) {
    if (t.bondingCurve) add('warn', 'curve', 'Jeszcze na krzywej pump.fun – brak puli płynności');
    else add('warn', 'liq-unknown', 'Nieznana płynność');
  } else if (liq < R.critLiquidityUsd) {
    add('crit', 'liq-crit', `Płynność tylko ${usd(liq)}`);
  } else if (liq < R.lowLiquidityUsd) {
    add('warn', 'liq-low', `Niska płynność (${usd(liq)})`);
  }

  if (n(chg.h1) <= R.dumpH1 || n(chg.h6) <= R.dumpH6) {
    add('crit', 'dump', `Gwałtowny spadek ceny (1h ${Math.round(n(chg.h1))}%, 6h ${Math.round(n(chg.h6))}%)`);
  } else if (n(chg.h1) <= R.fallH1 || n(chg.h6) <= R.fallH6) {
    // Duży wolumen przy spadającej cenie to częściej wyprzedaż niż okazja.
    add('warn', 'falling', `Cena spada (1h ${Math.round(n(chg.h1))}%, 6h ${Math.round(n(chg.h6))}%)`);
  }
  if (n(chg.h24) >= R.pumpedH24) {
    add('warn', 'pumped', `Już po wzroście +${Math.round(n(chg.h24))}% w 24 h – ryzyko kupna na szczycie`);
  }

  if (age != null && age < R.youngHours) add('warn', 'young', 'Token młodszy niż godzina');
  else if (age != null && age < 24) add('info', 'new', 'Młodszy niż 24 h');

  if (liq != null && liq > 0) {
    const turnover = n(vol.h24) / liq;
    if (turnover > R.turnoverWarn) {
      add('warn', 'turnover', `Obrót 24 h to ${Math.round(turnover)}× płynność – możliwy sztuczny wolumen`);
    }
    const fdv = n(t.fdv);
    if (fdv > 0 && fdv / liq > R.fdvToLiqWarn) {
      add('warn', 'thin', `Wycena ${Math.round(fdv / liq)}× większa od płynności`);
    }
  }

  const tx24 = n(tx.h24 && tx.h24.buys) + n(tx.h24 && tx.h24.sells);
  if (tx24 > 0 && tx24 < 100 && n(vol.h24) / tx24 > 5000) {
    add('warn', 'few-tx', 'Duży wolumen z niewielu transakcji');
  }

  const b1 = n(tx.h1 && tx.h1.buys), s1 = n(tx.h1 && tx.h1.sells);
  if (b1 + s1 >= 20 && b1 / (b1 + s1) < 0.4) {
    add('warn', 'sellers', `Przewaga sprzedających (${Math.round((100 * s1) / (b1 + s1))}% transakcji w 1 h)`);
  }

  const so = t.socials || {};
  if (!t.socialsUnknown && !so.twitter && !so.website && !so.telegram) {
    add('warn', 'no-socials', 'Brak linków do X, strony i Telegrama');
  }

  if (n(t.boostsActive) > 0) add('info', 'boost', `Płatna promocja na DexScreener (boost ×${n(t.boostsActive)})`);

  const p = t.pump;
  if (p) {
    if (p.verdict && p.verdict !== 'allow') add('crit', 'pump-verdict', `pump.fun: ostrzeżenie bezpieczeństwa (${p.verdict})`);
    if (n(p.athMcUsd) > 0 && n(p.mcUsd) > 0 && p.mcUsd / p.athMcUsd < 0.3) {
      add('warn', 'off-ath', `${Math.round(100 - (100 * p.mcUsd) / p.athMcUsd)}% poniżej szczytu wyceny`);
    }
  }

  // Unikalni kupujący (z GeckoTerminal): dużo zakupów z garstki portfeli to zwykle boty.
  const u = t.uniq && t.uniq.h1;
  if (u && b1 >= 30 && u.buyers > 0 && u.buyers / b1 < 0.25) {
    add('warn', 'bots', `Tylko ${u.buyers} portfeli na ${b1} zakupów w 1 h – możliwe boty`);
  }
  if (t.lockedLiqPct != null) add('info', 'lp-lock', `Zablokowana płynność: ${Math.round(t.lockedLiqPct)}%`);

  for (const f of t.securityFlags || []) flags.push(f);
  return flags;
}

function riskLevel(flags) {
  if (flags.some((f) => f.sev === 'crit')) return 'crit';
  const warns = flags.filter((f) => f.sev === 'warn').length;
  if (warns >= 3) return 'high';
  if (warns >= 1) return 'med';
  return 'none';
}

function scoreToken(t, now = Date.now(), riskCfg) {
  const parts = momentumParts(t, now);
  const momentum = round1(parts.vol + parts.act + parts.buy + parts.price + parts.attn);
  const flags = riskFlags(t, now, riskCfg);
  const crit = flags.filter((f) => f.sev === 'crit').length;
  const warn = flags.filter((f) => f.sev === 'warn').length;
  const penalty = Math.min(crit * PENALTY.crit, 60) + Math.min(warn * PENALTY.warn, 24);
  return {
    momentum,
    parts,
    flags,
    penalty,
    score: round1(Math.max(0, momentum - penalty)),
    risk: riskLevel(flags),
  };
}

// ---- Wczesny sygnał ---------------------------------------------------------
// Szukamy tokenów, w których popyt już rośnie, a cena jeszcze nie uciekła.
// Trapez: 0 poniżej lo0 i powyżej hi0, 1 między lo1 a hi1, liniowo na zboczach.
const trap = (x, lo0, lo1, hi1, hi0) =>
  x <= lo0 || x >= hi0 ? 0 : x < lo1 ? (x - lo0) / (lo1 - lo0) : x <= hi1 ? 1 : (hi0 - x) / (hi0 - hi1);

const EARLY_SCOPE = { minLiquidityUsd: 20000, minAgeMin: 30, maxMarketCapUsd: 1e7 };

function scoreEarly(t, now, flags, scope) {
  const S = Object.assign({}, EARLY_SCOPE, scope || {});
  const vol = t.vol || {}, tx = t.txns || {}, chg = t.chg || {};
  const age = ageHours(t, now);
  const v1 = n(vol.h1), v6 = n(vol.h6), v24 = n(vol.h24), v5 = n(vol.m5);
  const eff6 = age == null ? 6 : clamp(age, 1, 6);
  const eff24 = age == null ? 24 : clamp(age, 1, 24);

  // 1) Popyt (do 30): wolumen ostatniej godziny względem własnej średniej + impuls z 5 minut.
  const ratios = [];
  if (v6 > 0) ratios.push([v1 / (v6 / eff6), 0.6]);
  if (v24 > 0) ratios.push([v1 / (v24 / eff24), 0.4]);
  let volX = null, demand = 0;
  if (ratios.length) volX = ratios.reduce((s, r) => s + r[0] * r[1], 0) / ratios.reduce((s, r) => s + r[1], 0);
  if (volX != null && v1 >= 500) demand += 21 * clamp(Math.log2(Math.max(volX, 1e-9)) / 2); // 1× → 0, 4× → 21
  if (v1 > 0 && v5 >= 200) demand += 9 * clamp(Math.log2(Math.max((v5 * 12) / v1, 1e-9)) / Math.log2(3)); // 3× → 9
  // Wzrost liczy się tylko wtedy, gdy sam wolumen coś znaczy: pełna waga od $10 tys. na godzinę
  // (zero przy $1 tys.) i od 2% płynności na godzinę. Inaczej to szum na martwym tokenie albo na dużej puli.
  const mc = n(t.marketCap) || n(t.fdv), liq = t.liquidityUsd;
  demand *= Math.min(clamp(Math.log10(Math.max(v1, 1) / 1000)), liq > 0 ? clamp(v1 / liq / 0.02) : 1);

  // 2) Kupujący (do 20): udział zakupów, przyspieszenie liczby transakcji, unikalne portfele.
  const b1 = n(tx.h1 && tx.h1.buys), s1 = n(tx.h1 && tx.h1.sells), tx1 = b1 + s1;
  const tx6 = n(tx.h6 && tx.h6.buys) + n(tx.h6 && tx.h6.sells);
  let buyers = 0, txX = null;
  if (tx1 >= 20) {
    buyers += 10 * clamp((b1 / tx1 - 0.45) / 0.25); // 45% → 0, 70% → 10
    if (tx6 > 0) {
      txX = tx1 / (tx6 / eff6);
      buyers += 5 * clamp(Math.log2(Math.max(txX, 1e-9)) / Math.log2(3)); // 3× → 5
    }
  }
  const u = t.uniq && t.uniq.h1;
  if (u && u.buyers + u.sellers >= 20) {
    buyers += 5 * clamp((u.buyers / (u.buyers + u.sellers) - 0.5) / 0.15); // 50% → 0, 65% → 5
  } else if (!u) {
    // Bez danych o portfelach: czy przewaga zakupów trzyma się w ostatnich 5 minutach.
    const b5 = n(tx.m5 && tx.m5.buys), s5 = n(tx.m5 && tx.m5.sells);
    if (b5 + s5 >= 10) buyers += 5 * clamp((b5 / (b5 + s5) - 0.5) / 0.2);
  }

  // Zapas ceny i niska wycena liczą się tylko razem z popytem – inaczej każdy mały token,
  // w którym nic się nie dzieje, miałby 35 punktów na start. Pełna waga od 25 pkt popytu i kupujących.
  const g = clamp((demand + buyers) / 25);

  // 3) Zapas ceny (do 20): najwięcej punktów, gdy cena prawie stoi.
  const c1 = n(chg.h1), c6 = n(chg.h6), c24 = n(chg.h24);
  const room = g * (8 * trap(c1, -15, -5, 15, 40) + 6 * trap(c6, -30, -15, 30, 80) + 6 * trap(c24, -50, -30, 60, 150));

  // 4) Wycena (do 15): mała kapitalizacja i płynność, która nie jest przy niej symboliczna.
  let value = 0;
  if (mc > 0) {
    value += 9 * clamp((Math.log10(2e7) - Math.log10(Math.max(mc, 5e5))) / (Math.log10(2e7) - Math.log10(5e5))); // ≤ $0,5 mln → 9, $20 mln → 0
    if (liq > 0) value += 6 * clamp((Math.log10(liq / mc) - Math.log10(0.02)) / (Math.log10(0.15) - Math.log10(0.02))); // 2% → 0, 15% → 6
  }
  value *= g;

  // 5) Świeżość (do 15): token dopiero zaczyna być widoczny.
  const src = t.sources || [];
  const has = (x) => src.includes(x);
  let fresh = 0;
  if (t.seenMin != null) fresh += 4 * clamp((90 - t.seenMin) / 60); // do 30 min od pierwszego pojawienia → 4, po 90 min → 0
  if (has('ds-profile') || has('ds-boost-new') || has('ds-cto')) fresh += 3;
  if (has('gt-trending-5m') && !has('gt-trending')) fresh += 3; // w trendach 5-minutowych, jeszcze nie w dobowych
  if (age != null && age < 6) fresh += 2;
  else if (age != null && age < 24) fresh += 1;
  if ((t.metas || []).some((m) => m.hot)) fresh += 1;
  const so = t.socials || {};
  if (so.twitter) fresh += 1;
  if (so.website || so.telegram) fresh += 1;

  // Kara za „już po ruchu”.
  const late = 10 * clamp((c1 - 40) / 60) + 8 * clamp((c6 - 80) / 120) + 8 * clamp((c24 - 150) / 350);

  const crit = (flags || []).filter((f) => f.sev === 'crit').length;
  const warn = (flags || []).filter((f) => f.sev === 'warn').length;
  const penalty = Math.min(crit * PENALTY.crit, 60) + Math.min(warn * PENALTY.warn, 24);
  const raw = demand + buyers + room + value + fresh;

  // Zakres A: po migracji z krzywej, z realną płynnością, krótką historią i niedużą wyceną.
  let why = null;
  if (t.bondingCurve) why = 'jeszcze na krzywej pump.fun';
  else if (liq == null) why = 'nieznana płynność';
  else if (liq < S.minLiquidityUsd) why = 'za mała płynność';
  else if (age != null && age * 60 < S.minAgeMin) why = 'za młody';
  else if (mc > S.maxMarketCapUsd) why = 'za duża wycena'; // duże, ugruntowane tokeny to nie „wczesne” sygnały

  return {
    score: round1(Math.max(0, raw - late - penalty)),
    raw: round1(raw),
    parts: { demand: round1(demand), buyers: round1(buyers), room: round1(room), value: round1(value), fresh: round1(fresh) },
    late: round1(late),
    penalty,
    volX: volX == null ? null : round1(volX),
    txX: txX == null ? null : round1(txX),
    inScope: !why,
    why,
  };
}

// ---- NFT ------------------------------------------------------------------

function scoreNft(c) {
  const flags = [];
  const add = (sev, code, text) => flags.push({ sev, code, text });
  const v1 = n(c.vol1d), v7 = n(c.vol7d), s1 = n(c.sales1d);
  // Ostatnia doba względem średniej dziennej z 7 dni.
  const dayShare = v7 > 0 ? v1 / (v7 / 7) : null;
  const accel = dayShare != null ? 35 * clamp(Math.log2(Math.max(dayShare, 1e-9)) / Math.log2(5)) : 0;
  const sales = 30 * clamp(Math.log10(s1 + 1) / 3); // 1000 sprzedaży/dobę → 30
  const hourRank = c.rank1h ? 15 * clamp((21 - c.rank1h) / 20) : 0;
  const dayRank = c.rank1d ? 10 * clamp((21 - c.rank1d) / 20) : 0;
  const floorPart = c.floorChangePct != null ? 10 * clamp(c.floorChangePct / 30) : 0;
  const momentum = round1(accel + sales + hourRank + dayRank + floorPart);

  if (s1 < 20) add('warn', 'illiquid', `Tylko ${s1} sprzedaży w 24 h – trudno wyjść`);
  if (c.owners != null && c.owners < 300) add('warn', 'owners', `Tylko ${c.owners} posiadaczy`);
  if (v7 > 0 && v1 / v7 > 0.85) add('warn', 'one-day', 'Prawie cały wolumen tygodnia z ostatniej doby – brak historii');
  if (n(c.floor) > 0 && s1 > 0 && v1 / s1 > 5 * c.floor) {
    add('warn', 'avg-vs-floor', 'Średnia cena sprzedaży wielokrotnie powyżej floor – możliwy wash trading');
  }
  if (c.floorChangePct != null && c.floorChangePct <= -30) add('crit', 'floor-dump', `Floor spadł o ${Math.round(-c.floorChangePct)}%`);

  const crit = flags.filter((f) => f.sev === 'crit').length;
  const warn = flags.filter((f) => f.sev === 'warn').length;
  const penalty = Math.min(crit * PENALTY.crit, 60) + Math.min(warn * PENALTY.warn, 24);
  return {
    momentum,
    parts: { accel: round1(accel), sales: round1(sales), rank: round1(hourRank + dayRank), floor: round1(floorPart) },
    dayShare,
    flags,
    penalty,
    score: round1(Math.max(0, momentum - penalty)),
    risk: riskLevel(flags),
  };
}

module.exports = { scoreToken, scoreEarly, scoreNft, momentumParts, riskFlags, riskLevel, RISK_DEFAULTS, clamp };
