'use strict';
// Pomiar skuteczności: przy każdym alercie zapisujemy cenę, a potem sprawdzamy ją po 1, 6, 24, 72 godzinach
// i po 7 dniach. Przy każdym pomiarze zapisujemy też szczyt (pk) i dołek (lo) w całym oknie od alertu – w %.
// Czyste funkcje – czas podajemy z zewnątrz, żeby dało się to testować.

const H = 3.6e6;
// [nazwa, po jakim czasie, ile spóźnienia tolerujemy]
const CHECKS = [
  ['h1', H, 20 * 60e3],
  ['h6', 6 * H, H],
  ['h24', 24 * H, 3 * H],
  ['h72', 72 * H, 6 * H],
  ['d7', 168 * H, 12 * H],
];
// Okna liczone ze świec godzinowych (GeckoTerminal), bo cenę śledzimy na bieżąco tylko przez pierwszą dobę.
const LONG = new Set(['h72', 'd7']);
const LIVE_MS = 24 * H + 60e3; // przez tyle czasu cena jest sprawdzana co skan (szczyt, dołek, wykres)
const r1 = (x) => Math.round(x * 10) / 10;
const pctOf = (p, p0) => r1((p / p0 - 1) * 100);
const PATH_STEP = 14 * 60e3; // ~co 15 min (przy skanie co minutę)
const tracked = (a) => a.type === 'token' && a.price0 > 0;

// Czy w tym skanie trzeba pobrać cenę tego tokena: pierwsza doba albo otwarte okno któregoś pomiaru.
function wantsPrice(a, now) {
  if (!tracked(a) || a.done) return false;
  if (now - a.at <= LIVE_MS) return true;
  return CHECKS.some(([name, ms, tol]) => !(a.checks && a.checks[name]) && now >= a.at + ms - 2 * 60e3 && now <= a.at + ms + tol);
}

// Pomiary 72 h / 7 d, które czekają na szczyt i dołek ze świec (a.ext[name] = { hi, lo } w cenach).
function wantsExtremes(a, now) {
  if (!tracked(a) || a.done) return [];
  return CHECKS.filter(([name, ms, tol]) => LONG.has(name) && !(a.checks && a.checks[name]) && now >= a.at + ms && now <= a.at + ms + tol && !(a.ext && a.ext[name])).map(([name, ms]) => ({ name, from: a.at, to: a.at + ms }));
}

// alerts – lista alertów (modyfikowana w miejscu), all – Map(klucz → aktualne dane tokena),
// asked – Set kluczy, o które DexScreener został w tym skanie skutecznie zapytany.
function track(alerts, all, asked, now) {
  for (const a of alerts) {
    if (!tracked(a) || a.done) continue;
    a.checks = a.checks || {};
    const rec = all.get(a.key);
    const p = rec && rec.priceUsd > 0 ? rec.priceUsd : null;
    if (p && now - a.at <= LIVE_MS) {
      // Szczyt i dołek w ciągu 24 h od alertu, z chwilą, w której wystąpiły (startowo: cena i czas alertu).
      if (!(a.peak >= p)) { a.peak = p; a.peakAt = now; }
      if (!(a.low <= p)) { a.low = p; a.lowAt = now; }
      // Przebieg ceny do wykresu: punkt co ~15 minut, [minuty od alertu, cena].
      a.path = a.path || [[0, a.price0]];
      const last = a.path[a.path.length - 1];
      if (now - a.at - last[0] * 60000 >= PATH_STEP) a.path.push([Math.round((now - a.at) / 60000), Number(p.toPrecision(6))]);
    }
    let open = 0;
    for (const [name, ms, tol] of CHECKS) {
      if (a.checks[name]) continue;
      const due = a.at + ms;
      if (now < due) {
        open++;
      } else if (now <= due + tol) {
        if (p) {
          const c = { chg: pctOf(p, a.price0), t: now, p, liq: rec.liquidityUsd == null ? null : rec.liquidityUsd };
          // Płynność spadła poniżej 1/5 tej z chwili alertu: pula została w praktyce wycofana.
          if (a.liq0 > 0 && rec.liquidityUsd != null && rec.liquidityUsd < 0.2 * a.liq0) c.rug = true;
          Object.assign(c, extremes(a, name, p));
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
        a.checks[name] = a.miss && a.miss[name] >= 3 ? Object.assign({ dead: true, chg: -100, t: now }, extremes(a, name, null), { lo: -100 }) : { missed: true };
      }
    }
    if (!open) {
      a.done = true;
      delete a.miss;
      delete a.ext;
    }
  }
}

// Szczyt i dołek w oknie od alertu do pomiaru (w % od ceny alertu).
function extremes(a, name, p) {
  let hi = Math.max(a.peak || a.price0, p || 0);
  let lo = Math.min(a.low || a.price0, p || Infinity);
  const out = {};
  if (LONG.has(name)) {
    const e = a.ext && a.ext[name];
    if (e && e.hi > 0) {
      hi = Math.max(hi, e.hi);
      lo = Math.min(lo, e.lo);
    } else out.approx = true; // bez świec: szczyt tylko z pierwszej doby i z chwili pomiaru
  }
  out.pk = pctOf(hi, a.price0);
  out.lo = pctOf(lo, a.price0);
  return out;
}

// Szczyt i dołek ze świec godzinowych [czas_s, open, high, low, close, ...] w przedziale (from, to].
function extremesFromCandles(list, from, to) {
  let hi = 0, lo = Infinity;
  for (const k of list || []) {
    const t = k[0] * 1000;
    if (t + H <= from || t > to) continue; // świeca musi zachodzić na okno
    if (k[2] > hi) hi = k[2];
    if (k[3] > 0 && k[3] < lo) lo = k[3];
  }
  return hi > 0 ? { hi, lo } : null;
}

module.exports = { track, wantsPrice, wantsExtremes, extremesFromCandles, CHECKS, LONG, tracked };
