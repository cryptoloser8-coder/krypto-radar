'use strict';
// Dziennik alertów: każdy alert zapisany na stałe z pełnymi danymi z chwili wysłania,
// a potem jego wyniki: cena po 1, 6, 24, 72 h i 7 dniach oraz szczyt (pk) i dołek (lo) w każdym z tych okien.
//
// Pliki: <katalog>/calls-RRRR-MM.jsonl – jedna linia JSON na zdarzenie, tylko dopisywane:
//   {"t":"call",  "id":…, "at":…, …pełny obraz tokena, wyniki, flagi, progi…}
//   {"t":"check", "id":…, "name":"h1"|"h6"|"h24"|"h72"|"d7", "chg":…, "p":…, "liq":…, "pk":…, "lo":…, "rug"?, "dead"?, "missed"?, "approx"?}
//   {"t":"done",  "id":…}  – wszystkie pomiary zakończone (starsze wersje dopisywały tu szczyt z 24 h)
// Do statystyk w pamięci trzymamy tylko skrócone rekordy; pełne dane czyta eksport CSV.

const fs = require('fs');
const path = require('path');

const H = ['h1', 'h24', 'h72', 'd7']; // okna w statystykach, indeksie i podglądzie
const ALL_CHECKS = ['h1', 'h6', 'h24', 'h72', 'd7'];
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
    // Wersja z 11.10.2026 zapisywała pomiary z polem „t” nadpisanym godziną pomiaru – rozpoznajemy je po nazwie okna.
    if (typeof o.t === 'number' && o.id && o.name) o = Object.assign({}, o, { t: 'check', ct: o.t });
    if (o.t === 'call') {
      this.calls.set(o.id, {
        id: o.id, at: o.at, type: o.type, kind: o.kind, symbol: o.symbol, chain: o.chain,
        score: o.score, risk: o.risk, price0: o.price, sent: o.sent, checks: {}, done: false,
      });
      this.details.set(o.id, detailOf(o));
      if (this.details.size > DETAILS_MAX) this.details.delete(this.details.keys().next().value);
    } else if (o.t === 'check' && this.calls.has(o.id)) {
      const c = this.calls.get(o.id);
      c.checks[o.name] = { chg: o.chg, dead: o.dead, rug: o.rug, missed: o.missed, pk: o.pk, lo: o.lo, approx: o.approx };
      if (o.name === 'h24' && o.peakMin != null) c.peakMin = o.peakMin;
    } else if (o.t === 'done' && this.calls.has(o.id)) {
      const c = this.calls.get(o.id);
      c.done = true;
      // Starszy format: szczyt i dołek z 24 h były tylko w linii „done”.
      if (o.peakPct != null && c.checks.h24 && c.checks.h24.pk == null) Object.assign(c.checks.h24, { pk: o.peakPct, lo: o.lowPct });
      if (o.peakMin != null) c.peakMin = o.peakMin;
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
    // Szczyt w ciągu 24 h – czy w ogóle była okazja do wyjścia z zyskiem.
    const pk = list.filter((c) => c.checks.h24 && Number.isFinite(c.checks.h24.pk));
    out.peak = { n: pk.length };
    if (pk.length) {
      const v = pk.map((c) => c.checks.h24.pk);
      Object.assign(out.peak, { median: r1(median(v)), p20: share(v, (x) => x >= 20), p50: share(v, (x) => x >= 50), min: r1(median(pk.map((c) => c.peakMin || 0))) });
    }
    out.dead = list.filter((c) => Object.values(c.checks).some((x) => x && (x.dead || x.rug))).length;
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

  // ---- Indeks dla strony: wszystkie alerty z `days` dni w skrócie -----------------
  // x: { okno: [zmiana %, szczyt %, dołek %, znacznik] }, znacznik: 'd' zniknął, 'r' wycofana płynność,
  // 'a' szczyt przybliżony (bez świec), 'm' pomiar pominięty (wtedy tylko ['m']).
  index(now = Date.now(), days = 30) {
    const rows = [];
    for (const c of this.calls.values()) {
      if (now - c.at > days * 864e5) continue;
      const x = {};
      for (const h of H) {
        const k = c.checks[h];
        if (!k) continue;
        if (k.missed) x[h] = ['m'];
        else x[h] = [k.chg, k.pk == null ? null : k.pk, k.lo == null ? null : k.lo, k.dead ? 'd' : k.rug ? 'r' : k.approx ? 'a' : ''];
      }
      rows.push({ id: c.id, at: c.at, t: c.type === 'nft' ? 'n' : c.kind === 'early' ? 'e' : 'm', s: c.symbol, c: c.chain, sc: c.score == null ? null : r1(c.score), r: c.risk, p0: c.price0, se: c.sent ? 1 : 0, x });
    }
    return rows.sort((a, b) => b.at - a.at);
  }

  // ---- Eksport CSV (Excel z polskimi ustawieniami: średniki, przecinek dziesiętny) ----

  csv() {
    const calls = new Map();
    for (let o of this.lines()) {
      if (typeof o.t === 'number' && o.id && o.name) o = Object.assign({}, o, { t: 'check', ct: o.t });
      if (o.t === 'call') calls.set(o.id, { call: o, checks: {}, done: null });
      else if (o.t === 'check' && calls.has(o.id)) calls.get(o.id).checks[o.name] = o;
      else if (o.t === 'done' && calls.has(o.id)) calls.get(o.id).done = o;
      else if (o.t === 'enrich' && calls.has(o.id)) {
        const e = (calls.get(o.id).enrich = calls.get(o.id).enrich || {});
        e[o.tag] = Object.assign(e[o.tag] || {}, o);
      }
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
      ...ALL_CHECKS.flatMap((h) => [`cena po ${LBL[h]}`, `zmiana po ${LBL[h]} %`, `szczyt do ${LBL[h]} %`, `dołek do ${LBL[h]} %`]),
      'szczyt 24h po min', 'płynność wycofana', 'zniknął',
      'BTC 1h %', 'BTC 24h %', 'SOL 1h %', 'SOL 24h %', 'ETH 24h %', 'memecoiny 24h %', 'śr. transakcja 1h $',
      'posiadacze przy alercie', 'posiadacze: zmiana przed alertem', 'posiadacze: w ciągu min', 'posiadacze po 1h', 'posiadacze po 24h', 'posiadacze po 72h', 'posiadacze po 7d',
      'top 10 portfeli %', 'insiderzy w top %', 'sieci insiderów', 'twórca %', 'płynność zablokowana %',
      'śr. kupno $', 'mediana kupna $', 'kupna ≥ 5 tys. $', 'unikalni kupujący (ost. transakcje)', 'top 5 kupujących % wolumenu', 'kupujący 3+ razy',
      'Telegram stan', 'Telegram nazwa', 'Telegram członków', 'Telegram: zmiana przed alertem', 'Telegram po 24h',
      'wykres',
    ];
    const rows = [head.map(cell).join(';')];
    for (const { call: c, checks: k, done, enrich: en = {} } of [...calls.values()].sort((a, b) => a.call.at - b.call.at)) {
      const mk = (c.market || {});
      const hp = c.holdersPre || {};
      const ea = en.alert || {};
      const hAt = ea.holders ? ea.holders.count : hp.count != null ? hp.count : c.secInfo && c.secInfo.holders;
      const hAfter = (tag) => (en[tag] && en[tag].holders ? en[tag].holders.count : '');
      const ins = ea.insiders || {};
      const sec = c.secInfo || {};
      const tr = ea.trades || {};
      const tp = c.tgPre || {};
      const ch = (h) => k[h] || {};
      const res = (h) => (ch(h).missed ? ['', 'pominięty', '', ''] : [num(ch(h).p, 12), num(ch(h).chg, 1), num(ch(h).pk ?? (h === 'h24' && done ? done.peakPct : null), 1), num(ch(h).lo ?? (h === 'h24' && done ? done.lowPct : null), 1)]);
      const u = c.uniq && c.uniq.h1;
      rows.push([
        c.id, local(c.at), c.type === 'nft' ? 'NFT' : c.kind === 'early' ? 'wczesny' : 'gorący', c.symbol, c.name, c.chain, c.address || c.slug,
        num(c.score, 1), c.risk, (c.flags || []).filter((f) => f.sev !== 'info').map((f) => f.text).join(' | '), c.sent ? 'tak' : 'nie',
        num(c.price, 12), num(c.liquidityUsd, 0), num(c.marketCap || c.fdv, 0), num(c.vol && c.vol.h1, 0), num(c.vol && c.vol.h24, 0),
        num(c.chg && c.chg.h1, 1), num(c.chg && c.chg.h6, 1), num(c.chg && c.chg.h24, 1),
        num(c.ageH, 1), num(c.buyRatio == null ? null : c.buyRatio * 100, 0), c.tx1 == null ? '' : c.tx1, u ? u.buyers : '', u ? u.sellers : '',
        (c.sources || []).join(', '), c.security || '',
        num(c.momentum && c.momentum.score, 1), num(c.early && c.early.score, 1), num(c.threshold, 0),
        ...ALL_CHECKS.flatMap(res),
        ch('h24').peakMin ?? (done ? done.peakMin : '') ?? '',
        ALL_CHECKS.some((h) => ch(h).rug) ? 'tak' : '', ALL_CHECKS.some((h) => ch(h).dead) ? 'tak' : '',
        num(mk.btc && mk.btc.h1, 1), num(mk.btc && mk.btc.h24, 1), num(mk.sol && mk.sol.h1, 1), num(mk.sol && mk.sol.h24, 1), num(mk.eth && mk.eth.h24, 1), num(mk.memes && mk.memes.h24, 1),
        num(c.avgTx && c.avgTx.h1, 2),
        hAt ?? '', hp.change ?? '', hp.minutes ?? '', hAfter('h1'), hAfter('h24'), hAfter('h72'), hAfter('d7'),
        num((ea.holders && ea.holders.top10) ?? ins.top10Pct ?? sec.top10Pct, 1), num(ins.insiderPctTop, 1), ins.insiderNetworks ?? '', num(ins.creatorPct ?? sec.creatorPct, 2), num(ins.lpLockedPct ?? sec.lpLockedPct, 1),
        num(tr.buy && tr.buy.avg, 2), num(tr.buy && tr.buy.med, 2), tr.whales ?? '', tr.uniqueBuyers ?? '', num(tr.top5Share, 1), tr.repeatBuyers ?? '',
        TGS[(c.tg && c.tg.s) || ea.tgStatus] || '', (c.tg && (c.tg.title || c.tg.name)) || '',
        ea.tgMembers ?? tp.count ?? (c.tg && c.tg.n) ?? '', tp.change ?? '', en.h24 && en.h24.tgMembers != null ? en.h24.tgMembers : '',
        c.url,
      ].map(cell).join(';'));
    }
    return '﻿' + rows.join('\r\n') + '\r\n';
  }
}

const TGS = { public: 'publiczny', private: 'prywatny', none: 'brak', notfound: 'nie istnieje', bot: 'bot', folder: 'folder', invalid: 'zły link' };
const DETAILS_MAX = 1500;
const LBL = { h1: '1h', h6: '6h', h24: '24h', h72: '72h', d7: '7d' };
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
    market: o.market || null, avgTx: o.avgTx || null, secInfo: o.secInfo || null,
    holdersPre: o.holdersPre || null, tgPre: o.tgPre || null, tgLink: o.tgLink || null, tg: o.tg || null,
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
