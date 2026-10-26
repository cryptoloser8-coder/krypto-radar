'use strict';
// Pomiar skuteczności: przy każdym alercie zapisujemy cenę, a potem sprawdzamy ją po 2 i 5 minutach, 1, 6, 24, 72 godzinach
// i po 7 dniach. Przy każdym pomiarze zapisujemy też szczyt (pk) i dołek (lo) w całym oknie od alertu – w %.
// Czyste funkcje – czas podajemy z zewnątrz, żeby dało się to testować.

const H = 3.6e6;
// [nazwa, po jakim czasie, ile spóźnienia tolerujemy]
const CHECKS = [
  ['m2', 2 * 60e3, 3 * 60e3], // realna cena wejścia: ile ucieka, zanim zdążysz kupić
  ['m5', 5 * 60e3, 5 * 60e3],
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

// ---- Złe odczyty ceny ------------------------------------------------------------
// Źródło czasem podaje cenę innej pary (np. RAYCAT 3,41 $ zamiast 0,0007 $ i płynność 958 mln $).
// Skok ceny ponad JUMP× (10×) względem ostatniej przyjętej ceny traktujemy jako podejrzany:
// – przy jednoczesnym skoku płynności w górę ponad JUMP× w ciągu pół godziny to podmiana pary – odczyt odrzucamy zawsze,
// – w innym przypadku czekamy na potwierdzenie: jeśli następny odczyt jest blisko nowego poziomu, przyjmujemy go
//   (tak przechodzą prawdziwe rugi i prawdziwe skoki), a jeśli wraca do starego – odrzucamy jako pojedynczy błąd.
const JUMP = 10;
const NEAR = 3; // „blisko” = w granicach 3× od porównywanej ceny
function acceptPrice(a, p, liq, now) {
  const lp = a.lp > 0 ? a.lp : a.price0;
  const ll = a.ll > 0 ? a.ll : a.liq0 > 0 ? a.liq0 : null;
  const r = p / lp;
  const ok = () => {
    a.lp = p;
    a.lpt = now;
    if (liq > 0) a.ll = liq;
    delete a.pend;
    return true;
  };
  if (r <= JUMP && r >= 1 / JUMP) return ok();
  a.glitches = (a.glitches || 0) + 1;
  // Podmiana pary (cena i płynność naraz w górę ponad 10× w ciągu pół godziny) – takiego odczytu nie przyjmujemy.
  // Po dłuższej przerwie (pomiary 72 h, 7 dni) token mógł naprawdę urosnąć – wtedy wystarcza potwierdzenie.
  const recent = !(a.lpt > 0) || now - a.lpt < 30 * 60e3;
  if (recent && r > JUMP && ll && liq > 0 && liq / ll > JUMP) return false;
  if (a.pend && p / a.pend <= NEAR && p / a.pend >= 1 / NEAR) return ok(); // drugi odczyt z rzędu potwierdza nowy poziom
  a.pend = p;
  return false;
}

// ---- Dokładne TP/SL: pierwsze przekroczenie progów ------------------------------
// Wejście: pierwsza przyjęta cena co najmniej FP_ENTRY_MS po alercie (tak jak w analizie taśmy – „wejście po 5 min”).
// Potem przy każdym skanie przez FP_MS sprawdzamy, kiedy cena pierwszy raz przekroczyła +50/+100/+200% i −30/−40/−50%.
// hi[50] = [minuty od wejścia, wynik % w tym skanie]; przy stopie zapisujemy faktyczny wynik (bywa gorszy niż próg).
const FP_ENTRY_MS = 5 * 60e3;
const FP_ENTRY_TOL = 10 * 60e3; // bez ceny w ciągu 10 min od terminu wejścia – brak pomiaru TP/SL
const FP_MS = 6 * H;
const FP_UP = [50, 100, 200];
const FP_DN = [30, 40, 50];
// Strategie liczone w statystykach: [nazwa, TP %, SL %].
const STRATS = [['tp100', 100, 40], ['tp200', 200, 50], ['tp50', 50, 30]];
function trackFp(a, p, now) {
  if (a.fp && a.fp.done) return;
  const since = now - a.at;
  if (!a.fp) {
    if (since < FP_ENTRY_MS) return;
    if (since > FP_ENTRY_MS + FP_ENTRY_TOL) {
      a.fp = { none: true, done: true };
      return;
    }
    if (!p) return;
    a.fp = { e: p, et: Math.round(since / 60000), hi: {}, lo: {}, last: 0 };
    return;
  }
  const f = a.fp;
  const minE = (now - a.at) / 60000 - f.et; // minuty od wejścia
  if (p) {
    const r = r1((p / f.e - 1) * 100);
    for (const th of FP_UP) if (!f.hi[th] && r >= th) f.hi[th] = [Math.round(minE), r];
    for (const th of FP_DN) if (!f.lo[th] && r <= -th) f.lo[th] = [Math.round(minE), r];
    f.last = r;
  }
  if (minE * 60000 >= FP_MS) {
    f.end = f.last; // wynik po 6 h (ostatnia przyjęta cena, jeśli token zniknął z list)
    f.done = true;
  }
}
// Wynik strategii TP/SL z pomiaru (w %, bez kosztów). null – brak pomiaru albo jeszcze trwa i nic nie trafiło.
function fpResult(f, tp, sl) {
  if (!f || f.none || !(f.e > 0)) return null;
  const h = f.hi && f.hi[tp], l = f.lo && f.lo[sl];
  if (h && (!l || h[0] < l[0])) return tp;
  if (l) return l[1];
  return f.done ? f.end : null;
}

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
    let p = rec && rec.priceUsd > 0 ? rec.priceUsd : null;
    let skipped = false;
    if (p && !acceptPrice(a, p, rec.liquidityUsd, now)) {
      p = null; // zły odczyt: w tym skanie traktujemy cenę jak nieznaną (bez liczenia „zniknięcia”)
      skipped = true;
    }
    if (now - a.at <= FP_ENTRY_MS + FP_ENTRY_TOL + FP_MS + 30 * 60e3) trackFp(a, p, now);
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
          if (a.glitches) c.glitches = a.glitches; // ile podejrzanych odczytów pominięto do tej pory
          // Płynność spadła poniżej 1/5 tej z chwili alertu: pula została w praktyce wycofana.
          if (a.liq0 > 0 && rec.liquidityUsd != null && rec.liquidityUsd < 0.2 * a.liq0) c.rug = true;
          Object.assign(c, extremes(a, name, p));
          a.checks[name] = c;
        } else {
          // DexScreener odpowiedział, ale tokena już nie zna – liczymy takie skany.
          if (asked.has(a.key) && !skipped) {
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
    // Pomiar TP/SL trwa 6 h – alert nie kończy się, dopóki on trwa (zwykle i tak trwają dłuższe okna).
    if (a.fp && !a.fp.done) open++;
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

module.exports = { track, wantsPrice, wantsExtremes, extremesFromCandles, acceptPrice, trackFp, fpResult, CHECKS, LONG, tracked, FP_UP, FP_DN, STRATS, JUMP };
