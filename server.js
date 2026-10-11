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

const { collectTokens, collectNfts, annotateUniq, candleExtremes, tokenHolders, poolTrades, rugcheckReport, marketContext, tgInfo: tgChatInfo, tgLinkKind, setBudget } = require('./lib/sources');
const { Tape } = require('./lib/tape');
const { Health } = require('./lib/health');
const { backup } = require('./lib/backup');

// Wersja danych i strony – strona porównuje ją ze swoją i prosi o odświeżenie, gdy się różnią.
const APP_VERSION = 11;
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
  gtPerMin: 9, // limit zapytań do GeckoTerminal na minutę (bez klucza ~10)
  tape: { enabled: true, intervalMin: 5 }, // zapis stanu wszystkich tokenów (taśma)
  health: { enabled: true, afterMin: 30 }, // wiadomość na Telegram, gdy źródło nie działa od tylu minut
  // Codzienna kopia katalogu z danymi; dir puste = obok katalogu danych (…/krypto-radar-kopie).
  backup: { enabled: true, dir: '', keep: 14, hour: 4 },
  // Solana: osobna zakładka na stronie i alerty bez powiadomień na Telegram (zapisywane i mierzone w tle).
  solana: { separate: true, telegram: false },
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
const tape = new Tape(path.join(DATA_DIR, 'tape'));
const health = new Health({ afterMin: (cfg.health && cfg.health.afterMin) || 30 });

// Alerty sprzed dziennika (bez id) dopisujemy do niego w skrócie, żeby były w historii i statystykach.
function backfillAlerts() {
  let n = 0;
  for (const a of state.alerts.slice().reverse()) {
    if (a.id) continue;
    a.id = a.at.toString(36) + crypto.randomBytes(3).toString('hex');
    try {
      calllog.append({
        t: 'call', id: a.id, at: a.at, iso: new Date(a.at).toISOString(), type: a.type, kind: a.kind || (a.type === 'token' ? 'momentum' : undefined), backfill: true,
        sent: a.sent, error: a.error || null, symbol: a.symbol, name: a.name, chain: a.chain, address: a.address, url: a.url,
        score: a.score, risk: a.risk, price: a.price0 || null, liquidityUsd: a.liq0, marketCap: a.mc0,
      });
      for (const [name, c] of Object.entries(a.checks || {})) calllog.append(Object.assign({}, c, { t: 'check', id: a.id, at: c.t || a.at, name, ct: c.t }));
      n++;
    } catch (e) {
      log('Nie mogę dopisać starszego alertu do dziennika: ' + e.message);
    }
  }
  if (n) {
    stateDirty = true;
    log(`Dopisano do dziennika ${n} starszych alertów`);
  }
  return n;
}

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
  pruneAlerts();
  return entry;
}

// Lista robocza: alerty w trakcie pomiaru (do 7 dni) i świeżo zamknięte. Pełna historia jest w dzienniku.
function pruneAlerts() {
  const now = Date.now();
  state.alerts = state.alerts.filter((a) => !a.done || now - a.at < 9 * 864e5).slice(0, 20000);
  // Przebieg ceny po pierwszej dobie trafia do pliku szczegółów – w stanie aplikacji nie jest już potrzebny.
  for (const a of state.alerts) if (a.path && now - a.at > 26 * 3.6e6) delete a.path;
}

// Szczegóły jednego alertu (DATA_DIR/details/<id>.json): obraz z chwili alertu, pomiary, przebieg ceny.
// Zapisywane przy alercie i przy każdym pomiarze; strona pobiera je dopiero po rozwinięciu alertu.
const DETAILS_DIR = path.join(DATA_DIR, 'details');
const ROW_KEYS = ['id', 'at', 'type', 'kind', 'symbol', 'chain', 'score', 'risk', 'url', 'sent', 'error', 'price0', 'liq0', 'mc0', 'checks', 'peak', 'peakAt', 'low', 'lowAt', 'done', 'path', 'enrich', 'muted'];
const rowOf = (a) => {
  const o = {};
  for (const k of ROW_KEYS) if (a[k] != null) o[k] = a[k];
  return o;
};
function writeDetail(a) {
  if (!a.id) return;
  try {
    fs.mkdirSync(DETAILS_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(DETAILS_DIR, a.id + '.json');
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    const o = Object.assign({}, prev, rowOf(a));
    o.d = calllog.details.get(a.id) || prev.d || null;
    if (!a.path && prev.path) o.path = prev.path;
    fs.writeFileSync(file + '.tmp', JSON.stringify(o), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    log('Nie mogę zapisać szczegółów alertu: ' + e.message);
  }
}
function readDetail(id) {
  if (!/^[a-z0-9]{6,40}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DETAILS_DIR, id + '.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}
// Pliki szczegółów starsze niż 35 dni usuwamy (pełne dane zostają w dzienniku).
function pruneDetails() {
  try {
    const cut = Date.now() - 35 * 864e5;
    for (const f of fs.readdirSync(DETAILS_DIR)) {
      const full = path.join(DETAILS_DIR, f);
      if (fs.statSync(full).mtimeMs < cut) fs.unlinkSync(full);
    }
  } catch (e) {}
}

// Pełny obraz tokena w chwili alertu – do późniejszej analizy, co działało.
function tokenSnapshot(t, kind, entry, threshold) {
  const s = t.s, e = t.e;
  return {
    t: 'call', id: entry.id, at: entry.at, iso: new Date(entry.at).toISOString(), type: 'token', kind,
    sent: entry.sent, error: entry.error || null, muted: entry.muted ? 1 : undefined,
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
    // Dane dodatkowe z chwili alertu (posiadacze i członkowie Telegrama – też trend sprzed alertu).
    market: snapshot.market || null,
    avgTx: t.avgTx || null,
    secInfo: t.secInfo || null,
    holdersPre: trendOf(cache.holdersHist, t.key, entry.at),
    tgPre: trendOf(cache.tgHist, t.key, entry.at),
    tgLink: (t.socials && t.socials.telegram) || null,
    tg: t.tg || tgState(t),
  };
}

// ---- Historia posiadaczy i członków Telegrama (w pamięci, 3 h) ------------------

function pushHist(mapName, key, count, now, minGapMs = 5 * 60e3) {
  if (count == null || !Number.isFinite(count)) return;
  const m = (cache[mapName] = cache[mapName] || new Map());
  const arr = m.get(key) || [];
  if (arr.length && now - arr[arr.length - 1].t < minGapMs) arr[arr.length - 1] = { t: now, c: count };
  else arr.push({ t: now, c: count });
  m.set(key, arr.filter((x) => now - x.t < 3 * 3.6e6));
}
// Stan teraz i zmiana od najstarszego pomiaru sprzed co najmniej 10 minut.
function trendOf(m, key, now) {
  const arr = m && m.get(key);
  if (!arr || !arr.length) return null;
  const last = arr[arr.length - 1];
  if (now - last.t > 20 * 60e3) return null;
  const first = arr.find((x) => last.t - x.t >= 10 * 60e3);
  const out = { count: last.c, minAgo: Math.round((now - last.t) / 60000) };
  if (first) Object.assign(out, { before: first.c, minutes: Math.round((last.t - first.t) / 60000), change: last.c - first.c, changePct: first.c > 0 ? Math.round((1000 * (last.c - first.c)) / first.c) / 10 : null });
  return out;
}

// Średnia wielkość transakcji (wolumen ÷ liczba transakcji) – dostępna dla każdego tokena bez zapytań.
function avgTxOf(t) {
  const o = {};
  for (const w of ['m5', 'h1', 'h24']) {
    const n = ((t.txns[w] && t.txns[w].buys) || 0) + ((t.txns[w] && t.txns[w].sells) || 0);
    if (n > 0 && t.vol[w] > 0) o[w] = Math.round((t.vol[w] / n) * 100) / 100;
  }
  return Object.keys(o).length ? o : null;
}

// „Temperatura” memecoinów: łączny obrót modnych narracji DexScreenera i zmiana ich wyceny.
function memeHeat(metas) {
  const list = (metas || []).filter((m) => m.marketCap > 0);
  if (!list.length) return null;
  const cap = list.reduce((s, m) => s + m.marketCap, 0);
  const w = (k) => Math.round((10 * list.reduce((s, m) => s + (m.chg[k] || 0) * m.marketCap, 0)) / cap) / 10;
  return { n: list.length, vol: Math.round(list.reduce((s, m) => s + (m.volume || 0), 0)), h1: w('h1'), h24: w('h24') };
}

const telegramReady = () => !!(cfg.telegram.token && cfg.telegram.chatId);
// Solana wyciszona: alerty zapisywane i mierzone, ale bez wiadomości na Telegram.
const solMuted = (chain) => chain === 'solana' && !(cfg.solana && cfg.solana.telegram);
const solApart = () => !cfg.solana || cfg.solana.separate !== false;
// Czy token/alert z tej sieci należy do głównego widoku (Solana osobno).
const mainScope = (chain) => !(solApart() && chain === 'solana');
// Dokąd idą alerty: wybrana grupa (i temat) albo – bez wyboru – prywatna rozmowa z właścicielem.
const alertTarget = () => (cfg.telegram.alertChat && cfg.telegram.alertChat.id ? cfg.telegram.alertChat : null);
let groupWarnAt = 0;
// opts.alert – wiadomość z alertem (do grupy, jeśli wybrana); reszta (pilnowanie, parowanie) zawsze prywatnie.
async function deliver(html, opts = {}) {
  if (!telegramReady()) return { sent: false, error: 'Telegram niepołączony' };
  const to = opts.alert ? alertTarget() : null;
  try {
    const r = await tg.send(cfg, html, to);
    if (to && r && r.migrated) {
      // Zwykła grupa zmieniła się w supergrupę i dostała nowy numer.
      cfg.telegram.alertChat.id = r.migrated;
      saveConfig();
      log('Telegram: grupa dostała nowy numer (supergrupa) – zapisano');
    }
    return { sent: true, error: null };
  } catch (e) {
    // Grupa nie przyjmuje wiadomości (bot usunięty, brak uprawnień, zamknięty temat) – alert idzie prywatnie.
    if (to && (e.status === 400 || e.status === 403)) {
      const warn = Date.now() - groupWarnAt > 3.6e6;
      try {
        await tg.send(cfg, (warn ? `⚠️ Nie mogę pisać do grupy „${tgEsc(to.title || to.id)}”: ${tgEsc(e.message)}\nAlerty przychodzą tutaj, dopóki tego nie naprawisz (dodaj bota z prawem pisania i wyślij /tutaj w grupie).\n\n` : '') + html);
        if (warn) groupWarnAt = Date.now();
        log('Telegram: grupa nie przyjmuje wiadomości (' + e.message + ') – wysłano prywatnie');
        return { sent: true, error: null };
      } catch (e2) {
        return { sent: false, error: e2.message };
      }
    }
    return { sent: false, error: e.message };
  }
}

// kind: 'early' (wczesny sygnał) albo 'momentum' (już gorący token).
async function tokenAlerts(tokens, now, kind) {
  const early = kind === 'early';
  if (!cfg.alerts.enabled || (early && !cfg.early.enabled)) return 0;
  const cool = cfg.alerts.cooldownHours * 3.6e6;
  const list = early ? tokens.filter((t) => t.e && t.e.inScope).sort((a, b) => b.e.score - a.e.score) : tokens;
  let n = 0, nm = 0; // wysłane i wyciszone (Solana) – osobne limity, żeby Solana nie zabierała miejsca innym
  for (const t of list) {
    if (n >= cfg.alerts.maxPerScan && nm >= cfg.alerts.maxPerScan) break;
    const muted = solMuted(t.chain);
    if ((muted ? nm : n) >= cfg.alerts.maxPerScan) continue;
    if (!(early ? eligibleEarly(t) : eligible(t))) continue;
    const mark = (early ? 'e:' : '') + t.key;
    if (state.alerted[mark] && now - state.alerted[mark] < cool) continue;
    // Token, który jest już „gorący” albo dostał taki alert, nie jest wczesnym sygnałem.
    if (early && (eligibleBase(t) || (state.alerted[t.key] && now - state.alerted[t.key] < cool))) continue;
    // Telegram tokena sprawdzamy tuż przed alertem (jedno–dwa szybkie zapytania), żeby był w wiadomości.
    const tl = t.socials && t.socials.telegram;
    if (!muted && tl && cfg.telegram.token && tgLinkKind(tl).s === 'public' && tgStale(tl, now)) await tgCheck(t, now);
    t.tg = tgState(t);
    const th = cache.tgHist && cache.tgHist.get(t.key);
    if (th && th.length) t.tgMembers = th[th.length - 1].c;
    const res = muted ? { sent: false, error: null } : await deliver(early ? tg.earlyAlert(t) : tg.tokenAlert(t), { alert: true });
    if (!muted && !res.sent && telegramReady()) {
      // Telegram jest połączony, ale wiadomość nie doszła (sieć, limit) – nie zapisujemy alertu,
      // żeby przerwa 6 h go nie „zjadła”. Spróbujemy w następnym skanie.
      log(`Nie wysłano alertu ${t.symbol}: ${res.error} – ponowię w następnym skanie`);
      break;
    }
    state.alerted[mark] = now;
    const score = early ? t.e.score : t.s.score;
    const entry = pushAlert({
      at: now, type: 'token', kind, key: t.key, chain: t.chain, address: t.address, symbol: t.symbol, name: t.name,
      score, risk: t.s.risk, url: t.url, sent: res.sent, error: res.error, ...(muted ? { muted: 1 } : {}),
      price0: t.priceUsd, liq0: t.liquidityUsd, mc0: t.marketCap || t.fdv || null, peak: t.priceUsd, low: t.priceUsd, checks: {},
      pair: t.pairAddress || null, tg: (t.socials && t.socials.telegram) || null,
    });
    t.alerted = early ? 'e' : 'm';
    (state.enrich = state.enrich || []).push({ id: entry.id, tag: 'alert', at: now, chain: t.chain, address: t.address, pair: t.pairAddress || null, tg: entry.tg });
    try {
      calllog.append(tokenSnapshot(t, kind, entry, early ? cfg.early.minScore : cfg.alerts.minScore));
    } catch (e) {
      log('Nie mogę zapisać alertu w dzienniku: ' + e.message);
    }
    writeDetail(entry);
    log(`${early ? 'Wczesny sygnał' : 'Alert'}: ${t.symbol} (${t.chain}), wynik ${Math.round(score)}${muted ? ' – wyciszony (Solana, tylko zapis)' : res.sent ? ' – wysłano na Telegram' : ' – ' + res.error}`);
    if (muted) nm++;
    else n++;
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

// Posiadacze (GeckoTerminal) i członkowie Telegrama dla czołówki kandydatów – zanim dostaną alert,
// żeby przy alercie znać trend. Najwyżej 1–2 zapytania do GeckoTerminal i 3 do Telegrama na skan.
async function sampleCandidates(tokens, now) {
  const seen = new Set();
  const cands = [];
  const add = (t) => {
    if (!seen.has(t.key)) {
      seen.add(t.key);
      cands.push(t);
    }
  };
  tokens.filter((t) => t.e && t.e.inScope).sort((a, b) => b.e.score - a.e.score).slice(0, 15).forEach(add);
  tokens.slice().sort((a, b) => b.s.score - a.s.score).slice(0, 10).forEach(add);
  const stale = (mapName, key, ms) => {
    const arr = cache[mapName] && cache[mapName].get(key);
    return !arr || !arr.length || now - arr[arr.length - 1].t >= ms;
  };
  let gt = 0;
  for (const t of cands) {
    if (gt >= 2 || !stale('holdersHist', t.key, 15 * 60e3) || !stale('holdersMiss', t.key, 15 * 60e3)) continue;
    try {
      gt++;
      const h = await tokenHolders(cfg, t.chain, t.address);
      if (h) pushHist('holdersHist', t.key, h.count, now);
      else pushHist('holdersMiss', t.key, 0, now); // brak danych – nie pytamy o ten token przez 15 min
    } catch (e) {
      if (e.budget || e.status === 429) break;
    }
  }
  if (!cfg.telegram.token) return;
  let tgN = 0;
  for (const t of tokens.slice(0, 30).concat(cands)) {
    const link = t.socials && t.socials.telegram;
    if (tgN >= 3 || !link || tgLinkKind(link).s !== 'public' || !tgStale(link, now)) continue;
    tgN++;
    await tgCheck(t, now);
  }
}

// ---- Telegram tokena: publiczny (nazwa, członkowie), prywatny, brak ------------------
// Pamięć: publiczny sprawdzamy ponownie po 15 min (trend członków), nieistniejący po 12 h.
function tgStale(link, now) {
  const c = cache.tgInfo && cache.tgInfo.get(link);
  return !c || now - c.at >= (c.v.s === 'public' ? 15 * 60e3 : 12 * 3.6e6);
}
async function tgCheck(t, now) {
  const link = t.socials && t.socials.telegram;
  if (!link) return null;
  cache.tgInfo = cache.tgInfo || new Map();
  try {
    const v = await tgChatInfo(cfg, link);
    cache.tgInfo.set(link, { at: now, v });
    if (v.n != null) pushHist('tgHist', t.key, v.n, now);
    return v;
  } catch (e) {
    // sieć / limit – zostaje poprzedni stan, spróbujemy później
    cache.tgInfo.set(link, { at: now - 10 * 60e3, v: (cache.tgInfo.get(link) || { v: tgLinkKind(link) }).v });
    return null;
  }
}
// Stan do pokazania (bez zapytań): z pamięci albo z samego linku.
function tgState(t) {
  const link = t.socials && t.socials.telegram;
  if (!link) return { s: 'none' };
  const c = cache.tgInfo && cache.tgInfo.get(link);
  const v = c ? c.v : tgLinkKind(link);
  const out = { s: v.s };
  if (v.name) out.name = v.name;
  if (v.title) out.title = v.title;
  if (v.type) out.type = v.type;
  if (v.n != null) out.n = v.n;
  if (v.s === 'public' && !c) out.unchecked = 1;
  return out;
}

// Dane dociągane po alercie (nie opóźniają wysłania): posiadacze, transakcje, insiderzy, członkowie Telegrama.
// Przy pomiarach 1 h / 24 h / 72 h / 7 dni ponownie posiadacze i członkowie – żeby widzieć ich przyrost po alercie.
async function processEnrich(now) {
  const q = (state.enrich = (state.enrich || []).filter((it) => now - it.at < 45 * 60e3));
  if (!q.length) return;
  const byId = new Map(state.alerts.map((a) => [a.id, a]));
  let handled = 0;
  for (const it of q.slice()) {
    if (handled >= 5) break;
    const a = byId.get(it.id);
    if (!a) {
      it.dropped = true;
      continue;
    }
    handled++;
    it.done = it.done || {};
    const res = {};
    const tryTask = async (name, fn) => {
      if (it.done[name]) return;
      try {
        const v = await fn();
        it.done[name] = true;
        if (v != null) Object.assign(res, v);
      } catch (e) {
        if (!e.budget && e.status !== 429) it.done[name] = true; // limit: spróbujemy w następnym skanie
      }
    };
    await tryTask('holders', async () => {
      const h = await tokenHolders(cfg, it.chain, it.address);
      return h ? { holders: h } : null;
    });
    if (it.tag === 'alert') {
      if (it.pair) await tryTask('trades', async () => {
        const tr = await poolTrades(cfg, it.chain, it.pair, now);
        return tr ? { trades: tr } : null;
      });
      if (it.chain === 'solana') await tryTask('rug', async () => {
        const r = await rugcheckReport(cfg, it.address);
        return r ? { insiders: r } : null;
      });
    }
    if (it.tg && cfg.telegram.token) await tryTask('tg', async () => {
      const v = await tgChatInfo(cfg, it.tg);
      const o = { tgStatus: v.s };
      if (v.n != null) o.tgMembers = v.n;
      return o;
    });
    if (Object.keys(res).length) {
      a.enrich = a.enrich || {};
      a.enrich[it.tag] = Object.assign(a.enrich[it.tag] || {}, res, { at: now });
      logSafe(Object.assign({ t: 'enrich', id: it.id, at: now, tag: it.tag }, res));
      writeDetail(a);
      stateDirty = true;
    }
    const need = ['holders', it.tag === 'alert' && it.pair ? 'trades' : null, it.tag === 'alert' && it.chain === 'solana' ? 'rug' : null, it.tg && cfg.telegram.token ? 'tg' : null].filter(Boolean);
    if (need.every((k) => it.done[k])) it.dropped = true;
  }
  state.enrich = q.filter((it) => !it.dropped);
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
    // Cenę dociągamy tylko w pierwszej dobie i w oknach pomiarów (72 h, 7 dni) – nie przez cały tydzień.
    if (!outcomes.wantsPrice(a, Date.now())) continue;
    const i = a.key.indexOf(':');
    extra.push({ chain: a.chain || a.key.slice(0, i), address: a.address || a.key.slice(i + 1) });
  }
  for (const w of Object.values(state.watch)) extra.push({ chain: w.c, address: w.a });

  const { tokens, topics, all, asked } = await collectTokens(cfg, cache, report, extra);
  const now = Date.now();
  try {
    const m = await marketContext(cfg, cache);
    snapshot.market = Object.assign({}, m, { memes: memeHeat(topics.metas) });
    report('CoinGecko – rynek (BTC, ETH, SOL, BNB)', true, ['btc', 'eth', 'sol', 'bnb'].filter((k) => m[k]).length);
  } catch (e) {
    report('CoinGecko – rynek (BTC, ETH, SOL, BNB)', false, 0, e.message);
  }
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
    t.avgTx = avgTxOf(t);
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
    // GoPlus podaje liczbę posiadaczy przy kontroli – zapisujemy ją do historii bez dodatkowych zapytań.
    for (const t of tokens) if (t.secInfo && t.secInfo.holders != null) pushHist('holdersHist', t.key, t.secInfo.holders, now);
  }

  await sampleCandidates(tokens, now);
  for (const t of tokens) {
    const hh = cache.holdersHist && cache.holdersHist.get(t.key);
    if (hh && hh.length) t.holders = hh[hh.length - 1].c;
    const th = cache.tgHist && cache.tgHist.get(t.key);
    if (th && th.length) t.tgMembers = th[th.length - 1].c;
    t.tg = tgState(t);
  }

  for (const t of tokens) {
    const prev = prevScores.get(t.key);
    t.delta = prev == null ? null : Math.round((t.s.score - prev) * 10) / 10;
  }
  tokens.sort((a, b) => b.s.score - a.s.score || b.s.momentum - a.s.momentum);
  prevScores.clear();
  for (const t of tokens) prevScores.set(t.key, t.s.score);

  // Szczyt i dołek dla pomiarów 72 h i 7 dni – ze świec godzinowych GeckoTerminal (najwyżej 3 zapytania na skan).
  let candles = 0;
  outer: for (const a of state.alerts) {
    for (const w of outcomes.wantsExtremes(a, now)) {
      if (candles >= 3) break outer;
      candles++;
      try {
        const e = await candleExtremes(cfg, a, w.from, w.to);
        a.ext = Object.assign(a.ext || {}, { [w.name]: e || { hi: 0, lo: 0 } });
      } catch (e) {
        if (e.status === 429 || e.budget) break outer; // spróbujemy w następnym skanie
        a.ext = Object.assign(a.ext || {}, { [w.name]: { hi: 0, lo: 0 } });
      }
    }
  }

  // Pomiar wyników: każdy nowy wynik (1 h, 6 h, 24 h, 72 h, 7 dni) trafia do dziennika i do pliku szczegółów.
  const prev = new Map(state.alerts.map((a) => [a, { keys: Object.keys(a.checks || {}), done: !!a.done }]));
  outcomes.track(state.alerts, all, asked, now);
  for (const a of state.alerts) {
    const b = prev.get(a);
    if (!b) continue;
    let changed = false;
    for (const name of Object.keys(a.checks || {})) {
      if (b.keys.includes(name)) continue;
      changed = true;
      if (a.id && ['h1', 'h24', 'h72', 'd7'].includes(name) && !a.checks[name].missed) {
        (state.enrich = state.enrich || []).push({ id: a.id, tag: name, at: now, chain: a.chain, address: a.address, pair: a.pair || null, tg: a.tg || null });
      }
      if (a.id) {
        const extra = name === 'h24' ? { peakAt: a.peakAt, lowAt: a.lowAt, peakMin: a.peakAt ? Math.round((a.peakAt - a.at) / 60000) : null, path: a.path || null } : {};
        // Pole „t” pomiaru to jego godzina – w dzienniku zapisujemy ją jako „ct”, bo „t” oznacza typ linii.
        const c = a.checks[name];
        logSafe(Object.assign({}, c, extra, { t: 'check', id: a.id, at: now, name, ct: c.t }));
      }
    }
    if (a.done && !b.done) {
      changed = true;
      if (a.id) logSafe({ t: 'done', id: a.id, at: now });
    }
    if (changed) {
      stateDirty = true;
      writeDetail(a);
    }
  }
  const sentEarly = await tokenAlerts(tokens, now, 'early');
  const sent = await tokenAlerts(tokens, now, 'momentum');
  await processEnrich(now);

  // Taśma: stan wszystkich ocenianych tokenów co kilka minut.
  if (cfg.tape.enabled && now - tape.last >= Math.max(1, cfg.tape.intervalMin) * 60e3) {
    try {
      const bytes = tape.write(now, tokens, snapshot.market);
      report('Taśma skanów (kB na zapis)', true, Math.round(bytes / 1024));
    } catch (e) {
      report('Taśma skanów (kB na zapis)', false, 0, e.message);
    }
  }

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

  pruneAlerts();
  if (!cache.detailsPrunedAt || now - cache.detailsPrunedAt > 864e5) {
    cache.detailsPrunedAt = now;
    pruneDetails();
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
        const res = await deliver(tg.nftAlert(c), { alert: true });
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
        writeDetail(entry);
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
// Codzienna kopia danych (o godzinie backup.hour czasu lokalnego, raz na dobę).
const backupSrc = () => (process.env.RADAR_CONFIG ? path.dirname(CONFIG_PATH) : null);
async function maybeBackup() {
  const B = cfg.backup;
  const src = backupSrc();
  if (!B.enabled || !src) return;
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  if (state.lastBackupDay === day || d.getHours() < (B.hour || 0)) return;
  state.lastBackupDay = day;
  stateDirty = true;
  const dir = B.dir || path.join(path.dirname(src), 'krypto-radar-kopie');
  try {
    const r = await backup(src, dir, B.keep || 14);
    report('Kopia danych (MB)', true, Math.round(r.bytes / 1048576));
    log(`Kopia danych: ${r.file} (${Math.round(r.bytes / 1024)} kB)`);
  } catch (e) {
    report('Kopia danych (MB)', false, 0, e.message);
    log('Kopia danych nie powiodła się: ' + e.message);
  }
}

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
  }
  try {
    await maybeBackup();
    if (cfg.health.enabled && telegramReady()) for (const msg of health.check([...status.values()])) await deliver(msg);
  } catch (e) {
    log('Błąd kopii lub pilnowania: ' + e.message);
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
          group: alertTarget() ? { title: alertTarget().title || '', topic: !!alertTarget().thread } : null,
          error: tgInfo.error,
          pairCode: cfg.telegram.token && !cfg.telegram.chatId ? cfg.telegram.pairCode || null : null,
        },
    opensea: { ownKey: !!(cfg.opensea && cfg.opensea.apiKey) },
    auth: { enabled: !!cfg.auth.passwordHash },
    publish: { enabled: !!(cfg.publish.enabled && cfg.publish.repo), intervalSec: cfg.publish.intervalSec, site: siteUrl() },
    solana: { separate: solApart(), telegram: !!(cfg.solana && cfg.solana.telegram) },
    minScanSec: MIN_SCAN_SEC,
  };
}

// Dane dla przeglądarki – te same lokalnie i na GitHubie (tam bez sekretów, patrz publicConfig).
function stateJson(forSite) {
  return {
    tokens: snapshot.tokens,
    nfts: snapshot.nfts,
    topics: snapshot.topics,
    alertsCount: {
      day: state.alerts.filter((a) => Date.now() - a.at < 864e5 && mainScope(a.chain)).length,
      sol: state.alerts.filter((a) => Date.now() - a.at < 864e5 && a.chain === 'solana').length,
      total: calllog.calls.size,
    },
    market: snapshot.market || null,
    appVersion: APP_VERSION,
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

// Alerty z ostatnich 24 h – z bieżącym szczytem, dołkiem i przebiegiem ceny (zmienia się co kilka minut).
function alertsLive() {
  const now = Date.now();
  return { alerts: state.alerts.filter((a) => now - a.at < 864e5).map(rowOf) };
}
// Indeks: wszystkie alerty z 30 dni w skrócie – do podglądu skuteczności, filtrów i historii.
// Zmienia się tylko przy nowym alercie albo pomiarze, więc git nie wysyła go co 2 minuty.
function alertsIndex() {
  return { rows: calllog.index(Date.now(), 30) };
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
    const r = await publisher.publish(stateJson(true), { 'alerts-live.json': alertsLive(), 'alerts-index.json': alertsIndex() }, { details: DETAILS_DIR });
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
  const toks = (snapshot.tokens || []).filter((t) => mainScope(t.chain));
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
  const today = state.alerts.filter((a) => Date.now() - a.at < 24 * 3.6e6 && mainScope(a.chain)).length;
  out.push('', `Alertów w 24 h: ${today}`);
  const at = alertTarget();
  out.push(at ? `Alerty idą do grupy „${tgEsc(at.title || at.id)}”${at.thread ? ' (wybrany temat)' : ''}` : 'Alerty idą do prywatnej rozmowy');
  if (solApart()) {
    const sol = state.alerts.filter((a) => Date.now() - a.at < 24 * 3.6e6 && a.chain === 'solana').length;
    out.push(`Solana (osobno${solMuted('solana') ? ', bez powiadomień' : ''}): ${sol} alertów w 24 h – /wyniki solana`);
  }
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
  const words = plain(arg || '').split(/\s+/).filter(Boolean);
  const sol = words.includes('solana') || words.includes('sol');
  const key = words.map((w) => map[w]).find(Boolean) || 'd7';
  // Solana osobno: /wyniki – bez Solany, /wyniki solana – tylko Solana.
  const only = sol ? (c) => c.chain === 'solana' : solApart() ? (c) => c.chain !== 'solana' : null;
  const H = calllog.summary(Date.now(), only);
  const P = H[key];
  const label = H.periods.find((x) => x.key === key).label + (sol ? ', tylko Solana' : solApart() ? ', bez Solany' : '');
  const pc = (x) => (x == null ? '–' : (x > 0 ? '+' : '') + x + '%');
  const line = (name, st) => {
    if (!st.n) return `<b>${name}</b>: brak alertów`;
    const h = (k, l) => (st[k].n ? `${l}: ${st[k].up}% na plusie, mediana ${pc(st[k].median)} (${st[k].n})` : `${l}: jeszcze brak`);
    const pk = st.peak.n ? `szczyt w 24 h: mediana ${pc(st.peak.median)}, ${st.peak.p20}% doszło do +20%, ${st.peak.p50}% do +50%` : 'szczyt: jeszcze brak';
    return [`<b>${name}</b> – ${st.n} alertów`, h('h1', 'po 1 h'), h('h24', 'po 24 h'), h('h72', 'po 72 h'), h('d7', 'po 7 dniach'), pk, st.dead ? `zniknęło lub wycofana płynność: ${st.dead}` : null].filter(Boolean).join('\n');
  };
  const out = [`📊 <b>Skuteczność – ${label}</b>`, '', line('Wczesne', P.kinds.early), '', line('Gorące', P.kinds.momentum)];
  const bk = P.buckets.early.filter((b) => b.h24.n);
  if (bk.length) out.push('', '<b>Wczesne wg wyniku (po 24 h)</b>', ...bk.map((b) => `${b.label}: ${b.h24.up}% na plusie, mediana ${pc(b.h24.median)} (${b.h24.n})`));
  const closed = P.all.h24.n;
  out.push('', closed < 30 ? `Zamkniętych po 24 h: ${closed} – poniżej ~30 wynik niewiele mówi.` : `Zamkniętych po 24 h: ${closed}.`, 'Inne okresy: /wyniki 24h | 7d | 30d | all' + (solApart() ? '; Solana: /wyniki solana 7d' : ''));
  return out.join('\n');
}

async function exportCsv(ctx) {
  const csv = calllog.csv();
  const name = `krypto-radar-alerty-${new Date().toISOString().slice(0, 10)}.csv`;
  await tg.sendDocument(cfg, name, csv, `Historia alertów (${calllog.calls.size}). Otwórz w Excelu albo Arkuszach Google.`, ctx && ctx.type !== 'private' ? ctx : null);
  return null;
}

// ctx – skąd przyszła komenda: { id, thread, type, title } (prywatna rozmowa albo grupa).
async function handleCommand(text, ctx) {
  const [raw, ...rest] = text.split(/\s+/);
  const [name, to] = raw.slice(1).split('@');
  // W grupie komenda do innego bota (np. /status@inny_bot) nie jest dla nas.
  if (to && tgInfo.bot && to.toLowerCase() !== String(tgInfo.bot).toLowerCase()) return null;
  const cmd = plain(name);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'tutaj':
      return hereCommand(ctx);
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
      return exportCsv(ctx);
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

// /tutaj w grupie: alerty idą do tej grupy (i tego tematu); w prywatnej rozmowie: z powrotem prywatnie.
function hereCommand(ctx) {
  if (!ctx || ctx.type === 'private') {
    if (!alertTarget()) return 'Alerty i tak przychodzą tutaj, do prywatnej rozmowy. Żeby wysyłać je do grupy: dodaj bota do grupy i wyślij tam /tutaj (w wybranym temacie, jeśli grupa ma tematy).';
    cfg.telegram.alertChat = null;
    saveConfig();
    publishDue = true;
    return '✅ Alerty znowu przychodzą tutaj, do prywatnej rozmowy.';
  }
  cfg.telegram.alertChat = { id: ctx.id, thread: ctx.thread || null, title: ctx.title || '' };
  saveConfig();
  publishDue = true;
  log(`Telegram: alerty do grupy „${ctx.title}”` + (ctx.thread ? ` (temat ${ctx.thread})` : ''));
  return `✅ Od teraz alerty przychodzą tutaj${ctx.thread ? ', do tego tematu' : ''}.\nKomendy działają w tej grupie tylko z Twojego konta – innych członków bot ignoruje. Odpowiedzi na komendy przychodzą tam, gdzie je wyślesz.\nPowrót do prywatnej rozmowy: /tutaj w rozmowie z botem.`;
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
  if (req.method === 'GET' && url.pathname === '/api/alerts') return json(res, 200, { live: alertsLive(), index: alertsIndex() });
  if (req.method === 'GET' && url.pathname === '/api/alert') {
    const d = readDetail(url.searchParams.get('id'));
    return d ? json(res, 200, d) : json(res, 404, { error: 'Brak szczegółów tego alertu' });
  }
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
        // Tą samą drogą co alerty: do wybranej grupy, a gdy ona nie przyjmuje – prywatnie.
        const r = await deliver('🔔 Test: Krypto Radar działa i może wysyłać alerty.', { alert: true });
        if (!r.sent) throw new Error(r.error);
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
    setBudget('gt', cfg.gtPerMin);
    if (backfillAlerts()) for (const a of state.alerts) writeDetail(a);
    cycle();
    if (cfg.telegram.token && !tgInfo.bot) tg.botName(cfg).then((n) => (tgInfo.bot = n)).catch(() => {});
    tgbot.startPolling({
      getCfg: () => cfg,
      state,
      onCommand: handleCommand,
      send: (html, to) => tg.send(cfg, html, to),
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
