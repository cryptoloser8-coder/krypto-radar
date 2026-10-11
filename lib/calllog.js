'use strict';
// Dziennik alertów: każdy alert zapisany na stałe z pełnymi danymi z chwili wysłania,
// a potem jego wyniki (cena po 1, 6 i 24 h, szczyt i dołek w ciągu 24 h).
//
// Pliki: <katalog>/calls-RRRR-MM.jsonl – jedna linia JSON na zdarzenie, tylko dopisywane:
//   {"t":"call",  "id":…, "at":…, …pełny obraz tokena, wyniki, flagi, progi…}
//   {"t":"check", "id":…, "name":"h1"|"h6"|"h24", "chg":…, "p":…, "liq":…, "rug"?, "dead"?, "missed"?}
//   {"t":"done",  "id":…, "peak":…, "peakAt":…, "low":…, "lowAt":…, "peakPct":…, "lowPct":…}
// Do statystyk w pamięci trzymamy tylko skrócone rekordy; pełne dane czyta eksport CSV.

const fs = require('fs');
const path = require('path');

const H = ['h1', 'h6', 'h24'];
const PERIODS = [['d1', 864e5, '24 h'], ['d7', 7 * 864e5, '7 dni'], ['d30', 30 * 864e5, '30 dni'], ['all', Infinity, 'całość']];
const BUCKETS = [[0, 50, '<50'], [50, 60, '50–59'], [60, 70, '60–69'], [70, 1e9, '70+']];
const r1 = (x) => Math.round(x * 10) / 10;

class CallLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.calls = new Map(); // id → skrócony rekord
    this.details = new Map(); // id → obraz z chwili alertu (tylko ostatnie DETAILS_MAX, do panelu)
    this.load();
  }

  files() {
    return fs.readdirSync(this.dir).filter((f) => /^calls-\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(this.dir, f));
  }

  *lines() {
    for (const f of this.files()) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch (e) {
          // uszkodzona linia (np. przerwany zapis przy odcięciu prądu) – pomijamy
        }
      }
    }
  }

  load() {
    this.calls.clear();
    this.details.clear();
    for (const o of this.lines()) this.apply(o);
  }

  apply(o) {
    if (o.t === 'call') {
      this.calls.set(o.id, {
        id: o.id, at: o.at, type: o.type, kind: o.kind, symbol: o.symbol, chain: o.chain,
        score: o.score, risk: o.risk, price0: o.price, sent: o.sent, checks: {}, done: false,
      });
      this.details.set(o.id, detailOf(o));
      if (this.details.size > DETAILS_MAX) this.details.delete(this.details.keys().next().value);
    } else if (o.t === 'check' && this.calls.has(o.id)) {
      const c = this.calls.get(o.id);
      c.checks[o.name] = { chg: o.chg, dead: o.dead, rug: o.rug, missed: o.missed };
    } else if (o.t === 'done' && this.calls.has(o.id)) {
      Object.assign(this.calls.get(o.id), { done: true, peakPct: o.peakPct, lowPct: o.lowPct, peakMin: o.peakMin });
    }
  }

  append(o) {
    const d = new Date(o.at || Date.now());
    const file = path.join(this.dir, `calls-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(o) + '\n', { mode: 0o600 });
    this.apply(o);
  }

  // ---- Statystyki ----------------------------------------------------------

  static stat(list) {
    const out = { n: list.length };
    for (const h of H) {
      const v = list.map((c) => c.checks[h]).filter((x) => x && !x.missed && Number.isFinite(x.chg)).map((x) => x.chg);
      out[h] = { n: v.length };
      if (v.length) {
        Object.assign(out[h], {
          up: share(v, (x) => x > 0),
          median: r1(median(v)),
          avg: r1(v.reduce((s, x) => s + x, 0) / v.length),
          big: share(v, (x) => x >= 50),
          bad: share(v, (x) => x <= -50),
        });
      }
    }
    const pk = list.filter((c) => c.done && Number.isFinite(c.peakPct));
    out.peak = { n: pk.length };
    if (pk.length) {
      const v = pk.map((c) => c.peakPct);
      Object.assign(out.peak, { median: r1(median(v)), p20: share(v, (x) => x >= 20), p50: share(v, (x) => x >= 50), min: r1(median(pk.map((c) => c.peakMin || 0))) });
    }
    out.dead = list.filter((c) => c.checks.h24 && (c.checks.h24.dead || c.checks.h24.rug)).length;
    return out;
  }

  summary(now = Date.now()) {
    const tokens = [...this.calls.values()].filter((c) => c.type === 'token' && c.price0 > 0);
    const out = { periods: PERIODS.map(([k, , label]) => ({ key: k, label })), buckets: BUCKETS.map((b) => b[2]), first: null, total: tokens.length };
    if (tokens.length) out.first = Math.min(...tokens.map((c) => c.at));
    for (const [k, ms] of PERIODS) {
      const list = tokens.filter((c) => now - c.at <= ms);
      const p = { all: CallLog.stat(list), kinds: {}, buckets: {}, chains: [] };
      for (const kind of ['early', 'momentum']) {
        const lk = list.filter((c) => (c.kind || 'momentum') === kind);
        p.kinds[kind] = CallLog.stat(lk);
        p.buckets[kind] = BUCKETS.map(([lo, hi, label]) => Object.assign({ label }, CallLog.stat(lk.filter((c) => c.score >= lo && c.score < hi))));
      }
      const byChain = new Map();
      for (const c of list) byChain.set(c.chain, (byChain.get(c.chain) || []).concat(c));
      p.chains = [...byChain].sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([chain, l]) => Object.assign({ chain }, CallLog.stat(l)));
      out[k] = p;
    }
    return out;
  }

  // ---- Eksport CSV (Excel z polskimi ustawieniami: średniki, przecinek dziesiętny) ----

  csv() {
    const calls = new Map();
    for (const o of this.lines()) {
      if (o.t === 'call') calls.set(o.id, { call: o, checks: {}, done: null });
      else if (o.t === 'check' && calls.has(o.id)) calls.get(o.id).checks[o.name] = o;
      else if (o.t === 'done' && calls.has(o.id)) calls.get(o.id).done = o;
    }
    const num = (x, d = 6) => (x == null || !Number.isFinite(+x) ? '' : String(+(+x).toFixed(d)).replace('.', ','));
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const local = (t) => (t ? new Date(t).toLocaleString('pl-PL', { timeZone: process.env.TZ || undefined }) : '');
    const head = [
      'id', 'czas', 'rodzaj', 'symbol', 'nazwa', 'sieć', 'adres', 'wynik', 'ryzyko', 'flagi', 'wysłano',
      'cena', 'płynność $', 'wycena $', 'wolumen 1h $', 'wolumen 24h $', 'zmiana 1h %', 'zmiana 6h %', 'zmiana 24h %',
      'wiek h', 'kupujący 1h %', 'transakcje 1h', 'portfele kupujące 1h', 'portfele sprzedające 1h', 'źródła', 'kontrola kontraktu',
      'wynik gorący', 'wynik wczesny', 'próg alertu',
      'cena po 1h', 'zmiana po 1h %', 'cena po 6h', 'zmiana po 6h %', 'cena po 24h', 'zmiana po 24h %',
      'szczyt 24h %', 'szczyt po min', 'dołek 24h %', 'płynność wycofana', 'zniknął', 'wykres',
    ];
    const rows = [head.map(cell).join(';')];
    for (const { call: c, checks: k, done } of [...calls.values()].sort((a, b) => a.call.at - b.call.at)) {
      const ch = (h) => k[h] || {};
      const res = (h) => (ch(h).missed ? ['', 'pominięty'] : [num(ch(h).p, 12), num(ch(h).chg, 1)]);
      const u = c.uniq && c.uniq.h1;
      rows.push([
        c.id, local(c.at), c.type === 'nft' ? 'NFT' : c.kind === 'early' ? 'wczesny' : 'gorący', c.symbol, c.name, c.chain, c.address || c.slug,
        num(c.score, 1), c.risk, (c.flags || []).filter((f) => f.sev !== 'info').map((f) => f.text).join(' | '), c.sent ? 'tak' : 'nie',
        num(c.price, 12), num(c.liquidityUsd, 0), num(c.marketCap || c.fdv, 0), num(c.vol && c.vol.h1, 0), num(c.vol && c.vol.h24, 0),
        num(c.chg && c.chg.h1, 1), num(c.chg && c.chg.h6, 1), num(c.chg && c.chg.h24, 1),
        num(c.ageH, 1), num(c.buyRatio == null ? null : c.buyRatio * 100, 0), c.tx1 == null ? '' : c.tx1, u ? u.buyers : '', u ? u.sellers : '',
        (c.sources || []).join(', '), c.security || '',
        num(c.momentum && c.momentum.score, 1), num(c.early && c.early.score, 1), num(c.threshold, 0),
        ...res('h1'), ...res('h6'), ...res('h24'),
        num(done && done.peakPct, 1), done ? done.peakMin : '', num(done && done.lowPct, 1),
        H.some((h) => ch(h).rug) ? 'tak' : '', H.some((h) => ch(h).dead) ? 'tak' : '', c.url,
      ].map(cell).join(';'));
    }
    return '﻿' + rows.join('\r\n') + '\r\n';
  }
}

const DETAILS_MAX = 1500;
const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]])) : null);

// Skrót pełnego zapisu – to, co panel pokazuje po rozwinięciu alertu.
function detailOf(o) {
  if (o.type === 'nft') return pick(o, ['floor', 'currency', 'sales1d', 'vol1d', 'vol7d', 'owners', 'rank1h', 'rank1d', 'threshold', 'flags']);
  return {
    threshold: o.threshold, name: o.name, address: o.address, pumpUrl: o.pumpUrl,
    price: o.price, liq: o.liquidityUsd, mc: o.marketCap || o.fdv, ageH: o.ageH == null ? null : r1(o.ageH),
    vol: pick(o.vol, ['m5', 'h1', 'h6', 'h24']), chg: pick(o.chg, ['m5', 'h1', 'h6', 'h24']),
    buyRatio: o.buyRatio, tx1: o.tx1, uniq: o.uniq && o.uniq.h1 ? o.uniq.h1 : null,
    sources: o.sources, metas: o.metas, security: o.security,
    flags: (o.flags || []).map((f) => ({ sev: f.sev, text: f.text })),
    momentum: o.momentum ? { score: o.momentum.score, parts: o.momentum.parts, penalty: o.momentum.penalty } : null,
    early: o.early ? { score: o.early.score, parts: o.early.parts, late: o.early.late, penalty: o.early.penalty, volX: o.early.volX, txX: o.early.txX } : null,
  };
}

function median(v) {
  const s = v.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function share(v, f) {
  return Math.round((100 * v.filter(f).length) / v.length);
}

module.exports = { CallLog, PERIODS, BUCKETS };
