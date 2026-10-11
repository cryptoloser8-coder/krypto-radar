'use strict';
// Test całości bez internetu: uruchamia atrapę API, aplikację i sprawdza wyniki.
// Użycie: node test/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const mock = require('./mock-apis');
const { scoreToken, scoreEarly, scoreNft } = require('../lib/score');
const outcomes = require('../lib/outcomes');
const { CallLog } = require('../lib/calllog');
const auth = require('../lib/auth');
const sources = require('../lib/sources');

const MOCK = 9911, APP = 9912;
const near = (a, b, eps = 0.11) => assert.ok(Math.abs(a - b) <= eps, `oczekiwano ~${b}, jest ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJson = (u) => fetch(u).then((r) => r.json());

function unit() {
  const now = Date.now();
  const t = {
    createdAt: now - 10 * 3.6e6, liquidityUsd: 120000, fdv: 2e6, boostsActive: 50,
    vol: { m5: 20000, h1: 150000, h6: 300000, h24: 500000 },
    txns: { h1: { buys: 650, sells: 350 }, h24: { buys: 3900, sells: 2100 } },
    chg: { h1: 24, h6: 45, h24: 80 },
    sources: ['gt-trending', 'ds-boost-top'], socials: { twitter: 'x', website: 'y' },
  };
  const s = scoreToken(t, now);
  near(s.parts.vol, 19.3);   // 20·log2(3)/2 + 8·log2(1.6)/log2(3)
  near(s.parts.act, 16.7);   // 12·log10(1001)/log10(2000) + 8·(log10(150001)−3)/3
  near(s.parts.buy, 12);     // 15·(0.65−0.45)/0.25
  near(s.parts.price, 15.7); // 8 + 4.5 + 3.2
  near(s.parts.attn, 8);     // 4 + 2 + 1 + 1
  near(s.momentum, 71.7, 0.2);
  assert.strictEqual(s.penalty, 0);
  assert.strictEqual(s.risk, 'none');

  // Token młodszy niż godzina nie dostaje punktów za „przyspieszenie”.
  const young = scoreToken(Object.assign({}, t, { createdAt: now - 0.5 * 3.6e6, vol: { m5: 0, h1: 40000, h6: 40000, h24: 40000 } }), now);
  assert.strictEqual(young.parts.vol, 0);
  assert.ok(young.flags.some((f) => f.code === 'young'));

  const rug = scoreToken(Object.assign({}, t, { liquidityUsd: 3000 }), now);
  assert.strictEqual(rug.risk, 'crit');
  assert.ok(rug.penalty >= 30);

  const nft = scoreNft({ vol1d: 90, vol7d: 210, sales1d: 300, floor: 0.5, owners: 4000, rank1h: 1, rank1d: 2 });
  near(nft.dayShare, 3); // 90 / (210/7)
  near(nft.parts.accel, 35 * (Math.log2(3) / Math.log2(5)));
  assert.strictEqual(nft.risk, 'none');
  // --- Wynik wczesny: ten sam token co EARLY w atrapie, liczony ręcznie ---
  const et = {
    createdAt: now - 5 * 3.6e6, liquidityUsd: 60000, marketCap: 400000, fdv: 400000,
    vol: { m5: 1500, h1: 12000, h6: 18000, h24: 18000 },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 90, sells: 50 }, h6: { buys: 270, sells: 150 }, h24: { buys: 540, sells: 300 } },
    chg: { h1: 4, h6: 10, h24: 12 },
    sources: ['gt-trending-5m'], socials: { twitter: 'x', website: 'y' }, seenMin: null,
    uniq: { h1: { buyers: 70, sellers: 30 } },
  };
  const e = scoreEarly(et, now, []);
  near(e.volX, 3.3);          // 12000 / (18000/5): okno skrócone do wieku tokena
  near(e.parts.demand, 21.6); // 21·log2(3,33)/2 + 9·log2(1,5)/log2(3)
  near(e.parts.buyers, 15);   // 10·(0,643−0,45)/0,25 + 5·log2(1,67)/log2(3) + 5 (70% portfeli kupuje)
  near(e.parts.room, 20);     // cena prawie stoi we wszystkich oknach
  near(e.parts.value, 15);    // wycena ≤ $0,5 mln, płynność 15% wyceny
  near(e.parts.fresh, 7);     // trendy 5-min bez dobowych 3 + wiek < 6 h 2 + linki 2
  near(e.raw, 78.6, 0.2);
  assert.strictEqual(e.late, 0);
  assert.strictEqual(e.inScope, true);

  // Token po dużym wzroście: brak punktów za „zapas ceny” i kara za „już po ruchu”.
  const ran = scoreEarly(Object.assign({}, et, { chg: { h1: 100, h6: 200, h24: 500 } }), now, []);
  assert.strictEqual(ran.parts.room, 0);
  near(ran.late, 26);
  assert.ok(ran.score < e.score - 40);

  // Martwy token ze skokiem na śmiesznym wolumenie ($1,2 tys./h) nie zbiera punktów za popyt,
  // a bez popytu nie liczy się też „zapas ceny” ani niska wycena.
  const blip = scoreEarly(Object.assign({}, et, { createdAt: now - 4000 * 3.6e6, vol: { m5: 0, h1: 1181, h6: 1700, h24: 2000 }, txns: { h1: { buys: 6, sells: 5 }, h6: { buys: 9, sells: 8 }, h24: { buys: 12, sells: 10 } }, uniq: null, sources: [] }), now, []);
  near(blip.parts.demand, 1.5);  // 21 pkt × waga log10(1181/1000) = 0,07
  near(blip.parts.room, 1.2);    // 20 pkt × (1,5 + 0)/25
  assert.ok(blip.raw < 8);
  // Duża pula, na której godzinny wolumen to 0,1% płynności: wzrost ×3 jest szumem.
  const big = scoreEarly(Object.assign({}, et, { liquidityUsd: 1e7, marketCap: 5e7, fdv: 5e7 }), now, []);
  near(big.parts.demand, 21.56 * (12000 / 1e7 / 0.02), 0.1);

  // Zakres A: krzywa pump.fun, mała płynność i zbyt młody token są poza zakresem.
  assert.strictEqual(scoreEarly(Object.assign({}, et, { bondingCurve: true, liquidityUsd: null }), now, []).inScope, false);
  assert.strictEqual(scoreEarly(Object.assign({}, et, { liquidityUsd: 15000 }), now, []).why, 'za mała płynność');
  assert.strictEqual(scoreEarly(Object.assign({}, et, { createdAt: now - 10 * 60e3 }), now, []).why, 'za młody');
  assert.strictEqual(scoreEarly(Object.assign({}, et, { marketCap: 5e7, fdv: 5e7 }), now, []).why, 'za duża wycena');

  // Boty: 200 zakupów z 20 portfeli.
  const bots = scoreToken(Object.assign({}, t, { txns: { h1: { buys: 200, sells: 50 }, h24: { buys: 900, sells: 300 } }, uniq: { h1: { buyers: 20, sellers: 15 } } }), now);
  assert.ok(bots.flags.some((f) => f.code === 'bots'));
  console.log('✓ punktacja: obliczenia zgodne z ręcznym wyliczeniem (gorące, wczesne, NFT)');

  // --- Pomiar skuteczności z przesuwanym zegarem ---
  const T0 = 1e12, HOUR = 3.6e6;
  const mk = (key) => ({ at: T0, type: 'token', kind: 'early', key, price0: 1, liq0: 50000, peak: 1, low: 1, checks: {} });
  const al = [mk('up'), mk('gone'), mk('rug'), mk('off')];
  const world = (price) => new Map([['up', { priceUsd: price, liquidityUsd: 50000 }], ['rug', { priceUsd: 0.1, liquidityUsd: 2000 }]]);
  const askedAll = new Set(['up', 'gone', 'rug']); // „off” nie był odpytywany – jakby aplikacja nie działała
  outcomes.track(al, world(1.3), askedAll, T0 + 2.5 * 60e3);        // cena 2 min po alercie (realne wejście)
  assert.deepStrictEqual([al[0].checks.m2.chg, al[0].checks.m5], [30, undefined]);
  outcomes.track(al, world(1.5), askedAll, T0 + 30 * 60e3);         // przed terminem 1 h: tylko szczyt
  assert.strictEqual(al[0].checks.m5.missed, true, 'okno 5 min minęło bez skanu');
  assert.deepStrictEqual(Object.keys(al[0].checks).filter((k) => k[0] === 'h'), []);
  assert.strictEqual(al[0].peak, 1.5);
  for (const m of [61, 62, 63]) outcomes.track(al, world(1.2), askedAll, T0 + m * 60e3);
  assert.strictEqual(al[0].checks.h1.chg, 20);                       // +20% po godzinie
  assert.strictEqual(al[2].checks.h1.chg, -90);
  assert.strictEqual(al[2].checks.h1.rug, true);                     // płynność 2 tys. z 50 tys.
  assert.strictEqual(al[1].checks.h1, undefined);                    // jeszcze w oknie tolerancji
  outcomes.track(al, world(1.2), askedAll, T0 + 85 * 60e3);         // okno 1 h minęło
  assert.deepStrictEqual([al[1].checks.h1.dead, al[1].checks.h1.chg], [true, -100]); // 3 skany bez danych
  assert.strictEqual(al[3].checks.h1.missed, true);                  // brak danych, ale nie z winy tokena
  outcomes.track(al, world(0.8), askedAll, T0 + 6 * HOUR + 60e3);
  outcomes.track(al, world(2), askedAll, T0 + 24 * HOUR + 60e3);
  assert.deepStrictEqual([al[0].checks.h6.chg, al[0].checks.h24.chg, al[0].peak], [-20, 100, 2]);
  assert.deepStrictEqual([al[0].checks.h1.pk, al[0].checks.h1.lo, al[0].checks.h24.pk, al[0].checks.h24.lo], [50, 0, 100, -20]);
  assert.ok(!al[0].done, 'po 24 h pomiar trwa dalej (72 h, 7 dni)');
  // Po pierwszej dobie cenę pobieramy tylko w oknach pomiarów.
  assert.strictEqual(outcomes.wantsPrice(al[0], T0 + 30 * HOUR), false);
  assert.strictEqual(outcomes.wantsPrice(al[0], T0 + 72 * HOUR - 60e3), true);
  // 72 h: szczyt i dołek ze świec godzinowych (cena 3 → szczyt +200%, dołek 0,4 → −60%).
  const candles = [[(T0 + 30 * HOUR) / 1000, 1, 3, 0.9, 1], [(T0 + 50 * HOUR) / 1000, 1, 1.1, 0.4, 1], [(T0 + 100 * HOUR) / 1000, 1, 9, 0.1, 1]];
  const w72 = outcomes.wantsExtremes(al[0], T0 + 72 * HOUR + 60e3);
  assert.deepStrictEqual(w72.map((w) => w.name), ['h72']);
  al[0].ext = { h72: outcomes.extremesFromCandles(candles, w72[0].from, w72[0].to) };
  assert.deepStrictEqual(al[0].ext.h72, { hi: 3, lo: 0.4 }, 'świeca po 72 h się nie liczy');
  outcomes.track(al, world(1.1), askedAll, T0 + 72 * HOUR + 60e3);
  assert.deepStrictEqual([al[0].checks.h72.chg, al[0].checks.h72.pk, al[0].checks.h72.lo, al[0].checks.h72.approx], [10, 200, -60, undefined]);
  // 7 dni bez świec: szczyt przybliżony (z pierwszej doby i z chwili pomiaru), potem koniec pomiaru.
  outcomes.track(al, world(0.5), askedAll, T0 + 168 * HOUR + 60e3);
  assert.deepStrictEqual([al[0].checks.d7.chg, al[0].checks.d7.pk, al[0].checks.d7.approx, al[0].done], [-50, 100, true, true]);
  assert.strictEqual(al[3].checks.h72.missed, true); // aplikacja „nie działała” w oknie 72 h
  console.log('✓ pomiar skuteczności: 1 h, 6 h, 24 h, 72 h, 7 dni, szczyty ze świec, tokeny znikające i wycofana płynność');
}

async function integration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const base = `http://127.0.0.1:${MOCK}`;
  // „GitHub” do testu: lokalne puste repozytorium, do którego aplikacja wypycha dane.
  const bare = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port: APP, scanIntervalSec: 20, nftIntervalSec: 1, gtPerMin: 100,
    publish: { enabled: true, repo: bare, branch: 'data', intervalSec: 60 },
    telegram: { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chatId: '', pairCode: '123456' },
    api: { dexscreener: base + '/ds', geckoterminal: base + '/gt', coingecko: base + '/cg', pumpfun: base + '/pf', opensea: base + '/os', rugcheck: base + '/rc', goplus: base + '/gp', telegram: base + '/tg' },
  }));
  // Stan z poprzedniego uruchomienia: alert sprzed 61 minut po połowie dzisiejszej ceny GOOD
  // oraz alert na token, którego DexScreener już nie zna (trzy skany bez danych).
  const seedAt = Date.now() - 61 * 60e3;
  fs.mkdirSync(path.join(dir, 'data'));
  // Alert sprzed 72 h (już w dzienniku): pomiar 72 h ze szczytem i dołkiem ze świec GeckoTerminal.
  const at72 = Date.now() - 72 * 3.6e6 - 5 * 60e3;
  const old72 = { id: 'seed72x', at: at72, type: 'token', kind: 'momentum', key: 'solana:' + mock.GOOD, chain: 'solana', address: mock.GOOD, symbol: 'OLD', score: 60, risk: 'none', price0: 0.00000615, liq0: 100000, peak: 0.00000615, low: 0.00000615, pair: 'POOLOLD',
    checks: { h1: { chg: 1, t: at72 + 3.6e6 }, h6: { chg: 2, t: at72 + 6 * 3.6e6 }, h24: { chg: 3, t: at72 + 864e5, pk: 10, lo: -1 } } };
  fs.mkdirSync(path.join(dir, 'data', 'calls'), { recursive: true });
  const d72 = new Date(at72);
  fs.writeFileSync(path.join(dir, 'data', 'calls', `calls-${d72.getUTCFullYear()}-${String(d72.getUTCMonth() + 1).padStart(2, '0')}.jsonl`),
    JSON.stringify({ t: 'call', id: 'seed72x', at: at72, type: 'token', kind: 'momentum', symbol: 'OLD', chain: 'solana', score: 60, risk: 'none', price: 0.00000615, sent: true }) + '\n');

  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({ alerts: [
    { at: seedAt, type: 'token', kind: 'early', key: 'solana:' + mock.GOOD, chain: 'solana', address: mock.GOOD, symbol: 'GOOD', score: 60, risk: 'none', price0: 0.00000615, liq0: 100000, peak: 0.00000615, low: 0.00000615, checks: {} },
    { at: Date.now() - 85 * 60e3, type: 'token', kind: 'early', key: 'solana:GoneMint', chain: 'solana', address: 'GoneMint', symbol: 'GONE', score: 55, risk: 'none', price0: 1, liq0: 30000, peak: 1, low: 1, checks: {}, miss: { h1: 3 } },
    old72,
  ] }));
  const srv = await mock.start(MOCK);
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { RADAR_CONFIG: path.join(dir, 'config.json'), RADAR_DATA: path.join(dir, 'data') }), stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  app.stdout.on('data', (d) => (out += d));
  try {
    let st;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = await fetch(`http://127.0.0.1:${APP}/api/state`).then((r) => r.json()).catch(() => null);
      if (st && st.scans >= 1 && st.nftScannedAt) break;
    }
    assert.ok(st && st.scans >= 1, 'aplikacja nie zakończyła skanu\n' + out);
    const by = Object.fromEntries(st.tokens.map((t) => [t.symbol, t]));

    assert.ok(!by.USDC, 'stablecoin powinien być pominięty');
    assert.ok(by.GOOD && by.CURVE && by.RUG && by.HONEY && by.DUMP && by.ROO && by.EARLY, 'brakuje tokenów: ' + Object.keys(by));

    // GOOD: wygrywa para z większą płynnością, dane z DexScreenera, alert.
    assert.strictEqual(by.GOOD.liquidityUsd, 120000);
    assert.strictEqual(by.GOOD.dataFrom, 'dexscreener');
    assert.ok(by.GOOD.sources.includes('gt-trending') && by.GOOD.sources.includes('ds-boost-top') && by.GOOD.sources.includes('pump-active') && by.GOOD.sources.includes('pump-migrated'));
    assert.strictEqual(by.GOOD.security, 'checked');
    assert.strictEqual(by.GOOD.s.risk, 'none');
    near(by.GOOD.s.momentum, 72.7, 0.3); // 71.7 z testu jednostkowego + 1 pkt za „aktywne na pump.fun”
    assert.strictEqual(st.tokens[0].symbol, 'GOOD');

    // HONEY: świetne liczby, ale GoPlus zgłasza honeypot → ryzyko krytyczne, brak alertu.
    assert.strictEqual(by.HONEY.s.risk, 'crit');
    assert.ok(by.HONEY.s.flags.some((f) => f.code === 'honeypot'));
    assert.ok(by.HONEY.metas.some((m) => m.slug === 'dog' && m.hot));

    assert.ok(by.RUG.s.flags.some((f) => f.code === 'liq-crit'));
    assert.ok(by.DUMP.s.flags.some((f) => f.code === 'dump'));
    assert.ok(by.DUMP.s.flags.some((f) => f.code === 'sellers'));

    // CURVE: krzywa pump.fun, dane społecznościowe z pump.fun, ostrzeżenie RugCheck (bez „Low Liquidity”).
    assert.strictEqual(by.CURVE.bondingCurve, true);
    assert.strictEqual(by.CURVE.pump.replyCount, 800);
    assert.ok(by.CURVE.sources.includes('pump-live') && by.CURVE.sources.includes('pump-replies'));
    assert.ok(by.CURVE.s.flags.some((f) => /Top 10 holders/.test(f.text)));
    assert.ok(!by.CURVE.s.flags.some((f) => /Low Liquidity/.test(f.text)));

    // ROO: sieć, której DexScreener nie zna → zostają dane GeckoTerminal; trenduje też na CoinGecko.
    assert.strictEqual(by.ROO.dataFrom, 'geckoterminal');
    assert.strictEqual(by.ROO.chain, 'robinhood');
    assert.ok(by.ROO.sources.includes('cg-trending'));
    assert.strictEqual(by.ROO.security, 'unsupported');

    // EARLY: wczesny sygnał z danymi o portfelach z GeckoTerminal; za słaby na alert „gorący”.
    near(by.EARLY.e.raw, 78.6, 0.3);
    assert.strictEqual(by.EARLY.e.inScope, true);
    assert.deepStrictEqual(by.EARLY.uniq.h1, { buyers: 70, sellers: 30 });
    assert.ok(by.EARLY.s.flags.some((f) => f.code === 'lp-lock'));
    assert.ok(by.EARLY.s.score < 55 && by.EARLY.e.score >= 45);
    // Poza zakresem A: krzywa pump.fun i płynność poniżej progu.
    assert.strictEqual(by.CURVE.e.inScope, false);
    assert.strictEqual(by.RUG.e.why, 'za mała płynność');
    // HONEY ma dobre liczby, ale honeypot zabiera 30 punktów i blokuje alert.
    assert.ok(by.HONEY.e.inScope && by.HONEY.e.penalty >= 30);

    // Telegram: połączona tylko rozmowa, z której przyszedł kod (nie obcy, nie grupa).
    const sent = await fetch(base + '/__sent').then((r) => r.json());
    assert.ok(sent.length && sent.every((m) => String(m.chat_id) === '424242'), 'wiadomości poszły do: ' + [...new Set(sent.map((m) => m.chat_id))]);
    const savedCfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(savedCfg.telegram.pairCode, '', 'kod parowania powinien zostać zużyty');
    const alerts = sent.filter((m) => m.text.startsWith('🚨'));
    assert.strictEqual(alerts.length, 1, 'alerty: ' + alerts.map((a) => a.text.split('\n')[0]).join(' | '));
    assert.ok(/GOOD/.test(alerts[0].text));
    // …i dokładnie jeden wczesny sygnał (EARLY). GOOD jest już „gorący”, więc wczesnego nie dostaje.
    const earlyMsgs = sent.filter((m) => m.text.startsWith('🌱'));
    assert.strictEqual(earlyMsgs.length, 1, 'wczesne: ' + earlyMsgs.map((a) => a.text.split('\n')[0]).join(' | '));
    assert.ok(/EARLY/.test(earlyMsgs[0].text) && /70 kupujących \/ 30 sprzedających/.test(earlyMsgs[0].text));
    const A = await fetch(`http://127.0.0.1:${APP}/api/alerts`).then((r) => r.json());
    const live = A.live.alerts;
    const logged = live.find((a) => a.kind === 'early' && a.symbol === 'EARLY');
    assert.ok(logged && logged.price0 > 0 && logged.id && logged.pair === undefined, 'wiersz listy bez zbędnych pól');

    // Dane dodatkowe przy alercie: rynek, średnia transakcja, posiadacze i członkowie Telegrama (także przed alertem),
    // a po alercie posiadacze, transakcje, insiderzy (Solana) i członkowie – dociągane bez opóźniania alertu.
    const detE = await fetchJson(`http://127.0.0.1:${APP}/api/alert?id=${logged.id}`);
    assert.deepStrictEqual([detE.d.market.sol.h1, detE.d.market.btc.h24], [1.3, -1.2]);
    assert.ok(detE.d.avgTx && detE.d.avgTx.h1 > 0 && detE.d.holdersPre && detE.d.holdersPre.count > 1000 && detE.d.tgLink === 'https://t.me/early_portal', JSON.stringify(detE.d).slice(0, 400));
    const enE = detE.enrich && detE.enrich.alert;
    assert.ok(enE && enE.holders.count > 1000 && enE.holders.top10 === 31.5 && enE.trades.n === 9 && enE.trades.whales === 1 && enE.tgMembers > 500, JSON.stringify(detE.enrich));
    // Telegram tokena: publiczny (nazwa, członkowie), prywatny, nieistniejący, brak – w tokenach, alercie i szczegółach.
    const st2 = await fetchJson(`http://127.0.0.1:${APP}/api/state`);
    const tgOf = Object.fromEntries(st2.tokens.map((t) => [t.symbol, t.tg]));
    assert.strictEqual(tgOf.DUMP.s, 'private');
    assert.strictEqual(tgOf.RUG.s, 'none');
    assert.ok(tgOf.EARLY.s === 'public' && tgOf.EARLY.title === 'EARLY Portal' && tgOf.EARLY.n > 500 && tgOf.EARLY.type === 'channel', JSON.stringify(tgOf.EARLY));
    assert.ok(['notfound', 'public'].includes(tgOf.HONEY.s));
    assert.ok(/📢 Telegram: kanał „EARLY Portal” – \d+ członków/.test(earlyMsgs[0].text) && /<a href="https:\/\/t\.me\/early_portal">Telegram<\/a>/.test(earlyMsgs[0].text), earlyMsgs[0].text);
    assert.ok(detE.d.tg && detE.d.tg.s === 'public' && detE.d.tg.title === 'EARLY Portal');
    assert.strictEqual(enE.tgStatus, 'public');
    const goodAlert = live.find((a) => a.symbol === 'GOOD' && a.kind === 'momentum');
    const detG = await fetchJson(`http://127.0.0.1:${APP}/api/alert?id=${goodAlert.id}`);
    assert.ok(detG.enrich.alert.insiders && detG.enrich.alert.insiders.insidersDetected === 7 && detG.enrich.alert.insiders.lpLockedPct === 99.5);
    assert.ok(detG.d.secInfo && detG.d.secInfo.src === 'rugcheck', 'dane z kontroli RugCheck w obrazie alertu');
    // Taśma: zapis wszystkich ocenianych tokenów, z oznaczeniem tych z alertem.
    const tapeFiles = fs.readdirSync(path.join(dir, 'data', 'tape'));
    const tapeRec = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'tape', tapeFiles[0]), 'utf8').trim().split('\n')[0]);
    assert.ok(tapeRec.tokens.length >= 5 && tapeRec.market && tapeRec.tokens.some((t) => t.s === 'EARLY' && t.al === 'e') && tapeRec.tokens.some((t) => t.s === 'RUG'), 'taśma: ' + tapeRec.tokens.map((t) => t.s));
    assert.strictEqual(st.appVersion > 0 && st.market.sol.h1, 1.3);

    // Pomiar skuteczności: alert sprzed 61 min po połowie ceny → +100% po 1 h; nieznany token → zniknął.
    const seeded = live.find((a) => a.at === seedAt);
    assert.strictEqual(seeded.checks.h1.chg, 100);
    assert.deepStrictEqual([seeded.checks.h1.pk, seeded.checks.h1.lo], [100, 0]);
    assert.strictEqual(live.find((a) => a.symbol === 'GONE').checks.h1.dead, true);
    // Alerty sprzed dziennika dostały id i trafiły do indeksu (historia, podgląd skuteczności).
    const rs = A.index.rows.find((r) => r.id === seeded.id);
    assert.ok(seeded.id && rs && rs.x.h1 && rs.x.h1[0] === 100, 'dopisanie starszych alertów do dziennika: ' + JSON.stringify(rs));
    // 72 h: zmiana +100%, szczyt +300% i dołek −51,2% ze świec (świeca po końcu okna się nie liczy).
    const r72 = A.index.rows.find((r) => r.id === 'seed72x');
    assert.deepStrictEqual(r72 && r72.x.h72, [100, 300, -51.2, ''], JSON.stringify(r72));
    assert.ok(!live.some((a) => a.id === 'seed72x'), 'lista 24 h nie zawiera starszych alertów');
    // Szczegóły na żądanie.
    const det = await fetch(`http://127.0.0.1:${APP}/api/alert?id=${logged.id}`).then((r) => r.json());
    assert.ok(det.d && det.d.threshold === 45 && det.d.early.parts.demand > 0 && Array.isArray(det.path) && det.price0 > 0);
    assert.strictEqual((await fetch(`http://127.0.0.1:${APP}/api/alert?id=../config`)).status, 404);
    assert.strictEqual(st.config.telegram.connected, true);
    assert.ok(!JSON.stringify(st).includes('AAAAAAAAAAAA'), 'token bota nie może trafić do przeglądarki');

    // NFT: obie kolekcje, Hot Apes na czele, Thin Cats z flagami.
    assert.strictEqual(st.nfts.length, 2);
    assert.strictEqual(st.nfts[0].slug, 'hot-apes');
    assert.strictEqual(st.nfts[0].rank1h, 1);
    const thin = st.nfts.find((c) => c.slug === 'thin-cats');
    assert.ok(thin.s.flags.some((f) => f.code === 'illiquid') && thin.s.flags.some((f) => f.code === 'owners') && thin.s.flags.some((f) => f.code === 'one-day'));

    assert.ok(st.sources.every((s) => s.ok), 'źródła z błędem: ' + JSON.stringify(st.sources.filter((s) => !s.ok)));

    // Ochrona: obcy Host i obce Origin są odrzucane.
    const r1 = await fetch(`http://127.0.0.1:${APP}/api/state`, { headers: { host: 'evil.example' } }).catch(() => ({ status: 403 }));
    const r2 = await fetch(`http://127.0.0.1:${APP}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(r2.status, 403);
    const r3 = await fetch(`http://127.0.0.1:${APP}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alerts: { minScore: 75 } }) }).then((r) => r.json());
    assert.strictEqual(r3.config.alerts.minScore, 75);

    // Drugi skan: brak powtórnego alertu (przerwa 6 h).
    await fetch(`http://127.0.0.1:${APP}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await sleep(4000);
    const sent2 = await fetch(base + '/__sent').then((r) => r.json());
    assert.strictEqual(sent2.filter((m) => m.text.startsWith('🚨')).length, 1);
    assert.strictEqual(sent2.filter((m) => m.text.startsWith('🌱')).length, 1);
    // Publikacja: data.json na gałęzi „data”, jeden commit bez historii, bez żadnych sekretów.
    const gitR = (...a) => execFileSync('git', ['--git-dir', bare, ...a]).toString();
    const pub = JSON.parse(gitR('show', 'data:data.json'));
    assert.ok(pub.tokens.length >= 5 && pub.publishedAt > 0 && pub.config.alerts && pub.alertsCount);
    const pubTxt = JSON.stringify(pub);
    for (const secret of ['AAAAAAAAAAAA', 'kryptoradar_test_bot', '424242', 'pairCode', 'scrypt$']) assert.ok(!pubTxt.includes(secret), 'na GitHub trafiło: ' + secret);
    assert.strictEqual(gitR('rev-list', '--count', 'data').trim(), '1');

    // Komendy z Telegrama: tylko ze sparowanej rozmowy.
    const tgSay = (chat, text, age) => fetch(`${base}/__tgpush?chat=${chat}&age=${age || 0}&text=${encodeURIComponent(text)}`);
    const nSent = (await fetch(base + '/__sent').then((r) => r.json())).length;
    await tgSay(999, '/ustaw wczesny 10');
    await tgSay(424242, '/ustaw wczesny 30', 3600); // sprzed godziny – ma zostać pominięta
    await tgSay(424242, '/ustaw wczesny 52');
    await tgSay(424242, '/ustaw goracy 500');
    await tgSay(424242, '/ustaw sieci solana, base');
    await tgSay(424242, '/status');
    let replies = [];
    for (let i = 0; i < 40 && replies.length < 4; i++) {
      await sleep(250);
      replies = (await fetch(base + '/__sent').then((r) => r.json())).slice(nSent);
    }
    assert.strictEqual(replies.length, 4, 'odpowiedzi: ' + JSON.stringify(replies.map((r) => r.text.slice(0, 40))));
    assert.ok(replies.every((r) => String(r.chat_id) === '424242'), 'obcy nie może dostać odpowiedzi');
    assert.ok(/52/.test(replies[0].text) && /poza dozwolonym zakresem/.test(replies[1].text) && /solana, base/.test(replies[2].text) && /Krypto Radar/.test(replies[3].text));
    const cfgNow = (await fetch(`http://127.0.0.1:${APP}/api/state`).then((r) => r.json())).config;
    assert.strictEqual(cfgNow.early.minScore, 52, 'obcy nie może zmienić ustawień');
    assert.deepStrictEqual(cfgNow.alerts.chains, ['solana', 'base']);
    assert.strictEqual(cfgNow.alerts.minScore, 75);

    // Na GitHub: lista 24 h, indeks 30 dni i szczegóły każdego alertu – bez sekretów.
    const pubLive = JSON.parse(gitR('show', 'data:alerts-live.json'));
    const pubIdx = JSON.parse(gitR('show', 'data:alerts-index.json'));
    const ge = pubLive.alerts.find((a) => a.symbol === 'GOOD' && a.kind === 'momentum');
    assert.ok(ge && pubIdx.rows.some((r) => r.id === ge.id));
    const pubDet = JSON.parse(gitR('show', `data:details/${ge.id}.json`));
    assert.ok(pubDet.d && pubDet.d.momentum.parts.vol > 0);
    assert.ok(!(gitR('ls-tree', '-r', '--name-only', 'data') + JSON.stringify([pubLive, pubIdx, pubDet])).includes('AAAAAAAAAAAA'));

    // Dziennik: pełny zapis alertów, bez sekretów; statystyki w danych strony; /wyniki i /eksport.
    const logDir = path.join(dir, 'data', 'calls');
    const logLines = fs.readdirSync(logDir).flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    const calls = logLines.filter((o) => o.t === 'call');
    assert.deepStrictEqual(calls.filter((c) => !c.backfill && c.id !== 'seed72x').map((c) => c.symbol).sort(), ['EARLY', 'GOOD']);
    assert.deepStrictEqual(calls.filter((c) => c.backfill).map((c) => c.symbol).sort(), ['GONE', 'GOOD']);
    const ce = calls.find((c) => c.symbol === 'EARLY');
    assert.ok(ce.id && ce.price > 0 && ce.liquidityUsd === 60000 && ce.early.parts.demand > 0 && ce.vol.h1 === 12000 && ce.uniq.h1.buyers === 70 && ce.settings.early.minScore === 45 && ce.threshold === 45, JSON.stringify(ce).slice(0, 300));
    assert.ok(!JSON.stringify(logLines).includes('AAAAAAAAAAAA'));
    const pub2 = JSON.parse(gitR('show', 'data:data.json'));
    assert.ok(pub2.alertsCount && pub2.alertsCount.day === 4 && pub2.alertsCount.total === 5, JSON.stringify(pub2.alertsCount));
    assert.ok(!('alerts' in pub2) && !('history' in pub2), 'lista alertów jest w osobnych plikach');
    const nSent2 = (await fetch(base + '/__sent').then((r) => r.json())).length;
    await tgSay(424242, '/wyniki 24h');
    await tgSay(424242, '/eksport');
    let docs = [];
    for (let i = 0; i < 40 && !docs.length; i++) {
      await sleep(250);
      docs = await fetch(base + '/__docs').then((r) => r.json());
    }
    const wyn = (await fetch(base + '/__sent').then((r) => r.json())).slice(nSent2);
    assert.ok(wyn.length && /Skuteczność – 24 h/.test(wyn[0].text) && /Wczesne<\/b> – 3 alertów/.test(wyn[0].text), wyn[0] && wyn[0].text);
    assert.ok(docs.length === 1 && /krypto-radar-alerty-.*\.csv/.test(docs[0]) && /id;czas;rodzaj;symbol/.test(docs[0]) && /EARLY/.test(docs[0]) && /posiadacze przy alercie/.test(docs[0]));

    console.log('✓ całość: źródła, łączenie danych, flagi, alerty, publikacja na GitHub, komendy Telegram, dziennik');
    console.log('\nPrzykładowy wczesny sygnał:\n' + earlyMsgs[0].text + '\n');
    if (process.argv.includes('--keep')) {
      console.log(`Aplikacja testowa działa na http://127.0.0.1:${APP} (Ctrl+C kończy)`);
      await new Promise(() => {});
    }
  } finally {
    if (!process.argv.includes('--keep')) {
      app.kill();
      srv.close();
    }
  }
}

// ---- Dziennik alertów ------------------------------------------------------
function pathUnit() {
  const at = Date.now() - 3 * 3.6e6;
  const a = { type: 'token', key: 'k', at, price0: 1, peak: 1, low: 1, checks: {} };
  for (let m = 1; m <= 180; m++) outcomes.track([a], new Map([['k', { priceUsd: m < 100 ? 1 + m / 100 : 1.5, liquidityUsd: 1 }]]), new Set(), at + m * 60e3);
  assert.ok(a.path.length >= 12 && a.path.length <= 14 && a.path[0][0] === 0, 'punkt co ~15 min: ' + a.path.length);
  assert.strictEqual(a.peak, 1.99);
  assert.strictEqual(Math.round((a.peakAt - at) / 60000), 99);
  assert.ok(a.checks.h1 && a.checks.h1.p === 1.6 && a.checks.h1.chg === 60);
}

function callLogUnit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-log-'));
  const L = new CallLog(dir);
  const t0 = Date.UTC(2026, 9, 31, 23, 0); // alert w październiku, wyniki już w listopadzie
  const call = (id, kind, score, chain) => L.append({ t: 'call', id, at: t0, type: 'token', kind, symbol: id.toUpperCase(), name: 'N;"x"', chain, score, risk: 'none', price: 1, sent: true, flags: [{ sev: 'warn', text: 'Niska płynność' }], vol: { h1: 1000 }, chg: { h1: 2 }, url: 'https://x/' + id });
  call('a', 'early', 72, 'solana');
  call('b', 'early', 52, 'solana');
  call('c', 'momentum', 61, 'base');
  const chk = (id, name, chg, extra) => L.append(Object.assign({ t: 'check', id, at: t0 + 3.6e6, name, chg, p: 1 + chg / 100 }, extra));
  chk('a', 'h1', 20); chk('a', 'h6', 50); chk('a', 'h24', 100);
  chk('b', 'h1', -10); chk('b', 'h6', -60); chk('b', 'h24', -100, { dead: true });
  chk('c', 'h1', 5); L.append({ t: 'check', id: 'c', at: t0 + 25 * 3.6e6, name: 'h24', missed: true });
  L.append({ t: 'check', id: 'a', at: t0 + 72 * 3.6e6, name: 'h72', chg: 300, p: 4, pk: 400, lo: -5 }); // nowy format: szczyt w linii pomiaru
  L.append({ t: 'done', id: 'a', at: t0 + 864e5, peakPct: 150, lowPct: -5, peakMin: 600 });
  L.append({ t: 'done', id: 'b', at: t0 + 864e5, peakPct: 3, lowPct: -100, peakMin: 10 });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['calls-2026-10.jsonl', 'calls-2026-11.jsonl']);
  // Linia pomiaru z wersji, w której godzina pomiaru nadpisała typ linii – ma zostać rozpoznana.
  L.append({ t: t0 + 3.7e6, id: 'c', at: t0 + 3.7e6, name: 'h6', chg: 7, p: 1.07 });
  fs.appendFileSync(path.join(dir, 'calls-2026-11.jsonl'), '{"t":"check","id":"a", uszkodzon'); // przerwany zapis

  const S = new CallLog(dir).summary(t0 + 2 * 864e5); // świeży odczyt z plików
  const e = S.d7.kinds.early, m = S.d7.kinds.momentum;
  assert.strictEqual(S.total, 3);
  assert.deepStrictEqual([e.n, e.h1.up, e.h24.median, e.h24.big, e.h24.bad, e.dead], [2, 50, 0, 50, 50, 1]);
  assert.deepStrictEqual([e.peak.n, e.peak.median, e.peak.p50], [2, 76.5, 50]);
  assert.deepStrictEqual([m.n, m.h1.n, m.h24.n], [1, 1, 0], 'pominięty pomiar nie wchodzi do statystyk');
  assert.strictEqual(new CallLog(dir).calls.get('c').checks.h6.chg, 7, 'stara, uszkodzona linia pomiaru');
  assert.deepStrictEqual([e.h72.n, e.h72.median], [1, 300]);
  // Indeks dla strony: [zmiana, szczyt, dołek, znacznik]; szczyt 24 h ze starego formatu (linia „done”).
  const idx = new CallLog(dir).index(t0 + 2 * 864e5, 30);
  const ia = idx.find((r) => r.id === 'a'), ib = idx.find((r) => r.id === 'b'), ic = idx.find((r) => r.id === 'c');
  assert.deepStrictEqual([ia.t, ia.x.h24, ia.x.h72], ['e', [100, 150, -5, ''], [300, 400, -5, '']]);
  assert.deepStrictEqual([ib.x.h24[3], ic.t, ic.x.h24], ['d', 'm', ['m']]);
  assert.strictEqual(new CallLog(dir).index(t0 + 40 * 864e5, 30).length, 0, 'indeks obejmuje tylko 30 dni');
  assert.deepStrictEqual(S.d7.buckets.early.map((b) => b.n), [0, 1, 0, 1]);
  assert.strictEqual(S.d1.all.n, 0, 'alert sprzed 2 dni nie należy do „24 h”');
  assert.deepStrictEqual(S.d7.chains.map((c) => [c.chain, c.n]), [['solana', 2], ['base', 1]]);

  const csv = L.csv();
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 4);
  const head = lines[0].split(';');
  const rowA = lines.find((l) => l.startsWith('a;'));
  assert.ok(rowA.includes('"N;""x"""'), 'średnik i cudzysłów w nazwie muszą być w cudzysłowie');
  const cols = rowA.replace('"N;""x"""', 'Q').split(';');
  assert.strictEqual(cols[head.indexOf('zmiana po 24h %')], '100');
  assert.strictEqual(cols[head.indexOf('szczyt do 24h %')], '150');
  assert.strictEqual(cols[head.indexOf('szczyt do 72h %')], '400');
  assert.ok(lines.find((l) => l.startsWith('c;')).includes(';pominięty;'));
  const colsB = lines.find((l) => l.startsWith('b;')).replace('"N;""x"""', 'Q').split(';');
  assert.deepStrictEqual([colsB[head.indexOf('zniknął')], colsB[head.indexOf('wykres')]], ['tak', 'https://x/b'], 'zniknięty token oznaczony');
  console.log('✓ dziennik alertów: zapis, wyniki, statystyki według okresu, wyniku i sieci, eksport CSV');
}

// ---- Dane dodatkowe: transakcje, insiderzy, GoPlus, taśma, pilnowanie, kopia ----
async function extrasUnit() {
  const sources = require('../lib/sources');
  const { goplusInfo } = require('../lib/security');
  const { Tape } = require('../lib/tape');
  const { Health } = require('../lib/health');
  const { backup } = require('../lib/backup');
  const zlib = require('zlib');

  // Rozkład transakcji: 7 kupna (portfel w1 kupuje 3 razy), 2 sprzedaże.
  const now = Date.now();
  const mkT = (kind, usd, from, minAgo) => ({ attributes: { kind, volume_in_usd: String(usd), tx_from_address: from, block_timestamp: new Date(now - minAgo * 60e3).toISOString() } });
  const tr = sources.tradesSummary([mkT('buy', 20, 'w1', 0), mkT('buy', 60, 'w1', 1), mkT('buy', 120, 'w1', 2), mkT('buy', 900, 'w3', 3), mkT('buy', 6000, 'w4', 4), mkT('buy', 30, 'w5', 5), mkT('buy', 45, 'w6', 6), mkT('sell', 100, 's0', 10), mkT('sell', 300, 's1', 11)], now);
  assert.deepStrictEqual([tr.n, tr.buy.n, tr.buy.sum, tr.buy.med, tr.whales, tr.uniqueBuyers, tr.repeatBuyers, tr.top5Share, tr.netUsd, tr.spanMin], [9, 7, 7175, 60, 1, 5, 1, 100, 6775, 11]);
  assert.deepStrictEqual(tr.bucketsBuy, [3, 2, 1, 1]);
  assert.strictEqual(sources.tradesSummary([], now), null);

  // RugCheck: insiderzy, twórca, płynność; brak pól nie wywraca odczytu.
  const rc = sources.rugcheckInfo({ totalHolders: 1234, graphInsidersDetected: 7, token: { supply: 1e9 }, creatorBalance: 2.5e7, topHolders: [{ pct: 10, insider: true }, { pct: 5 }, { pct: 4, insider: true }], insiderNetworks: [{ size: 4 }, { size: 3 }], markets: [{ lp: { lpLockedPct: 99.5 } }, { lp: { lpLockedPct: 20 } }] });
  assert.deepStrictEqual([rc.holders, rc.top10Pct, rc.insiderPctTop, rc.insiderHoldersTop, rc.insidersDetected, rc.insiderNetworks, rc.creatorPct, rc.lpLockedPct], [1234, 19, 14, 2, 7, 2, 2.5, 99.5]);
  assert.deepStrictEqual(Object.values(sources.rugcheckInfo({})).filter((v) => v != null && v !== false && !(Array.isArray(v) && !v.length) && v !== 0), []);

  // GoPlus: posiadacze, twórca, zablokowana płynność – z tej samej odpowiedzi co flagi.
  const gp = goplusInfo({ holder_count: '842', creator_percent: '0.051', owner_percent: '0', buy_tax: '0.01', sell_tax: '0.05', lp_holder_count: '3', lp_holders: [{ percent: '0.9', is_locked: 1 }, { percent: '0.05', address: '0x000000000000000000000000000000000000dead' }, { percent: '0.05' }], holders: [{ percent: '0.2' }, { percent: '0.1', is_contract: 1 }] });
  assert.deepStrictEqual([gp.holders, gp.creatorPct, gp.ownerPct, gp.lpLockedPct, gp.buyTax, gp.sellTax, gp.top10Pct], [842, 5.1, 0, 95, 1, 5, 20]);

  // Taśma: wczorajszy plik jest pakowany przy pierwszym zapisie nowego dnia, odczyt czyta oba.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-tape-'));
  const T = new Tape(tdir);
  const tok = { key: 'solana:X', symbol: 'X', chain: 'solana', priceUsd: 0.0012345678, liquidityUsd: 50000.4, marketCap: 1e6, vol: { m5: 1, h1: 2, h6: 3, h24: 4 }, txns: { m5: { buys: 1, sells: 2 }, h1: { buys: 3, sells: 4 }, h24: { buys: 5, sells: 6 } }, chg: { m5: 1.23, h1: 2, h6: 3, h24: 4 }, s: { score: 61.26, momentum: 70, risk: 'med', parts: { ageH: 5.55 }, flags: [{ sev: 'warn', code: 'liq-low' }, { sev: 'info', code: 'new' }] }, e: { score: 50, raw: 55, inScope: true }, sources: ['gt-trending'], security: 'checked', holders: 900, alerted: 'e' };
  const day1 = Date.UTC(2026, 9, 10, 23, 58), day2 = Date.UTC(2026, 9, 11, 0, 3);
  T.write(day1, [tok], { sol: { h1: 1 } });
  T.write(day2, [tok, tok], null);
  assert.deepStrictEqual(fs.readdirSync(tdir).sort(), ['tape-2026-10-10.jsonl.gz', 'tape-2026-10-11.jsonl']);
  const rec = [...T.read()];
  assert.deepStrictEqual([rec.length, rec[0].market.sol.h1, rec[1].tokens.length], [2, 1, 2]);
  const c0 = rec[0].tokens[0];
  assert.deepStrictEqual([c0.k, c0.p, c0.l, c0.t1, c0.sc, c0.in, c0.f, c0.h, c0.al, c0.a], ['solana:X', 0.00123457, 50000, [3, 4], 61.3, 1, ['liq-low'], 900, 'e', 5.6]);

  // Pilnowanie: wiadomość po 30 min awarii i po powrocie, nie wcześniej.
  const H = new Health({ afterMin: 30 });
  const t0 = 1e12;
  assert.strictEqual(H.check([{ name: 'A', ok: false, error: 'HTTP 500' }], t0).length, 0);
  assert.strictEqual(H.check([{ name: 'A', ok: false, error: 'HTTP 500' }], t0 + 29 * 60e3).length, 0);
  const down = H.check([{ name: 'A', ok: false, error: 'HTTP 500' }], t0 + 31 * 60e3);
  assert.ok(down.length === 1 && /nie działa od 31 min/.test(down[0]));
  assert.strictEqual(H.check([{ name: 'A', ok: false }], t0 + 40 * 60e3).length, 0, 'tylko raz');
  assert.ok(/znowu działa/.test(H.check([{ name: 'A', ok: true }], t0 + 50 * 60e3)[0]));
  assert.strictEqual(H.check([{ name: 'B', ok: false }], t0).length + H.check([{ name: 'B', ok: true }], t0 + 60e3).length, 0, 'krótka przerwa bez wiadomości');

  // Kopia: bez katalogu publikacji i bez taśmy (taśma kopiowana osobno), rotacja do `keep`.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-src-'));
  fs.mkdirSync(path.join(src, 'data', 'publish'), { recursive: true });
  fs.mkdirSync(path.join(src, 'data', 'tape'), { recursive: true });
  fs.writeFileSync(path.join(src, 'config.json'), '{}');
  fs.writeFileSync(path.join(src, 'data', 'state.json'), '{}');
  fs.writeFileSync(path.join(src, 'data', 'publish', 'data.json'), '{}');
  fs.writeFileSync(path.join(src, 'data', 'tape', 'tape-2026-10-10.jsonl.gz'), zlib.gzipSync('x'));
  const bdir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-bk-')), 'kopie');
  for (const d of [8, 9, 10]) await backup(src, bdir, 2, new Date(Date.UTC(2026, 9, d, 4)));
  assert.deepStrictEqual(fs.readdirSync(bdir).sort(), ['krypto-radar-dane-2026-10-09.tar.gz', 'krypto-radar-dane-2026-10-10.tar.gz', 'tape']);
  const list = execFileSync('tar', ['-tzf', path.join(bdir, 'krypto-radar-dane-2026-10-10.tar.gz')]).toString();
  assert.ok(/config\.json/.test(list) && /state\.json/.test(list) && !/publish/.test(list) && !/tape/.test(list), list);
  assert.deepStrictEqual(fs.readdirSync(path.join(bdir, 'tape')), ['tape-2026-10-10.jsonl.gz']);
  const { tgLinkKind } = require('../lib/sources');
  const kinds = ['', 'https://t.me/+AbC123', 'https://t.me/joinchat/AAAA', 'https://telegram.me/somechan', 'https://t.me/s/somechan', 'https://t.me/somechan/123', '@somechan', 'tg://resolve?domain=somechan', 'https://t.me/addlist/xyz', 'https://t.me/pepe_buy_bot', 'https://example.com']
    .map((l) => tgLinkKind(l).s);
  assert.deepStrictEqual(kinds, ['none', 'private', 'private', 'public', 'public', 'public', 'public', 'public', 'folder', 'bot', 'invalid']);
  const tgl = require('../lib/telegram').tgLine;
  assert.strictEqual(tgl({ tg: { s: 'private' } }), '🔒 Telegram: prywatny (tylko link z zaproszeniem)');
  assert.strictEqual(tgl({ tg: { s: 'none' } }), '➖ Telegram: brak');
  assert.strictEqual(tgl({ tg: { s: 'public', type: 'group', title: 'A<b>', n: 12345 } }), '📢 Telegram: grupa „A&lt;b&gt;” – 12\u00a0345 członków'.replace('\\u00a0', '\u00a0'));
  console.log('✓ dane dodatkowe: rozkład transakcji, insiderzy, GoPlus, taśma, pilnowanie, kopia');
}

// ---- Logowanie, dozwolone adresy, nagłówki ----------------------------------
async function access() {
  // Hasło i sesja.
  const h = auth.hashPassword('dobre-haslo-123');
  assert.ok(auth.verifyPassword('dobre-haslo-123', h) && !auth.verifyPassword('zle-haslo-1234', h));
  const sec = auth.newSecret();
  const sess = auth.makeSession(sec);
  assert.ok(auth.checkSession(sec, sess));
  assert.ok(!auth.checkSession(sec, sess.slice(0, -2) + 'xx'), 'podrobiony podpis');
  assert.ok(!auth.checkSession(auth.newSecret(), sess), 'inny sekret (po zmianie hasła)');
  assert.ok(!auth.checkSession(sec, sess, Date.now() + 31 * 864e5), 'wygasła sesja');

  // Przerwa po 429: drugi strzał w ten sam serwis nie wychodzi do sieci.
  const srv429 = require('http').createServer((q, r) => { srv429.hits = (srv429.hits || 0) + 1; r.writeHead(429, { 'retry-after': '120' }); r.end('slow down'); });
  await new Promise((r) => srv429.listen(9915, '127.0.0.1', r));
  await sources.fetchJson('http://127.0.0.1:9915/a').catch((e) => assert.strictEqual(e.status, 429));
  await sources.fetchJson('http://127.0.0.1:9915/b').catch((e) => assert.ok(e.status === 429 && e.backoff));
  assert.strictEqual(srv429.hits, 1);
  srv429.close();

  // Aplikacja z hasłem.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-auth-'));
  const PORT = APP + 1;
  const base = `http://127.0.0.1:${MOCK}`;
  const conf = (extra) => JSON.stringify(Object.assign({
    port: PORT, scanIntervalSec: 3600, nftIntervalSec: 3600,
    auth: { passwordHash: h, secret: sec },
    telegram: { token: '123456789:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', chatId: '555' }, // osobna rozmowa niż w teście wyżej
    api: { dexscreener: base + '/ds', geckoterminal: base + '/gt', coingecko: base + '/cg', pumpfun: base + '/pf', opensea: base + '/os', rugcheck: base + '/rc', goplus: base + '/gp', telegram: base + '/tg' },
  }, extra || {}));
  fs.writeFileSync(path.join(dir, 'config.json'), conf());
  const srv = await mock.start(MOCK);
  // Pierwsza wiadomość na Telegram „nie dojdzie” – alert ma zostać ponowiony, a nie przepaść.
  const sentBefore = (await fetch(base + '/__sent').then((r) => r.json())).length;
  await fetch(base + '/__failsends?n=1');
  const env = Object.assign({}, process.env, { RADAR_CONFIG: path.join(dir, 'config.json'), RADAR_DATA: path.join(dir, 'data') });
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const U = `http://127.0.0.1:${PORT}`;
  const req = (p, o) => fetch(U + p, Object.assign({ redirect: 'manual' }, o || {}));
  const login = (pw) => req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: U }, body: 'password=' + encodeURIComponent(pw) });
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (await req('/login').then(() => true, () => false)) break;
    }
    const r1 = await req('/');
    assert.strictEqual(r1.status, 303);
    assert.strictEqual(r1.headers.get('location'), '/login');
    assert.strictEqual((await req('/api/state')).status, 401);
    assert.strictEqual((await req('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

    const ok = await login('dobre-haslo-123');
    assert.strictEqual(ok.status, 303);
    const cookie = ok.headers.get('set-cookie');
    assert.ok(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
    const jar = { cookie: cookie.split(';')[0] };
    const st = await req('/api/state', { headers: jar });
    assert.strictEqual(st.status, 200);
    assert.ok(!JSON.stringify(await st.json()).includes('scrypt$'), 'skrót hasła nie może trafić do przeglądarki');
    const page = await req('/', { headers: jar });
    assert.strictEqual(page.status, 200);
    assert.ok(/script-src 'self'/.test(page.headers.get('content-security-policy')) && page.headers.get('x-frame-options') === 'DENY');
    assert.ok(/<script src="app.js\?v=\d+">/.test(await page.text()));
    assert.strictEqual((await req('/app.js', { headers: jar })).status, 200);
    assert.strictEqual((await req('/app.js')).status, 401, 'skrypt panelu też tylko po zalogowaniu');
    assert.strictEqual((await req('/api/state', { headers: { cookie: jar.cookie.slice(0, -3) + 'abc' } })).status, 401);

    // Nazwa tego komputera jest dozwolona, obca nie (fetch nie pozwala ustawić Host, więc http.request).
    const withHost = (host) => new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: Object.assign({ host }, jar) }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.strictEqual(await withHost(`${os.hostname()}:${PORT}`), 200);
    assert.strictEqual(await withHost(`127.0.0.1:${PORT}`), 200);
    assert.strictEqual(await withHost(`evil.example:${PORT}`), 403);
    assert.strictEqual(await withHost(`127.0.0.1:${PORT}.evil.example`), 403);
    assert.strictEqual(await withHost(`${os.hostname()}:1234`), 403);
    assert.strictEqual((await req('/api/scan', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', origin: 'http://evil.example' }, jar), body: '{}' })).status, 403);

    // Alert, którego wysyłka się nie udała, wychodzi w następnym skanie – i tylko raz.
    const idle = async () => {
      for (let i = 0; i < 60; i++) {
        const x = await (await req('/api/state', { headers: jar })).json();
        if (x.scans && !x.scanning) return x;
        await sleep(250);
      }
      throw new Error('skan się nie skończył');
    };
    await idle();
    const early1 = (await fetch(base + '/__sent').then((r) => r.json())).slice(sentBefore).filter((m) => m.text.startsWith('🌱'));
    assert.strictEqual(early1.length, 0, 'pierwsza próba miała się nie udać: ' + JSON.stringify((await fetch(base + '/__sent').then((r) => r.json())).slice(sentBefore).map((m) => m.text.slice(0, 50))));
    await req('/api/scan', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, jar), body: '{}' });
    await sleep(500);
    await idle();
    const after = (await fetch(base + '/__sent').then((r) => r.json())).slice(sentBefore);
    assert.strictEqual(after.filter((m) => m.text.startsWith('🌱')).length, 1, 'wczesny sygnał powinien wyjść w drugim skanie');
    assert.strictEqual(after.filter((m) => m.text.startsWith('🚨')).length, 1);
    const st2 = (await (await req('/api/alerts', { headers: jar })).json()).live;
    assert.strictEqual(st2.alerts.filter((a) => a.kind === 'early').length, 1);
    assert.ok(st2.alerts.every((a) => a.sent), 'zapisane alerty powinny być wysłane');
    assert.strictEqual((await req('/api/alerts')).status, 401, 'lista alertów tylko po zalogowaniu');

    // Zgadywanie hasła: po 5 błędach blokada – nawet dobre hasło nie przechodzi.
    for (let i = 0; i < 5; i++) assert.strictEqual((await login('zle-haslo-' + i)).status, 401);
    assert.strictEqual((await login('dobre-haslo-123')).status, 429);
  } finally {
    app.kill();
    srv.close();
  }

  // Dostęp z sieci bez hasła: aplikacja odmawia startu.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-open-'));
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ port: PORT + 1, host: '0.0.0.0' }));
  const code = await new Promise((r) => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { RADAR_CONFIG: path.join(dir2, 'config.json'), RADAR_DATA: path.join(dir2, 'data') }), stdio: 'ignore' }).on('exit', r));
  assert.strictEqual(code, 1);

  // Ustawianie hasła z wiersza poleceń.
  const sp = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--set-password'], { env: Object.assign({}, process.env, { RADAR_CONFIG: path.join(dir2, 'config.json'), RADAR_DATA: path.join(dir2, 'data') }), stdio: ['pipe', 'ignore', 'ignore'] });
  sp.stdin.end('nowe-haslo-xyz\nnowe-haslo-xyz\n');
  assert.strictEqual(await new Promise((r) => sp.on('exit', r)), 0);
  const c2 = JSON.parse(fs.readFileSync(path.join(dir2, 'config.json'), 'utf8'));
  assert.ok(auth.verifyPassword('nowe-haslo-xyz', c2.auth.passwordHash) && c2.auth.secret.length === 64);
  assert.strictEqual((fs.statSync(path.join(dir2, 'config.json')).mode & 0o777).toString(8), '600');
  console.log('✓ dostęp: hasło, sesje, blokada zgadywania, dozwolone adresy, CSP, przerwy po 429');
}

(async () => {
  unit();
  pathUnit();
  callLogUnit();
  await extrasUnit();
  await integration();
  await access();
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
