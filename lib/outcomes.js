'use strict';
// Pomiar skuteczności: przy każdym alercie zapisujemy cenę, a potem sprawdzamy ją
// po 1, 6 i 24 godzinach. Czyste funkcje – czas podajemy z zewnątrz, żeby dało się to testować.

// [nazwa, po jakim czasie, ile spóźnienia tolerujemy]
const CHECKS = [
  ['h1', 3.6e6, 20 * 60e3],
  ['h6', 6 * 3.6e6, 60 * 60e3],
  ['h24', 24 * 3.6e6, 3 * 3.6e6],
];
const r1 = (x) => Math.round(x * 10) / 10;
const tracked = (a) => a.type === 'token' && a.price0 > 0;

// alerts – lista alertów (modyfikowana w miejscu), all – Map(klucz → aktualne dane tokena),
// asked – Set kluczy, o które DexScreener został w tym skanie skutecznie zapytany.
function track(alerts, all, asked, now) {
  for (const a of alerts) {
    if (!tracked(a) || a.done) continue;
    a.checks = a.checks || {};
    const rec = all.get(a.key);
    const p = rec && rec.priceUsd > 0 ? rec.priceUsd : null;
    if (p) {
      if (!(a.peak >= p)) a.peak = p;
      if (!(a.low <= p)) a.low = p;
    }
    let open = 0;
    for (const [name, ms, tol] of CHECKS) {
      if (a.checks[name]) continue;
      const due = a.at + ms;
      if (now < due) {
        open++;
      } else if (now <= due + tol) {
        if (p) {
          const c = { chg: r1((p / a.price0 - 1) * 100), t: now };
          // Płynność spadła poniżej 1/5 tej z chwili alertu: pula została w praktyce wycofana.
          if (a.liq0 > 0 && rec.liquidityUsd != null && rec.liquidityUsd < 0.2 * a.liq0) c.rug = true;
          a.checks[name] = c;
        } else {
          // DexScreener odpowiedział, ale tokena już nie zna – liczymy takie skany.
          if (asked.has(a.key)) {
            a.miss = a.miss || {};
            a.miss[name] = (a.miss[name] || 0) + 1;
          }
          open++;
        }
      } else {
        // Okno minęło bez ceny: token zniknął (3+ skany bez danych) albo aplikacja była wyłączona.
        a.checks[name] = a.miss && a.miss[name] >= 3 ? { dead: true, chg: -100, t: now } : { missed: true };
      }
    }
    if (!open) {
      a.done = true;
      delete a.miss;
    }
  }
}

const median = (v) => {
  const s = v.slice().sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const share = (v, f) => Math.round((100 * v.filter(f).length) / v.length);

function stats(alerts) {
  const out = {};
  for (const kind of ['early', 'momentum']) {
    const list = alerts.filter((a) => tracked(a) && (a.kind || 'momentum') === kind);
    const o = { total: list.length };
    for (const [name] of CHECKS) {
      const v = list.map((a) => a.checks && a.checks[name]).filter((c) => c && !c.missed).map((c) => c.chg);
      o[name] = { n: v.length };
      if (v.length) Object.assign(o[name], { up: share(v, (x) => x > 0), median: r1(median(v)), big: share(v, (x) => x >= 50), bad: share(v, (x) => x <= -50) });
    }
    // Najwyższa cena w ciągu 24 h od alertu – czy w ogóle była okazja do wyjścia z zyskiem.
    const peaks = list.filter((a) => a.checks && a.checks.h24 && !a.checks.h24.missed && a.peak > 0).map((a) => (a.peak / a.price0 - 1) * 100);
    o.peak = { n: peaks.length };
    if (peaks.length) Object.assign(o.peak, { median: r1(median(peaks)), big: share(peaks, (x) => x >= 50) });
    out[kind] = o;
  }
  return out;
}

module.exports = { track, stats, CHECKS, tracked };
