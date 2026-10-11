#!/usr/bin/env node
'use strict';
// Krypto Radar – lokalny skaner tokenów i kolekcji NFT z alertami na Telegram.
// Bez zewnętrznych bibliotek: wystarczy Node.js 18 lub nowszy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Ta aplikacja wymaga Node.js w wersji 18 lub nowszej (masz ' + process.version + ').');
  process.exit(1);
}

const { collectTokens, collectNfts, annotateUniq } = require('./lib/sources');
const { scoreToken, scoreEarly, scoreNft } = require('./lib/score');
const security = require('./lib/security');
const tg = require('./lib/telegram');
const outcomes = require('./lib/outcomes');
const auth = require('./lib/auth');
const { Publisher } = require('./lib/publish');
const tgbot = require('./lib/tgbot');
const { CallLog } = require('./lib/calllog');

const ROOT = __dirname;
const CONFIG_PATH = process.env.RADAR_CONFIG || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.RADAR_DATA || path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const MIN_SCAN_SEC = 45; // GeckoTerminal bez klucza: ~10 zapytań/min, a jeden skan to do 6

const DEFAULTS = {
  port: 8787,
  // 127.0.0.1 – tylko ten komputer; 0.0.0.0 – cała sieć lokalna (wtedy hasło jest obowiązkowe).
  host: '127.0.0.1',
  // Dodatkowe nazwy, pod którymi otwierasz aplikację (np. nazwa z Tailscale). Własne adresy IP
  // i nazwa komputera są dozwolone automatycznie.
  allowedHosts: [],
  auth: { passwordHash: '', secret: '', secureCookie: false },
  scanIntervalSec: 60,
  nftIntervalSec: 600,
  minVolume24hUsd: 1000,
  alerts: {
    enabled: true,
    minScore: 55,
    cooldownHours: 6,
    maxPerScan: 3,
    minLiquidityUsd: 20000,
    minVolume1hUsd: 10000,
    allowBondingCurve: true,
    minMarketCapUsd: 30000,
    chains: [],
    nft: true,
    nftMinScore: 50,
  },
  // Wczesne sygnały (zakres A): po migracji z krzywej, z realną płynnością.
  early: {
    enabled: true,
    minScore: 45,
    minLiquidityUsd: 20000,
    minVolume1hUsd: 5000,
    minAgeMin: 30,
    maxMarketCapUsd: 10000000,
  },
  // Tokeny obserwowane po zejściu z list – żeby wyłapać ruch, zanim wrócą do trendów.
  watch: { max: 400, hours: 48, minLiquidityUsd: 10000, minVolume24hUsd: 5000 },
  telegram: { token: '', chatId: '', pairCode: '' },
  opensea: { apiKey: '' },
  security: { enabled: true, perScan: 10 },
  // Wysyłanie danych na GitHuba (strona na GitHub Pages czyta je z gałęzi `branch`).
  publish: { enabled: false, repo: '', branch: 'data', intervalSec: 120, keyPath: '' },
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Nie mogę odczytać ${path.basename(p)}: ${e.message}`);
    return fallback;
  }
}
function writeJson(p, obj, mode, compact) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
  fs.renameSync(tmp, p);
}

let cfg = merge(DEFAULTS, readJson(CONFIG_PATH, {}));
const saveConfig = () => writeJson(CONFIG_PATH, cfg, 0o600);
if (!fs.existsSync(CONFIG_PATH)) saveConfig();
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

const state = merge({ alerted: {}, firstSeen: {}, cold: {}, watch: {}, alerts: [], nftSeen: {}, nftFloor: {}, nftSeeded: false, tgOffset: 0 }, readJson(STATE_PATH, {}));
// Na karcie SD nie zapisujemy stanu po każdym skanie: od razu tylko po nowym alercie,
// poza tym co 5 minut i przy zamykaniu aplikacji.
let lastSave = 0, stateDirty = false;
// Dziennik alertów (na stałe, poza state.json): DATA_DIR/calls/calls-RRRR-MM.jsonl
const calllog = new CallLog(path.join(DATA_DIR, 'calls'));

const saveState = (force) => {
  if (!force && !stateDirty && Date.now() - lastSave < 5 * 60e3) return;
  try {
    writeJson(STATE_PATH, state, 0o600, true);
    lastSave = Date.now();
    stateDirty = false;
  } catch (e) {
    console.error('Nie mogę zapisać stanu: ' + e.message);
  }
};

let STARTED = Date.now();
const cache = {};
const snapshot = { tokens: [], nfts: [], topics: { metas: [], coins: [], categories: [], cgNfts: [] }, scannedAt: null, nftScannedAt: null, scans: 0, scanning: false, scanMs: null };
const status = new Map();
const prevScores = new Map();
let tgInfo = { bot: null, error: null };

const report = (name, ok, count, error) => status.set(name, { name, ok, count: count || 0, error: error || null, at: Date.now() });
const log = (msg) => console.log(new Date().toLocaleTimeString('pl-PL') + '  ' + msg);

// ---- Alerty -----------------------------------------------------------------

function liquidityOk(t) {
  const a = cfg.alerts;
  if (t.liquidityUsd != null) return t.liquidityUsd >= a.minLiquidityUsd;
  return !!(t.bondingCurve && a.allowBondingCurve && (t.marketCap || t.fdv || 0) >= a.minMarketCapUsd);
}
function eligibleBase(t) {
  const a = cfg.alerts;
  if (t.s.score < a.minScore || t.s.risk === 'crit') return false;
  if (a.chains && a.chains.length && !a.chains.includes(t.chain)) return false;
  if ((t.vol.h1 || 0) < a.minVolume1hUsd) return false;
  return liquidityOk(t);
}
function eligible(t) {
  if (!eligibleBase(t)) return false;
  // Nie wysyłamy alertu, dopóki kontrakt czeka w kolejce do sprawdzenia.
  if (cfg.security.enabled && security.supported(t) && !t.security) return false;
  return true;
}

const earlyScope = () => ({ minLiquidityUsd: cfg.early.minLiquidityUsd, minAgeMin: cfg.early.minAgeMin, maxMarketCapUsd: cfg.early.maxMarketCapUsd });
function eligibleEarlyBase(t) {
  const a = cfg.alerts, e = cfg.early;
  if (!t.e || !t.e.inScope) return false;
  if (t.e.score < e.minScore || t.s.risk === 'crit') return false;
  if (a.chains && a.chains.length && !a.chains.includes(t.chain)) return false;
  return (t.vol.h1 || 0) >= e.minVolume1hUsd;
}
function eligibleEarly(t) {
  if (!eligibleEarlyBase(t)) return false;
  if (cfg.security.enabled && security.supported(t) && !t.security) return false;
  return true;
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
function pushAlert(entry) {
  stateDirty = true;
  entry.id = entry.id || newId();
  if (entry.type === 'token') Object.assign(entry, { peakAt: entry.at, lowAt: entry.at, path: [[0, entry.price0]] });
  state.alerts.unshift(entry);
  // Lista robocza do pomiaru i panelu; pełna historia jest w dzienniku (calllog).
  const cutoff = Date.now() - 30 * 24 * 3.6e6;
  state.alerts = state.alerts.filter((a) => a.at >= cutoff).slice(0, 3000);
  return entry;
}

// Pełny obraz tokena w chwili alertu – do późniejszej analizy, co działało.
function tokenSnapshot(t, kind, entry, threshold) {
  const s = t.s, e = t.e;
  return {
    t: 'call', id: entry.id, at: entry.at, iso: new Date(entry.at).toISOString(), type: 'token', kind,
    sent: entry.sent, error: entry.error || null,
    symbol: t.symbol, name: t.name, chain: t.chain, address: t.address, pairAddress: t.pairAddress, dexId: t.dexId,
    url: t.url, pumpUrl: t.pumpUrl || null, dataFrom: t.dataFrom,
    score: entry.score, threshold, risk: s.risk,
    price: t.priceUsd, liquidityUsd: t.liquidityUsd, marketCap: t.marketCap, fdv: t.fdv,
    createdAt: t.createdAt, ageH: s.parts.ageH, seenMin: t.seenMin,
    vol: t.vol, txns: t.txns, chg: t.chg, buyRatio: s.parts.buyRatio, tx1: s.parts.tx1,
    uniq: t.uniq || null, lockedLiqPct: t.lockedLiqPct == null ? null : t.lockedLiqPct, boostsActive: t.boostsActive,
    sources: t.sources, metas: (t.metas || []).map((m) => m.name), socials: t.socials,
    isPump: t.isPump, bondingCurve: t.bondingCurve, pump: t.pump || null,
    security: t.security || null, flags: s.flags,
    momentum: { score: s.score, raw: s.momentum, penalty: s.penalty, parts: { vol: s.parts.vol, act: s.parts.act, buy: s.parts.buy, price: s.parts.price, attn: s.parts.attn } },
    early: e ? { score: e.score, raw: e.raw, parts: e.parts, late: e.late, penalty: e.penalty, volX: e.volX, txX: e.txX, inScope: e.inScope, why: e.why } : null,
    settings: { alerts: cfg.alerts, early: cfg.early },
  };
}

const telegramReady = () => !!(cfg.telegram.token && cfg.telegram.chatId);
async function deliver(html) {
  if (!telegramReady()) return { sent: false, error: 'Telegram niepołączony' };
  try {
    await tg.send(cfg, html);
    return { sent: true, error: null };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// kind: 'early' (wczesny sygnał) albo 'momentum' (już gorący token).
async function tokenAlerts(tokens, now, kind) {
  const early = kind === 'early';
  if (!cfg.alerts.enabled || (early && !cfg.early.enabled)) return 0;
  const cool = cfg.alerts.cooldownHours * 3.6e6;
  const list = early ? tokens.filter((t) => t.e && t.e.inScope).sort((a, b) => b.e.score - a.e.score) : tokens;
  let n = 0;
  for (const t of list) {
    if (n >= cfg.alerts.maxPerScan) break;
    if (!(early ? eligibleEarly(t) : eligible(t))) continue;
    const mark = (early ? 'e:' : '') + t.key;
    if (state.alerted[mark] && now - state.alerted[mark] < cool) continue;
    // Token, który jest już „gorący” albo dostał taki alert, nie jest wczesnym sygnałem.
    if (early && (eligibleBase(t) || (state.alerted[t.key] && now - state.alerted[t.key] < cool))) continue;
    const res = await deliver(early ? tg.earlyAlert(t) : tg.tokenAlert(t));
    if (!res.sent && telegramReady()) {
      // Telegram jest połączony, ale wiadomość nie doszła (sieć, limit) – nie zapisujemy alertu,
      // żeby przerwa 6 h go nie „zjadła”. Spróbujemy w następnym skanie.
      log(`Nie wysłano alertu ${t.symbol}: ${res.error} – ponowię w następnym skanie`);
      break;
    }
    state.alerted[mark] = now;
    const score = early ? t.e.score : t.s.score;
    const entry = pushAlert({
      at: now, type: 'token', kind, key: t.key, chain: t.chain, address: t.address, symbol: t.symbol, name: t.name,
      score, risk: t.s.risk, url: t.url, sent: res.sent, error: res.error,
      price0: t.priceUsd, liq0: t.liquidityUsd, mc0: t.marketCap || t.fdv || null, peak: t.priceUsd, low: t.priceUsd, checks: {},
    });
    try {
      calllog.append(tokenSnapshot(t, kind, entry, early ? cfg.early.minScore : cfg.alerts.minScore));
    } catch (e) {
      log('Nie mogę zapisać alertu w dzienniku: ' + e.message);
    }
    log(`${early ? 'Wczesny sygnał' : 'Alert'}: ${t.symbol} (${t.chain}), wynik ${Math.round(score)}${res.sent ? ' – wysłano na Telegram' : ' – ' + res.error}`);
    n++;
  }
  return n;
}

// ---- Skan tokenów -----------------------------------------------------------

const newPairCode = () => String(crypto.randomInt(100000, 1000000));
async function ensureTelegramChat() {
  if (!cfg.telegram.token || cfg.telegram.chatId) return;
  if (!cfg.telegram.pairCode) {
    cfg.telegram.pairCode = newPairCode();
    saveConfig();
  }
  try {
    if (!tgInfo.bot) tgInfo.bot = await tg.botName(cfg);
    tgInfo.error = null;
    const found = await tg.discoverChat(cfg);
    if (found) {
      cfg.telegram.chatId = String(found.chatId);
      cfg.telegram.pairCode = '';
      saveConfig();
      await tg.ackUpdates(cfg, found.updateId);
      log('Telegram połączony z rozmową: ' + (found.title || found.chatId));
      await deliver('✅ Krypto Radar połączony. Tu będą przychodzić alerty.');
    }
  } catch (e) {
    tgInfo.error = /401|404/.test(e.message) ? 'Telegram nie rozpoznaje tego tokenu bota' : e.message;
  }
}

function logSafe(o) {
  try {
    calllog.append(o);
  } catch (e) {
    log('Nie mogę zapisać w dzienniku: ' + e.message);
  }
}

async function scanTokens() {
  const t0 = Date.now();
  // Poza listami źródeł odświeżamy też tokeny po alercie (do pomiaru skuteczności) i obserwowane.
  const extra = [];
  for (const a of state.alerts) {
    if (!outcomes.tracked(a) || a.done) continue;
    const i = a.key.indexOf(':');
    extra.push({ chain: a.chain || a.key.slice(0, i), address: a.address || a.key.slice(i + 1) });
  }
  for (const w of Object.values(state.watch)) extra.push({ chain: w.c, address: w.a });

  const { tokens, topics, all, asked } = await collectTokens(cfg, cache, report, extra);
  const now = Date.now();
  const scope = earlyScope();
  const rescore = (t) => {
    t.s = scoreToken(t, now);
    t.e = scoreEarly(t, now, t.s.flags, scope);
  };

  for (const t of tokens) {
    if (!state.firstSeen[t.key]) {
      state.firstSeen[t.key] = now;
      // Tuż po starcie wszystko jest „nowe” – takich tokenów nie traktujemy jako świeżych.
      if (now - STARTED < 3 * 60 * 1000) state.cold[t.key] = 1;
    }
    t.firstSeen = state.firstSeen[t.key];
    t.seenMin = state.cold[t.key] ? null : Math.round((now - t.firstSeen) / 60000);
    t.isNew = t.seenMin != null && t.seenMin < 30;
    rescore(t);
  }

  // Unikalni kupujący dla czołówki wczesnych sygnałów.
  const topEarly = tokens.filter((t) => t.e.inScope).sort((a, b) => b.e.score - a.e.score).slice(0, 60);
  if (topEarly.length) {
    try {
      await annotateUniq(topEarly, cfg, cache, report);
    } catch (e) {
      report('GeckoTerminal – unikalni kupujący', false, 0, e.message);
    }
    topEarly.forEach(rescore);
  }

  if (cfg.security.enabled) {
    // Najpierw kontrakty tokenów, które mogłyby wywołać alert, potem reszta wg wyniku.
    const cand = (t) => Number(eligibleEarlyBase(t) || eligibleBase(t));
    const order = tokens.slice().sort((a, b) => cand(b) - cand(a) || Math.max(b.s.momentum, b.e.raw) - Math.max(a.s.momentum, a.e.raw));
    await security.annotate(order, cfg, cache, cfg.security.perScan, report);
    for (const t of tokens) if (t.securityFlags && t.securityFlags.length) rescore(t);
  }

  for (const t of tokens) {
    const prev = prevScores.get(t.key);
    t.delta = prev == null ? null : Math.round((t.s.score - prev) * 10) / 10;
  }
  tokens.sort((a, b) => b.s.score - a.s.score || b.s.momentum - a.s.momentum);
  prevScores.clear();
  for (const t of tokens) prevScores.set(t.key, t.s.score);

  // Pomiar wyników: każdy nowy wynik (po 1/6/24 h) i zamknięcie po 24 h trafia też do dziennika.
  const prev = new Map(state.alerts.map((a) => [a, { keys: Object.keys(a.checks || {}), done: !!a.done }]));
  outcomes.track(state.alerts, all, asked, now);
  for (const a of state.alerts) {
    const b = prev.get(a);
    if (!b) continue;
    for (const name of Object.keys(a.checks || {})) {
      if (b.keys.includes(name)) continue;
      stateDirty = true;
      if (a.id) logSafe({ t: 'check', id: a.id, at: now, name, ...a.checks[name] });
    }
    if (a.done && !b.done) {
      stateDirty = true;
      if (a.id) {
        logSafe({
          t: 'done', id: a.id, at: now, peak: a.peak, peakAt: a.peakAt, low: a.low, lowAt: a.lowAt,
          peakPct: Math.round((a.peak / a.price0 - 1) * 1000) / 10, lowPct: Math.round((a.low / a.price0 - 1) * 1000) / 10,
          peakMin: a.peakAt ? Math.round((a.peakAt - a.at) / 60000) : null, path: a.path || null,
        });
      }
    }
  }
  const sentEarly = await tokenAlerts(tokens, now, 'early');
  const sent = await tokenAlerts(tokens, now, 'momentum');

  // Lista obserwowanych: tokeny z sensowną płynnością i obrotem, najwyżej 48 h od pierwszego pojawienia.
  const W = cfg.watch;
  for (const t of tokens) {
    if (t.liquidityUsd != null && t.liquidityUsd >= W.minLiquidityUsd && (t.vol.h24 || 0) >= W.minVolume24hUsd) {
      state.watch[t.key] = { c: t.chain, a: t.address, t: now, f: t.firstSeen };
    }
  }
  for (const k of Object.keys(state.watch)) {
    const w = state.watch[k];
    if (now - w.t > 6 * 3.6e6 || now - w.f > W.hours * 3.6e6) delete state.watch[k];
  }
  const wk = Object.keys(state.watch);
  if (wk.length > W.max) {
    wk.sort((a, b) => state.watch[b].f - state.watch[a].f);
    for (const k of wk.slice(W.max)) delete state.watch[k];
  }

  // Sprzątanie pamięci: znaczniki starsze niż 3 dni.
  for (const m of [state.alerted, state.firstSeen]) for (const k of Object.keys(m)) if (now - m[k] > 72 * 3.6e6) delete m[k];
  for (const k of Object.keys(state.cold)) if (!state.firstSeen[k]) delete state.cold[k];

  if (tokens.length || !snapshot.tokens.length) {
    // Do przeglądarki: czołówka wg wyniku „gorące” oraz czołówka wczesnych sygnałów.
    const keep = new Set(tokens.slice(0, 250));
    for (const t of tokens.filter((x) => x.e.inScope).sort((a, b) => b.e.score - a.e.score).slice(0, 150)) keep.add(t);
    snapshot.tokens = tokens.filter((t) => keep.has(t));
    snapshot.topics = Object.assign({ metas: [], coins: [], categories: [], cgNfts: [] }, topics);
    snapshot.counts = { all: tokens.length, early: tokens.filter((t) => t.e.inScope).length, watch: Object.keys(state.watch).length };
  }
  snapshot.scannedAt = now;
  snapshot.scans++;
  snapshot.scanMs = Date.now() - t0;
  saveState();
  const top = tokens[0];
  const topE = tokens.filter((t) => t.e.inScope).sort((a, b) => b.e.score - a.e.score)[0];
  log(
    `Skan ${snapshot.scans}: ${tokens.length} tokenów` +
      (topE ? `, wczesny lider ${topE.symbol} (${Math.round(topE.e.score)})` : '') +
      (top ? `, gorący lider ${top.symbol} (${Math.round(top.s.score)})` : '') +
      (sentEarly ? `, wczesne sygnały: ${sentEarly}` : '') +
      (sent ? `, alerty: ${sent}` : '')
  );
}

// ---- Skan NFT ---------------------------------------------------------------

async function scanNfts() {
  const cols = await collectNfts(cfg, state, cache, report);
  const now = Date.now();
  for (const c of cols) {
    const hist = (state.nftFloor[c.slug] = (state.nftFloor[c.slug] || []).filter((x) => now - x.t < 26 * 3.6e6));
    if (c.floor != null) hist.push({ t: now, f: c.floor });
    const old = hist.find((x) => now - x.t >= 3.6e6);
    c.floorChangePct = old && old.f > 0 && c.floor != null ? ((c.floor - old.f) / old.f) * 100 : null;
    c.floorSinceH = old ? Math.round((now - old.t) / 3.6e6) : null;
    c.s = scoreNft(c);
  }
  cols.sort((a, b) => b.s.score - a.s.score);

  const retry = new Set(); // kolekcje, których alert nie doszedł – spróbujemy w następnym skanie NFT
  if (cfg.alerts.enabled && cfg.alerts.nft && state.nftSeeded) {
    let n = 0;
    for (const c of cols) {
      const fresh = !state.nftSeen[c.slug] || now - state.nftSeen[c.slug] > 24 * 3.6e6;
      const top = (c.rank1h && c.rank1h <= 10) || (c.rank1d && c.rank1d <= 10);
      if (fresh && top && c.s.score >= cfg.alerts.nftMinScore && c.s.risk !== 'crit' && n < cfg.alerts.maxPerScan) {
        if (retry.size) {
          retry.add(c.slug);
          continue;
        }
        const res = await deliver(tg.nftAlert(c));
        if (!res.sent && telegramReady()) {
          log(`Nie wysłano alertu NFT ${c.name}: ${res.error} – ponowię przy następnym skanie NFT`);
          retry.add(c.slug);
          continue;
        }
        const entry = pushAlert({ at: now, type: 'nft', key: 'nft:' + c.slug, symbol: c.name, name: c.name, chain: c.chain, score: c.s.score, risk: c.s.risk, url: c.url, sent: res.sent, error: res.error });
        logSafe({
          t: 'call', id: entry.id, at: now, iso: new Date(now).toISOString(), type: 'nft', sent: res.sent, error: res.error || null,
          symbol: c.name, name: c.name, slug: c.slug, chain: c.chain, url: c.url, score: c.s.score, threshold: cfg.alerts.nftMinScore, risk: c.s.risk, flags: c.s.flags,
          price: null, floor: c.floor, currency: c.symbol, sales1d: c.sales1d, vol1d: c.vol1d, vol7d: c.vol7d, owners: c.owners, rank1h: c.rank1h || null, rank1d: c.rank1d || null,
        });
        log(`Alert NFT: ${c.name}, wynik ${Math.round(c.s.score)}${res.sent ? ' – wysłano na Telegram' : ' – ' + res.error}`);
        n++;
      }
    }
  }
  for (const c of cols) if (!retry.has(c.slug)) state.nftSeen[c.slug] = now;
  if (cols.length) state.nftSeeded = true;
  for (const k of Object.keys(state.nftSeen)) if (now - state.nftSeen[k] > 72 * 3.6e6) delete state.nftSeen[k];
  for (const k of Object.keys(state.nftFloor)) if (!state.nftFloor[k].length || now - state.nftFloor[k][state.nftFloor[k].length - 1].t > 26 * 3.6e6) delete state.nftFloor[k];

  if (cols.length || !snapshot.nfts.length) snapshot.nfts = cols;
  snapshot.nftScannedAt = now;
  saveState();
  log(`Skan NFT: ${cols.length} kolekcji`);
}

// ---- Harmonogram ------------------------------------------------------------

let lastNft = 0;
let timer = null;
async function cycle() {
  if (snapshot.scanning) return;
  snapshot.scanning = true;
  try {
    await ensureTelegramChat();
    await scanTokens();
    if (Date.now() - lastNft >= cfg.nftIntervalSec * 1000) {
      lastNft = Date.now();
      await scanNfts();
    }
  } catch (e) {
    log('Błąd skanu: ' + e.message);
  }
  try {
    await maybePublish();
  } catch (e) {
    log('Błąd publikacji: ' + e.message);
  } finally {
    snapshot.scanning = false;
    clearTimeout(timer);
    timer = setTimeout(cycle, Math.max(MIN_SCAN_SEC, cfg.scanIntervalSec) * 1000);
  }
}

// ---- Serwer HTTP ------------------------------------------------------------

// forSite – wersja dla strony na GitHubie (publiczna): bez nazwy bota, kodu parowania i błędów Telegrama.
function publicConfig(forSite) {
  return {
    scanIntervalSec: cfg.scanIntervalSec,
    alerts: cfg.alerts,
    early: cfg.early,
    security: cfg.security,
    telegram: forSite
      ? { hasToken: !!cfg.telegram.token, connected: telegramReady() }
      : {
          hasToken: !!cfg.telegram.token,
          connected: telegramReady(),
          bot: tgInfo.bot,
          error: tgInfo.error,
          pairCode: cfg.telegram.token && !cfg.telegram.chatId ? cfg.telegram.pairCode || null : null,
        },
    opensea: { ownKey: !!(cfg.opensea && cfg.opensea.apiKey) },
    auth: { enabled: !!cfg.auth.passwordHash },
    publish: { enabled: !!(cfg.publish.enabled && cfg.publish.repo), intervalSec: cfg.publish.intervalSec, site: siteUrl() },
    minScanSec: MIN_SCAN_SEC,
  };
}

// Dane dla przeglądarki – te same lokalnie i na GitHubie (tam bez sekretów, patrz publicConfig).
function stateJson(forSite) {
  return {
    tokens: snapshot.tokens,
    nfts: snapshot.nfts,
    topics: snapshot.topics,
    alerts: state.alerts.slice(0, 300),
    outcomes: outcomes.stats(state.alerts),
    history: calllog.summary(),
    counts: snapshot.counts || null,
    sources: [...status.values()],
    scannedAt: snapshot.scannedAt,
    nftScannedAt: snapshot.nftScannedAt,
    scans: snapshot.scans,
    scanning: forSite ? false : snapshot.scanning,
    scanMs: snapshot.scanMs,
    config: publicConfig(forSite),
    now: Date.now(),
    publishedAt: forSite ? Date.now() : undefined,
    version: 1,
  };
}

// Pojedyncze alerty do panelu: ostatnie 500 z wynikami, przebiegiem ceny i obrazem z chwili alertu.
function alertsJson() {
  const keep = ['id', 'at', 'type', 'kind', 'symbol', 'chain', 'score', 'risk', 'url', 'sent', 'error', 'price0', 'liq0', 'mc0', 'checks', 'peak', 'peakAt', 'low', 'lowAt', 'done', 'path'];
  // Bez znacznika czasu – plik zmienia się tylko przy nowym alercie albo wyniku, więc git nie wysyła go co 2 minuty.
  return {
    alerts: state.alerts.slice(0, 500).map((a) => {
      const o = {};
      for (const k of keep) if (a[k] != null) o[k] = a[k];
      o.d = (a.id && calllog.details.get(a.id)) || null;
      return o;
    }),
  };
}

// git@github.com:jan/radar.git albo https://github.com/jan/radar → https://jan.github.io/radar/
function siteUrl() {
  const m = String(cfg.publish.repo || '').match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [owner, repo] = [m[1], m[2]];
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${repo}/`;
}

// ---- Publikacja na GitHubie -------------------------------------------------

let publisher = null, lastPublish = 0, publishDue = true;
async function maybePublish() {
  const P = cfg.publish;
  if (!P.enabled || !P.repo || !snapshot.scannedAt) return;
  if (!publishDue && Date.now() - lastPublish < Math.max(60, P.intervalSec) * 1000) return;
  const branch = P.branch || 'data';
  if (!publisher || publisher.remote !== P.repo || publisher.branch !== branch || publisher.key !== P.keyPath) {
    publisher = new Publisher({ dir: path.join(DATA_DIR, 'publish'), remote: P.repo, branch, key: P.keyPath });
  }
  lastPublish = Date.now();
  publishDue = false;
  try {
    const r = await publisher.publish(stateJson(true), { 'alerts.json': alertsJson() });
    report('GitHub – publikacja (kB)', true, Math.round(r.bytes / 1024));
  } catch (e) {
    report('GitHub – publikacja (kB)', false, 0, e.message);
    log('Publikacja na GitHubie nie powiodła się: ' + e.message);
  }
}

// ---- Komendy z Telegrama ----------------------------------------------------

const tgEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('pl-PL') : String(x));
const clockPl = (t) => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

function helpText() {
  return [
    '<b>Krypto Radar – komendy</b>',
    ...tgbot.COMMANDS.map(([c, d]) => `/${c} – ${tgEsc(d)}`),
    '',
    'Ustawienia do zmiany: ' + Object.keys(tgbot.SETTINGS).join(', '),
    'Np. <code>/ustaw wczesny 50</code>, <code>/ustaw sieci solana,base</code>, <code>/ustaw alerty off</code>',
  ].join('\n');
}

function statusText() {
  const toks = snapshot.tokens || [];
  const early = toks.filter((t) => t.e && t.e.inScope).sort((a, b) => b.e.score - a.e.score).slice(0, 3);
  const hot = toks.slice(0, 3);
  const bad = [...status.values()].filter((x) => !x.ok);
  const line = (t, sc) => `• ${tgEsc(t.symbol)} (${tgEsc(t.chain)}) ${Math.round(sc)}`;
  const out = [
    '<b>Krypto Radar</b> ' + (cfg.alerts.enabled ? '– alerty włączone' : '– ⏸ alerty wstrzymane'),
    snapshot.scannedAt ? `Ostatni skan ${clockPl(snapshot.scannedAt)} (nr ${snapshot.scans}), ${toks.length} tokenów` : 'Pierwszy skan jeszcze trwa',
    bad.length ? `⚠️ Nie odpowiada: ${tgEsc(bad.map((x) => x.name).join(', '))}` : 'Wszystkie źródła działają',
  ];
  if (early.length) out.push('', '<b>Wczesne</b>', ...early.map((t) => line(t, t.e.score)));
  if (hot.length) out.push('', '<b>Gorące</b>', ...hot.map((t) => line(t, t.s.score)));
  const today = state.alerts.filter((a) => Date.now() - a.at < 24 * 3.6e6).length;
  out.push('', `Alertów w 24 h: ${today}`);
  if (cfg.publish.enabled && lastPublish) out.push(`Strona zaktualizowana ${clockPl(lastPublish)}` + (siteUrl() ? `: ${siteUrl()}` : ''));
  return out.join('\n');
}

function settingsText() {
  return ['<b>Ustawienia</b>', ...Object.entries(tgbot.SETTINGS).map(([k, [d, , get]]) => `<code>${k}</code> = ${tgEsc(fmt(get(cfg)))} – ${tgEsc(d)}`), '', 'Zmiana: <code>/ustaw klucz wartość</code>'].join('\n');
}

// Pierwszy liść obiektu zmiany, np. { early: { minScore: 50 } } → [['early','minScore'], 50]
function leaf(o, p = []) {
  const [k, v] = Object.entries(o)[0];
  return v && typeof v === 'object' && !Array.isArray(v) ? leaf(v, p.concat(k)) : [p.concat(k), v];
}

function setCommand(arg) {
  const [k, ...rest] = String(arg || '').trim().split(/\s+/);
  const key = plain(k || '');
  const def = tgbot.SETTINGS[key];
  if (!def || !rest.length) return (def ? `Podaj wartość, np. <code>/ustaw ${key} …</code>\n\n` : 'Nieznane ustawienie.\n\n') + settingsText();
  const patch = def[1](rest.join(' '));
  const [p, want] = leaf(patch);
  if (want === undefined || (typeof want === 'number' && !Number.isFinite(want))) return `Nie rozumiem wartości „${tgEsc(rest.join(' '))}”.`;
  applyConfig(patch);
  const got = p.reduce((o, x) => o[x], cfg);
  if (JSON.stringify(got) !== JSON.stringify(want)) return `Wartość poza dozwolonym zakresem – bez zmian (${tgEsc(def[0])}).`;
  publishDue = true;
  log(`Telegram: ustawiono ${key} = ${fmt(def[2](cfg))}`);
  return `✅ ${tgEsc(def[0])}: <b>${tgEsc(fmt(def[2](cfg)))}</b>`;
}

// /wyniki [24h|7d|30d|all] – skuteczność z dziennika alertów.
function resultsText(arg) {
  const map = { '24h': 'd1', '1d': 'd1', d1: 'd1', '7d': 'd7', '7': 'd7', d7: 'd7', '30d': 'd30', '30': 'd30', d30: 'd30', all: 'all', wszystko: 'all', calosc: 'all' };
  const key = map[plain(arg || '').replace(/\s+/g, '')] || 'd7';
  const H = calllog.summary();
  const P = H[key];
  const label = H.periods.find((x) => x.key === key).label;
  const pc = (x) => (x == null ? '–' : (x > 0 ? '+' : '') + x + '%');
  const line = (name, st) => {
    if (!st.n) return `<b>${name}</b>: brak alertów`;
    const h = (k, l) => (st[k].n ? `${l}: ${st[k].up}% na plusie, mediana ${pc(st[k].median)} (${st[k].n})` : `${l}: jeszcze brak`);
    const pk = st.peak.n ? `szczyt w 24 h: mediana ${pc(st.peak.median)}, ${st.peak.p20}% doszło do +20%, ${st.peak.p50}% do +50%` : 'szczyt: jeszcze brak';
    return [`<b>${name}</b> – ${st.n} alertów`, h('h1', 'po 1 h'), h('h6', 'po 6 h'), h('h24', 'po 24 h'), pk, st.dead ? `zniknęło lub wycofana płynność: ${st.dead}` : null].filter(Boolean).join('\n');
  };
  const out = [`📊 <b>Skuteczność – ${label}</b>`, '', line('Wczesne', P.kinds.early), '', line('Gorące', P.kinds.momentum)];
  const bk = P.buckets.early.filter((b) => b.h24.n);
  if (bk.length) out.push('', '<b>Wczesne wg wyniku (po 24 h)</b>', ...bk.map((b) => `${b.label}: ${b.h24.up}% na plusie, mediana ${pc(b.h24.median)} (${b.h24.n})`));
  const closed = P.all.h24.n;
  out.push('', closed < 30 ? `Zamkniętych po 24 h: ${closed} – poniżej ~30 wynik niewiele mówi.` : `Zamkniętych po 24 h: ${closed}.`, 'Inne okresy: /wyniki 24h | 7d | 30d | all');
  return out.join('\n');
}

async function exportCsv() {
  const csv = calllog.csv();
  const name = `krypto-radar-alerty-${new Date().toISOString().slice(0, 10)}.csv`;
  await tg.sendDocument(cfg, name, csv, `Historia alertów (${calllog.calls.size}). Otwórz w Excelu albo Arkuszach Google.`);
  return null;
}

async function handleCommand(text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = plain(raw.slice(1).split('@')[0]);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'start':
    case 'pomoc':
    case 'help':
      return helpText();
    case 'status':
      return statusText();
    case 'skanuj':
      if (snapshot.scanning) return '⏳ Skan właśnie trwa.';
      clearTimeout(timer);
      publishDue = true;
      cycle();
      return '🔎 Skanuję. Wynik będzie na stronie za chwilę.';
    case 'ustawienia':
      return settingsText();
    case 'wyniki':
      return resultsText(arg);
    case 'eksport':
    case 'export':
      if (!calllog.calls.size) return 'Dziennik jest jeszcze pusty – nie było żadnego alertu.';
      return exportCsv();
    case 'ustaw':
      return setCommand(arg);
    case 'pauza':
      applyConfig({ alerts: { enabled: false } });
      publishDue = true;
      return '⏸ Alerty wstrzymane. /wznow włącza je z powrotem.';
    case 'wznow':
      applyConfig({ alerts: { enabled: true } });
      publishDue = true;
      return '▶️ Alerty włączone.';
    default:
      return 'Nie znam tej komendy.\n\n' + helpText();
  }
}

const numIn = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

function applyConfig(body) {
  if (typeof body.telegramToken === 'string') {
    const tok = body.telegramToken.trim();
    if (tok && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(tok)) throw new Error('To nie wygląda na token bota. Skopiuj go w całości z wiadomości od BotFather.');
    if (tok !== cfg.telegram.token) {
      cfg.telegram = { token: tok, chatId: '', pairCode: tok ? newPairCode() : '' };
      tgInfo = { bot: null, error: null };
    }
  }
  if (typeof body.openseaKey === 'string') cfg.opensea = { apiKey: body.openseaKey.trim() };
  const a = body.alerts || {};
  const set = (k, v) => {
    if (v !== undefined) cfg.alerts[k] = v;
  };
  if (typeof a.enabled === 'boolean') cfg.alerts.enabled = a.enabled;
  if (typeof a.nft === 'boolean') cfg.alerts.nft = a.nft;
  if (typeof a.allowBondingCurve === 'boolean') cfg.alerts.allowBondingCurve = a.allowBondingCurve;
  set('minScore', numIn(a.minScore, 1, 100));
  set('nftMinScore', numIn(a.nftMinScore, 1, 100));
  set('cooldownHours', numIn(a.cooldownHours, 0.25, 168));
  set('maxPerScan', numIn(a.maxPerScan, 1, 20));
  set('minLiquidityUsd', numIn(a.minLiquidityUsd, 0, 1e9));
  set('minVolume1hUsd', numIn(a.minVolume1hUsd, 0, 1e9));
  set('minMarketCapUsd', numIn(a.minMarketCapUsd, 0, 1e12));
  if (Array.isArray(a.chains)) cfg.alerts.chains = a.chains.filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,32}$/.test(x)).slice(0, 60);
  const e = body.early || {};
  if (typeof e.enabled === 'boolean') cfg.early.enabled = e.enabled;
  for (const [k, lo, hi] of [['minScore', 1, 100], ['minLiquidityUsd', 0, 1e9], ['minVolume1hUsd', 0, 1e9], ['minAgeMin', 0, 10080], ['maxMarketCapUsd', 1000, 1e12]]) {
    const v = numIn(e[k], lo, hi);
    if (v !== undefined) cfg.early[k] = v;
  }
  const si = numIn(body.scanIntervalSec, MIN_SCAN_SEC, 3600);
  if (si !== undefined) cfg.scanIntervalSec = si;
  saveConfig();
}

function readRaw(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Za duże żądanie'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readBody(req) {
  const raw = await readRaw(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error('Niepoprawny JSON');
  }
}

// ---- Dostęp: dozwolone adresy, nagłówki bezpieczeństwa, logowanie -----------

let hostCache = { at: 0, set: new Set() };
// Nazwy, pod którymi wolno otworzyć aplikację: localhost, nazwa i adresy IP tego komputera
// oraz to, co dopiszesz w allowedHosts. Obca nazwa w nagłówku Host (np. przy ataku DNS rebinding) dostaje 403.
function allowedHostnames() {
  if (Date.now() - hostCache.at < 60e3) return hostCache.set;
  const set = new Set(['localhost', '127.0.0.1', '::1']);
  const hn = os.hostname().toLowerCase();
  for (const x of [hn, hn + '.local', hn + '.lan', hn + '.home']) set.add(x);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) set.add(String(i.address).toLowerCase().split('%')[0]);
  for (const h of cfg.allowedHosts || []) set.add(String(h).toLowerCase());
  hostCache = { at: Date.now(), set };
  return set;
}
function hostOk(h) {
  const m = String(h || '').toLowerCase().match(/^(\[[^\]]+\]|[^:\[\]]+)(?::(\d+))?$/);
  if (!m) return false;
  const name = m[1].replace(/^\[|\]$/g, '');
  if (!allowedHostnames().has(name)) return false;
  const port = m[2] ? Number(m[2]) : null;
  // Port inny niż aplikacji tylko dla nazw dopisanych ręcznie (np. za proxy HTTPS).
  return port == null || port === cfg.port || (cfg.allowedHosts || []).map((x) => String(x).toLowerCase()).includes(name);
}

const PUBLIC = path.join(ROOT, 'public'); // strona logowania
const SITE = path.join(ROOT, 'docs'); // panel – ten sam plik działa na GitHub Pages i lokalnie
const csp = (scripts) =>
  `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const SEC_HEADERS = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' };

const send = (res, code, type, body, extra) => {
  res.writeHead(code, Object.assign({ 'content-type': type, 'content-security-policy': csp("'none'") }, SEC_HEADERS, extra || {}));
  res.end(body);
};
const json = (res, code, obj, extra) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
const redirect = (res, to, extra) => send(res, 303, 'text/plain; charset=utf-8', '', Object.assign({ location: to }, extra || {}));

const throttle = new auth.Throttle();
const authOn = () => !!cfg.auth.passwordHash;
const authed = (req) => !authOn() || auth.checkSession(cfg.auth.secret, auth.readCookie(req));
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function loginPage(res, code, msg) {
  const html = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8').replace('{{MSG}}', msg ? `<p class="msg" role="alert">${htmlEsc(msg)}</p>` : '');
  send(res, code, 'text/html; charset=utf-8', html);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (!hostOk(req.headers.host)) return json(res, 403, { error: 'Niedozwolony adres' });
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.socket.remoteAddress || '');

  if (req.method === 'POST') {
    // Żądania zmieniające coś muszą pochodzić z tej samej strony (ochrona przed CSRF).
    const origin = req.headers.origin;
    if (origin && !hostOk(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Niedozwolone źródło' });
  }

  // --- Logowanie ---
  if (url.pathname === '/login') {
    if (!authOn()) return redirect(res, '/');
    if (req.method === 'GET') return authed(req) ? redirect(res, '/') : loginPage(res, 200);
    if (req.method !== 'POST') return json(res, 405, { error: 'Niedozwolona metoda' });
    const wait = throttle.blockedFor(ip);
    if (wait > 0) return loginPage(res, 429, `Za dużo błędnych prób. Spróbuj za ${Math.ceil(wait / 60000)} min.`);
    let pw = '';
    try {
      pw = new URLSearchParams(await readRaw(req, 4096)).get('password') || '';
    } catch (e) {
      return loginPage(res, 400, 'Niepoprawne żądanie.');
    }
    if (auth.verifyPassword(pw, cfg.auth.passwordHash)) {
      throttle.ok(ip);
      log('Zalogowano z adresu ' + ip);
      return redirect(res, '/', { 'set-cookie': auth.cookieHeader(auth.makeSession(cfg.auth.secret), { secure: cfg.auth.secureCookie }) });
    }
    throttle.fail(ip);
    log('Błędne hasło z adresu ' + ip);
    await sleep(500);
    return loginPage(res, 401, 'Błędne hasło.');
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', { secure: cfg.auth.secureCookie }) });
  }
  if (!authed(req)) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return redirect(res, '/login');
    return json(res, 401, { error: 'Zaloguj się' });
  }

  // --- Aplikacja ---
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
  if (req.method === 'GET' && assets[url.pathname]) {
    const [file, type] = assets[url.pathname];
    let body;
    try {
      body = fs.readFileSync(path.join(SITE, file));
    } catch (e) {
      return json(res, 500, { error: 'Brak pliku docs/' + file });
    }
    return send(res, 200, type, body, { 'content-security-policy': csp("'self'") });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, stateJson(false));
  if (req.method === 'GET' && url.pathname === '/api/alerts') return json(res, 200, alertsJson());
  if (req.method === 'POST') {
    if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'Oczekiwano JSON' });
    try {
      const body = await readBody(req);
      if (url.pathname === '/api/config') {
        applyConfig(body);
        publishDue = true;
        if (cfg.telegram.token && !cfg.telegram.chatId) await ensureTelegramChat();
        return json(res, 200, { ok: true, config: publicConfig() });
      }
      if (url.pathname === '/api/telegram/test') {
        if (cfg.telegram.token && !cfg.telegram.chatId) await ensureTelegramChat();
        await tg.send(cfg, '🔔 Test: Krypto Radar działa i może wysyłać alerty.');
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/scan') {
        if (!snapshot.scanning) {
          clearTimeout(timer);
          cycle();
        }
        return json(res, 200, { ok: true });
      }
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  json(res, 404, { error: 'Nie znaleziono' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} jest zajęty – Krypto Radar chyba już działa.`);
  } else console.error(e.message);
  process.exit(1);
});

// Orange Pi nie ma zegara z baterią: tuż po starcie czas bywa z przeszłości, dopóki nie zsynchronizuje
// się przez internet. Z takim czasem pomiary alertów i „świeżość” tokenów byłyby błędne, więc czekamy.
async function waitForClock() {
  const MIN = Date.UTC(2026, 0, 1);
  if (Date.now() >= MIN) return;
  log('Zegar systemowy wskazuje ' + new Date().toISOString() + ' – czekam na synchronizację czasu…');
  while (Date.now() < MIN) await sleep(5000);
  log('Zegar zsynchronizowany.');
}

function start() {
  if (!isLoopback(cfg.host) && !authOn()) {
    console.error(
      `\n  Aplikacja ma być dostępna w sieci (host ${cfg.host}), ale nie ma ustawionego hasła.\n` +
        '  Ustaw je poleceniem:  node server.js --set-password\n' +
        '  albo zmień "host" w config.json na "127.0.0.1" (dostęp tylko z tego komputera).\n'
    );
    process.exit(1);
  }
  server.listen(cfg.port, cfg.host, async () => {
    const shown = cfg.host === '0.0.0.0' || cfg.host === '::' ? os.hostname() + '.local' : cfg.host === '127.0.0.1' ? 'localhost' : cfg.host;
    console.log(`\n  Krypto Radar działa: http://${shown}:${cfg.port}` + (authOn() ? '  (wymaga hasła)' : ''));
    if (!isLoopback(cfg.host)) {
      const ips = [];
      for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
      if (ips.length) console.log('  Adresy w sieci: ' + ips.map((a) => `http://${a}:${cfg.port}`).join(', '));
    }
    console.log('');
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(cmd, [`http://localhost:${cfg.port}`], () => {});
    }
    await waitForClock();
    STARTED = Date.now();
    cycle();
    tgbot.startPolling({
      getCfg: () => cfg,
      state,
      onCommand: handleCommand,
      send: (html) => tg.send(cfg, html),
      onError: (e) => log('Telegram (komendy): ' + e.message),
      markDirty: () => (stateDirty = true),
    });
  });
}

// ---- Ustawianie hasła: node server.js --set-password ------------------------

function readAllStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let pw = '';
    const on = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', on);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    stdin.on('data', on);
  });
}
async function setPassword() {
  let pw, again;
  if (process.stdin.isTTY) {
    pw = await askHidden('Nowe hasło do Krypto Radaru: ');
    again = await askHidden('Powtórz hasło: ');
  } else {
    const lines = (await readAllStdin()).split(/\r?\n/);
    pw = lines[0] || '';
    again = lines[1] === undefined || lines[1] === '' ? pw : lines[1];
  }
  if (pw !== again) {
    console.error('Hasła się różnią. Nic nie zmieniłem.');
    process.exit(1);
  }
  if (pw.length < auth.MIN_PASSWORD) {
    console.error(`Hasło musi mieć co najmniej ${auth.MIN_PASSWORD} znaków. Nic nie zmieniłem.`);
    process.exit(1);
  }
  cfg.auth.passwordHash = auth.hashPassword(pw);
  cfg.auth.secret = auth.newSecret(); // nowy sekret wylogowuje wszystkie dotychczasowe sesje
  saveConfig();
  console.log('Hasło zapisane w ' + CONFIG_PATH + '. Wszystkie wcześniejsze sesje zostały wylogowane.');
  console.log('Jeśli aplikacja działa jako usługa, uruchom ją ponownie: sudo systemctl restart krypto-radar');
  process.exit(0);
}

function shutdown() {
  saveState(true);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown); // systemd zatrzymuje usługę sygnałem SIGTERM

if (process.argv.includes('--export-csv')) {
  // node server.js --export-csv > alerty.csv
  process.stdout.write(calllog.csv());
  process.exit(0);
} else if (process.argv.includes('--set-password')) setPassword();
else start();
