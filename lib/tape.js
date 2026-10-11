'use strict';
// „Taśma”: co kilka minut skrócony stan WSZYSTKICH ocenianych tokenów, nie tylko tych z alertem.
// Daje grupę kontrolną, kandydatów spod progu i możliwość sprawdzenia nowych reguł na przeszłości.
//
// Pliki: <katalog>/tape-RRRR-MM-DD.jsonl – jedna linia na zapis: { at, market, tokens: [...] }.
// Pliki z poprzednich dni są pakowane do .jsonl.gz (ok. 2–4 MB na dobę).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const r = (x, d = 1) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 10 ** d) / 10 ** d);
const sig = (x) => (x == null || !Number.isFinite(+x) ? null : Number((+x).toPrecision(6)));

// Skrócony zapis tokena. Klucze krótkie, bo linii jest kilkaset na zapis.
function compact(t) {
  const tx = t.txns || {}, v = t.vol || {}, c = t.chg || {};
  const pair = (w) => [(tx[w] && tx[w].buys) || 0, (tx[w] && tx[w].sells) || 0];
  const u = t.uniq && t.uniq.h1;
  const o = {
    k: t.key, s: t.symbol, c: t.chain, p: sig(t.priceUsd), l: r(t.liquidityUsd, 0), mc: r(t.marketCap || t.fdv, 0),
    v: [r(v.m5, 0), r(v.h1, 0), r(v.h6, 0), r(v.h24, 0)],
    t5: pair('m5'), t1: pair('h1'), t24: pair('h24'),
    ch: [r(c.m5), r(c.h1), r(c.h6), r(c.h24)],
    a: t.s && t.s.parts.ageH != null ? r(t.s.parts.ageH) : null,
    sm: t.seenMin == null ? null : t.seenMin,
    sc: t.s ? r(t.s.score) : null, mo: t.s ? r(t.s.momentum) : null, rk: t.s ? t.s.risk : null,
    es: t.e ? r(t.e.score) : null, er: t.e ? r(t.e.raw) : null, in: t.e && t.e.inScope ? 1 : 0,
    f: t.s ? t.s.flags.filter((f) => f.sev !== 'info').map((f) => f.code) : [],
    src: t.sources || [],
    sec: t.security || null,
  };
  if (u) o.u = [u.buyers, u.sellers];
  if (t.holders) o.h = t.holders;
  if (t.tgMembers != null) o.tg = t.tgMembers;
  if (t.secInfo) {
    if (t.secInfo.lpLockedPct != null) o.lp = t.secInfo.lpLockedPct;
    if (t.secInfo.top10Pct != null) o.top = t.secInfo.top10Pct;
  }
  if (t.alerted) o.al = t.alerted; // 'e' – wczesny, 'm' – gorący (alert w tym skanie)
  return o;
}

class Tape {
  constructor(dir) {
    this.dir = dir;
    this.last = 0;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  file(at) {
    const d = new Date(at);
    return path.join(this.dir, `tape-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`);
  }

  write(at, tokens, market) {
    const line = JSON.stringify({ at, market: market || null, tokens: tokens.map(compact) });
    fs.appendFileSync(this.file(at), line + '\n', { mode: 0o600 });
    this.last = at;
    this.compressOld(at);
    return Buffer.byteLength(line);
  }

  // Pliki z poprzednich dni → .gz (raz, przy pierwszym zapisie nowego dnia).
  compressOld(at) {
    const today = path.basename(this.file(at));
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^tape-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f === today) continue;
      const src = path.join(this.dir, f);
      try {
        fs.writeFileSync(src + '.gz.tmp', zlib.gzipSync(fs.readFileSync(src)), { mode: 0o600 });
        fs.renameSync(src + '.gz.tmp', src + '.gz');
        fs.unlinkSync(src);
      } catch (e) {
        // spróbujemy przy następnym zapisie
      }
    }
  }

  // Odczyt (do analiz i testów): wszystkie zapisy z plików, także spakowanych.
  *read() {
    const files = fs.readdirSync(this.dir).filter((f) => /^tape-.*\.jsonl(\.gz)?$/.test(f)).sort();
    for (const f of files) {
      let buf = fs.readFileSync(path.join(this.dir, f));
      if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch (e) {}
      }
    }
  }
}

module.exports = { Tape, compact };
