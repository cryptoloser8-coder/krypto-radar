'use strict';
const $ = (id) => document.getElementById(id);
// Musi się zgadzać z APP_VERSION w server.js – inaczej strona prosi o odświeżenie albo aktualizację Orange Pi.
const APP_VERSION = 11;
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const link = (u, text) => (safeUrl(u) ? el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text }) : null);

const nf = (o) => new Intl.NumberFormat('pl-PL', o);
const usd = (x) => {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e9) return '$' + nf({ maximumFractionDigits: 2 }).format(x / 1e9) + ' mld';
  if (a >= 1e6) return '$' + nf({ maximumFractionDigits: 2 }).format(x / 1e6) + ' mln';
  if (a >= 1e3) return '$' + nf({ maximumFractionDigits: a >= 1e5 ? 0 : 1 }).format(x / 1e3) + ' tys.';
  return '$' + nf({ maximumFractionDigits: 0 }).format(x);
};
const price = (x) => (x == null || !isFinite(x) ? '–' : '$' + (x >= 1 ? nf({ maximumFractionDigits: 2 }).format(x) : nf({ maximumSignificantDigits: 3 }).format(x)));
const pct = (x) => {
  if (x == null || !isFinite(x)) return el('span', { class: 'mute', text: '–' });
  const t = (x > 0 ? '+' : '') + nf({ maximumFractionDigits: Math.abs(x) >= 100 ? 0 : 1 }).format(x) + '%';
  return el('span', { class: x > 0 ? 'up' : x < 0 ? 'down' : 'mute', text: t });
};
const ageTxt = (h) => (h == null ? '–' : h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' dni');
const clock = (t) => new Date(t).toLocaleTimeString('pl-PL');
const RISK = { none: 'brak flag', med: 'podwyższone', high: 'wysokie', crit: 'krytyczne' };
const SRC = {
  'gt-trending': 'trendy GeckoTerminal', 'cg-trending': 'trendy CoinGecko', 'ds-boost-top': 'top boosty DexScreener',
  'ds-boost-new': 'nowy boost DexScreener', 'ds-profile': 'nowy profil DexScreener', 'ds-cto': 'przejęcie społeczności',
  'pump-live': 'pump.fun na żywo', 'pump-replies': 'komentowane na pump.fun', 'pump-active': 'aktywne na pump.fun',
  'gt-trending-5m': 'trendy 5-minutowe GeckoTerminal', 'pump-migrated': 'świeżo po migracji z pump.fun',
};
const PARTS = [['vol', 'Przyspieszenie wolumenu', 28], ['act', 'Aktywność', 20], ['buy', 'Przewaga kupujących', 15], ['price', 'Trend ceny', 20], ['attn', 'Uwaga', 17]];

// [klucz, nazwa, maksimum, kolor]
const EPARTS = [['demand', 'Rosnący popyt', 30, 'vol'], ['buyers', 'Kupujący', 20, 'buy'], ['room', 'Zapas ceny', 20, 'price'], ['value', 'Wycena', 15, 'act'], ['fresh', 'Świeżość', 15, 'attn']];
// Solana osobno: własna zakładka (z podwidokami), a w pozostałych zakładkach jej nie ma.
const solApart = () => !!(S && S.config && (!S.config.solana || S.config.solana.separate !== false));
const isSol = () => ui.tab === 'sol';
const inScope = (chain) => (!solApart() ? true : isSol() ? chain === 'solana' : chain !== 'solana');
const isEarly = () => ui.tab === 'early' || (isSol() && ui.solView === 'early');

const ui = { tab: 'early', solView: 'early', q: '', chain: '', minLiq: 0, hideCrit: true, sort: 'score', meta: '', open: new Set(), openAlerts: new Set(), upMin: null, downMin: null, settingsBuilt: false };
let S = null;

// ---- Skąd dane -------------------------------------------------------------
// Na GitHub Pages (albo z parametrem ?data=adres) strona tylko czyta plik data.json wysyłany przez Orange Pi.
// Otwarta bezpośrednio z Orange Pi rozmawia z aplikacją na żywo i pozwala zmieniać ustawienia.
const params = new URLSearchParams(location.search);
const REMOTE = (() => {
  if (params.get('data')) return { url: params.get('data') };
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const owner = params.get('owner') || m[1];
  const repo = params.get('repo') || location.pathname.split('/').filter(Boolean)[0] || `${m[1]}.github.io`;
  return { owner, repo, branch: params.get('branch') || 'data' };
})();
let lastSha = null;
// Najpierw pytamy API GitHuba o najnowszy commit gałęzi z danymi i pobieramy plik z tego commita
// (bez opóźnienia pamięci podręcznej). Gdy API odmówi (limit 60 zapytań na godzinę), bierzemy plik
// z gałęzi – może być wtedy do 5 minut starszy.
async function fetchRemote() {
  const R = REMOTE;
  if (R.url) return (await fetch(R.url, { cache: 'no-store' })).json();
  const raw = (ref) => `https://raw.githubusercontent.com/${R.owner}/${R.repo}/${ref}/data.json`;
  try {
    const r = await fetch(`https://api.github.com/repos/${R.owner}/${R.repo}/git/ref/heads/${R.branch}`, { cache: 'no-store' });
    if (r.ok) {
      const sha = (await r.json()).object.sha;
      if (sha === lastSha && S) return S;
      const d = await (await fetch(raw(sha))).json();
      lastSha = sha;
      return d;
    }
    if (r.status === 404) throw new Error(`Brak danych w repozytorium ${R.owner}/${R.repo} (gałąź „${R.branch}”). Czy Orange Pi już coś wysłał?`);
  } catch (e) {
    if (/Brak danych/.test(e.message)) throw e;
  }
  return (await fetch(raw(R.branch) + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })).json();
}

// Sesja wygasła albo hasło zostało zmienione – wracamy do strony logowania.
const toLogin = (r) => { if (r.status === 401) { location.href = '/login'; throw new Error('Zaloguj się ponownie'); } return r; };
async function post(path, body) {
  const r = toLogin(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Błąd ' + r.status);
  return d;
}
let lastLoad = 0;
async function load() {
  // Na GitHubie nie częściej niż co 30 s (limit API), lokalnie bez ograniczeń.
  if (REMOTE && S && Date.now() - lastLoad < 30000) return;
  lastLoad = Date.now();
  try {
    if (REMOTE) S = await fetchRemote();
    else S = await toLogin(await fetch('/api/state', { cache: 'no-store' })).json();
    $('logout').hidden = !!REMOTE || !(S.config && S.config.auth && S.config.auth.enabled);
    $('scanNow').hidden = !!REMOTE;
    if (document.activeElement && document.activeElement.tagName === 'SELECT') renderTop();
    else render();
    if (ui.tab === 'alerts' || (isSol() && ui.solView === 'alerts')) loadAlerts();
  } catch (e) {
    $('when').textContent = REMOTE
      ? (/Brak danych/.test(e.message) ? e.message : 'Nie udało się pobrać danych z GitHuba – spróbuję ponownie za chwilę.')
      : 'Brak połączenia z aplikacją na Orange Pi. Sprawdź, czy usługa działa: systemctl status krypto-radar';
    if (!S) put($('view'), el('div', { class: 'empty', text: $('when').textContent }));
  }
}

function render() {
  if (!S.config || !S.config.early) {
    // Strona jest nowsza niż działający program (pliki zostały zaktualizowane w trakcie pracy).
    $('when').textContent = '';
    return put($('view'), el('div', { class: 'empty', text: 'Strona jest nowsza niż aplikacja na Orange Pi. Zaktualizuj ją: sudo bash deploy/install.sh' }));
  }
  renderTop();
  renderTopics();
  const apart = solApart();
  const main = S.tokens.filter((t) => !apart || t.chain !== 'solana');
  if (!apart && isSol()) ui.tab = 'early';
  $('tabSol').hidden = !apart;
  // pump.fun to Solana – przy osobnej Solanie jest jej podwidokiem.
  document.querySelector('.tab[data-tab="pump"]').hidden = apart;
  if (apart && ui.tab === 'pump') { ui.tab = 'sol'; ui.solView = 'pump'; }
  $('ctEarly').textContent = main.filter((t) => t.e && t.e.inScope).length || '';
  $('ctTokens').textContent = main.length || '';
  $('ctPump').textContent = S.tokens.filter((t) => t.isPump).length || '';
  $('ctSol').textContent = (S.alertsCount && S.alertsCount.sol) || '';
  $('ctNft').textContent = S.nfts.length || '';
  $('ctAlerts').textContent = (S.alertsCount && S.alertsCount.day) || '';
  renderSolBar();
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  if (ui.tab === 'settings') return renderSettings();
  ui.settingsBuilt = false;
  if (ui.tab === 'nft') return renderNfts();
  if (ui.tab === 'alerts' || (isSol() && ui.solView === 'alerts')) return renderAlerts();
  renderTokens();
}

// Podwidoki zakładki Solana.
function renderSolBar() {
  const bar = $('solbar');
  bar.hidden = !isSol();
  if (!isSol()) return bar.replaceChildren();
  const sol = S.tokens.filter((t) => t.chain === 'solana');
  const muted = !(S.config.solana && S.config.solana.telegram);
  const chip = (v, label) => el('button', { class: 'topic', 'aria-pressed': String(ui.solView === v), style: 'padding:4px 12px', onclick: () => { ui.solView = v; render(); if (v === 'alerts') loadAlerts(); } }, el('div', { class: 'nm', text: label }));
  bar.replaceChildren(
    chip('early', `Wczesne sygnały (${sol.filter((t) => t.e && t.e.inScope).length})`),
    chip('tokens', `Gorące teraz (${sol.length})`),
    chip('pump', `pump.fun (${sol.filter((t) => t.isPump).length})`),
    chip('alerts', `Alerty (${(S.alertsCount && S.alertsCount.sol) || 0} w 24 h)`),
    el('span', { class: 'mute', style: 'font-size:13px', text: muted ? 'Powiadomienia Solany na Telegram wyłączone – alerty zapisywane i mierzone w tle (włączysz: /ustaw solana_tg wł.).' : 'Powiadomienia Solany na Telegram włączone.' }));
}

function versionNote() {
  let n = $('verNote');
  if (!n) {
    n = el('div', { id: 'verNote', class: 'panel', style: 'max-width:none;border:1px solid var(--warn)', role: 'status' });
    $('view').before(n);
  }
  const v = S && S.appVersion;
  n.hidden = !v || v === APP_VERSION;
  n.textContent = !v || v === APP_VERSION ? '' : v > APP_VERSION
    ? 'Na Orange Pi działa nowsza wersja niż ta strona. Odśwież stronę z pominięciem pamięci (Ctrl+Shift+R); jeśli to nie pomoże, poczekaj 1–2 minuty, aż GitHub Pages ją przebuduje.'
    : 'Strona jest nowsza niż aplikacja na Orange Pi. Zaktualizuj Orange Pi: cd ~/krypto-radar && git pull && sudo systemctl restart krypto-radar';
}

function renderTop() {
  versionNote();
  if (REMOTE && S.publishedAt) {
    // Dane z GitHuba: ważne jest, jak dawno Orange Pi je wysłał.
    const age = Math.round((Date.now() - S.publishedAt) / 60000);
    const limit = Math.max(10, (3 * ((S.config.publish && S.config.publish.intervalSec) || 120)) / 60);
    $('when').textContent = `Dane z ${clock(S.publishedAt)} (${age < 1 ? 'przed chwilą' : age + ' min temu'})` + (age > limit ? ' – Orange Pi dawno nic nie wysłał, sprawdź, czy działa' : '');
    $('when').style.color = age > limit ? 'var(--crit)' : '';
  } else if (S.scannedAt) {
    const next = Math.max(0, Math.round((S.scannedAt + S.config.scanIntervalSec * 1000 - S.now) / 1000));
    $('when').textContent = S.scanning ? 'Skanuję…' : `Ostatni skan ${clock(S.scannedAt)}, następny za ${next} s`;
  } else $('when').textContent = 'Pierwszy skan w toku…';
  $('scanNow').disabled = !!S.scanning;
  const bad = S.sources.filter((s) => !s.ok);
  $('srcToggle').textContent = S.sources.length ? (bad.length ? `Źródła: ${bad.length} z ${S.sources.length} nie odpowiada` : `Źródła: wszystkie ${S.sources.length} działają`) : '';
  $('srcToggle').style.color = bad.length ? 'var(--crit)' : '';
  const ul = $('srcList');
  ul.replaceChildren(...S.sources.map((s) => el('li', null, el('span', { class: 'dot' + (s.ok ? '' : ' bad') }), s.name, s.ok ? el('span', { class: 'mute', text: ' – ' + s.count }) : el('div', { class: 'err', text: s.error || 'błąd' }))));
}

function renderTopics() {
  const metas = (S.topics.metas || []).slice().sort((a, b) => (b.chg.h6 || 0) - (a.chg.h6 || 0));
  $('metas').replaceChildren(
    ...(metas.length
      ? metas.map((m) => {
          const b = el('button', { class: 'topic', 'aria-pressed': String(ui.meta === m.slug), title: m.description || '', onclick: () => { ui.meta = ui.meta === m.slug ? '' : m.slug; if (!['early', 'tokens', 'pump', 'sol'].includes(ui.tab)) ui.tab = 'early'; if (isSol() && ui.solView === 'alerts') ui.solView = 'early'; render(); } },
            el('div', { class: 'nm', text: (m.icon ? m.icon + ' ' : '') + m.name }),
            el('div', { class: 'sub' }, '6 h ', pct(m.chg.h6), ' | 24 h ', pct(m.chg.h24), ' | obrót ' + usd(m.volume)));
          return b;
        })
      : [el('span', { class: 'mute', text: 'Brak danych o narracjach.' })])
  );
  const coins = S.topics.coins || [];
  $('coins').replaceChildren(
    ...(coins.length ? [el('span', { text: 'Najczęściej wyszukiwane na CoinGecko:' }), ...coins.slice(0, 12).map((c) => el('span', null, link(c.url, c.symbol) || c.symbol, ' ', pct(c.chg24)))] : [])
  );
}

function filteredTokens() {
  let list = S.tokens.filter((t) => inScope(t.chain));
  if (ui.tab === 'pump' || (isSol() && ui.solView === 'pump')) list = list.filter((t) => t.isPump);
  if (isEarly()) list = list.filter((t) => t.e && t.e.inScope);
  if (ui.meta) list = list.filter((t) => (t.metas || []).some((m) => m.slug === ui.meta));
  if (ui.chain) list = list.filter((t) => t.chain === ui.chain);
  if (ui.minLiq) list = list.filter((t) => (t.liquidityUsd || 0) >= ui.minLiq);
  if (ui.hideCrit) list = list.filter((t) => t.s.risk !== 'crit');
  const q = ui.q.trim().toLowerCase();
  if (q) list = list.filter((t) => (t.symbol + ' ' + t.name + ' ' + t.address).toLowerCase().includes(q));
  const by = {
    score: isEarly() ? (a, b) => b.e.score - a.e.score : (a, b) => b.s.score - a.s.score,
    momentum: (a, b) => b.s.momentum - a.s.momentum,
    vol1: (a, b) => b.vol.h1 - a.vol.h1,
    chg1: (a, b) => (b.chg.h1 || -1e9) - (a.chg.h1 || -1e9),
    age: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    chain: (a, b) => String(a.chain).localeCompare(String(b.chain)) || (isEarly() ? b.e.score - a.e.score : b.s.score - a.s.score),
  }[ui.sort];
  return list.sort(by);
}

function earlyCell(e) {
  const bar = el('div', { class: 'bar', title: EPARTS.map(([k, n]) => `${n}: ${e.parts[k]}`).join('\n') }, EPARTS.map(([k, , , c]) => el('span', { class: c, style: `width:${e.parts[k]}%` })));
  const minus = Math.round(e.penalty + e.late);
  return el('div', { class: 'score' },
    el('span', { class: 'val', text: Math.round(e.score) }),
    bar,
    el('span', { class: 'pen', text: minus ? '−' + minus : '', title: minus ? `Odjęte: ${e.penalty} za flagi ryzyka, ${e.late} za wzrost, który już był` : '' }));
}
function scoreCell(s, delta) {
  const bar = el('div', { class: 'bar', title: PARTS.map(([k, n]) => `${n}: ${s.parts[k]}`).join('\n') }, PARTS.map(([k]) => el('span', { class: k, style: `width:${s.parts[k]}%` })));
  return el('div', { class: 'score' },
    el('span', { class: 'val', text: Math.round(s.score) }),
    bar,
    el('span', { class: 'pen', text: s.penalty ? '−' + s.penalty : '', title: s.penalty ? 'Punkty odjęte za flagi ryzyka' : '' }),
    delta ? el('span', { class: 'delta ' + (delta > 0 ? 'up' : 'down'), text: (delta > 0 ? '▲' : '▼') + Math.abs(Math.round(delta)), title: 'Zmiana od poprzedniego skanu' }) : null);
}
function flagChips(flags) {
  const c = flags.filter((f) => f.sev === 'crit').length, w = flags.filter((f) => f.sev === 'warn').length;
  return el('div', { class: 'flags', title: flags.map((f) => f.text).join('\n') },
    c ? el('span', { class: 'flag crit', text: c + ' kryt.' }) : null,
    w ? el('span', { class: 'flag warn', text: w + ' ostrz.' }) : null,
    !c && !w ? el('span', { class: 'mute', style: 'font-size:13px', text: 'brak flag' }) : null);
}
function avatar(src) {
  const u = safeUrl(src);
  if (!u) return el('span', { class: 'ph' });
  const im = el('img', { src: u, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  im.addEventListener('error', () => im.replaceWith(el('span', { class: 'ph' })));
  return im;
}

// Telegram tokena: publiczny (nazwa, członkowie), prywatny, brak – ten sam opis w tokenach i w alertach.
function tgText(g, link) {
  g = g || { s: link ? 'public' : 'none', unchecked: !!link };
  const n0 = (x) => nf({ maximumFractionDigits: 0 }).format(x);
  if (g.s === 'public') {
    const what = g.type === 'channel' ? 'kanał publiczny' : g.type === 'group' ? 'grupa publiczna' : 'publiczny';
    return what + (g.title ? ` „${g.title}”` : g.name ? ` @${g.name}` : '') + (g.n != null ? ` – ${n0(g.n)} członków` : g.unchecked ? ' (jeszcze niesprawdzony)' : '');
  }
  return {
    private: 'prywatny – tylko link z zaproszeniem, liczby członków nie da się sprawdzić',
    none: 'brak – token nie podaje Telegrama',
    notfound: `@${g.name || ''} nie istnieje albo to konto osoby, nie kanał`,
    bot: `tylko bot @${g.name || ''}, bez kanału`,
    folder: 'folder kanałów (addlist)',
    invalid: 'nieprawidłowy link',
  }[g.s] || 'nieznany';
}
const TG_ICON = { public: '📢', private: '🔒', none: '➖', notfound: '❓', bot: '🤖', folder: '📁', invalid: '❓' };

function tokenDetail(t) {
  const s = t.s;
  const srcs = (t.sources || []).map((x) => SRC[x]).filter(Boolean).concat((t.metas || []).map((m) => 'narracja „' + m.name + '”' + (m.hot ? ' (rośnie)' : '')));
  const sec = { checked: 'Kontrakt sprawdzony (RugCheck/GoPlus).', failed: 'Nie udało się sprawdzić kontraktu.', unsupported: 'Dla tej sieci nie ma darmowej kontroli kontraktu.' }[t.security] || 'Kontrakt czeka w kolejce do sprawdzenia.';
  const e = t.e;
  const u = t.uniq && t.uniq.h1;
  const x1 = (v) => nf({ maximumFractionDigits: 1 }).format(v);
  const hot = el('div', null, el('h3', { text: `Wynik „gorące teraz” ${s.score} (momentum ${s.momentum}, kara ${s.penalty})` }),
    el('div', { class: 'parts' }, PARTS.flatMap(([k, n, max]) => [el('span', { text: n }), el('div', { class: 'pb' }, el('span', { style: `width:${(100 * s.parts[k]) / max}%;background:var(--p-${k})` })), el('span', { class: 'pv', text: `${s.parts[k]} / ${max}` })])));
  const early = e ? el('div', null, el('h3', { text: `Wynik wczesny ${e.score} (suma ${e.raw}, flagi −${e.penalty}, po ruchu −${e.late})` }),
    el('div', { class: 'parts' }, EPARTS.flatMap(([k, n, max, c]) => [el('span', { text: n }), el('div', { class: 'pb' }, el('span', { style: `width:${(100 * e.parts[k]) / max}%;background:var(--p-${c})` })), el('span', { class: 'pv', text: `${e.parts[k]} / ${max}` })])),
    el('p', { class: 'mute', style: 'margin:6px 0 0;font-size:13px', text:
      (e.volX != null ? `Wolumen 1 h to ${x1(e.volX)}× własnej średniej` : 'Brak historii wolumenu') +
      (e.txX != null ? `, transakcje ${x1(e.txX)}×` : '') +
      (u ? `. Portfele w 1 h: ${u.buyers} kupujących, ${u.sellers} sprzedających.` : '. Brak danych o unikalnych portfelach.') +
      (e.inScope ? '' : ` Poza zakresem wczesnych sygnałów: ${e.why}.`) })) : null;
  return el('div', { class: 'dgrid' },
    isEarly() ? early : hot,
    isEarly() ? hot : early,
    el('div', null, el('h3', { text: 'Flagi ryzyka: ' + RISK[s.risk] }),
      el('ul', null, s.flags.length ? s.flags.map((f) => el('li', { class: f.sev, text: f.text })) : el('li', { class: 'info', text: 'Żadna reguła nie zadziałała.' })),
      el('p', { class: 'mute', style: 'margin:6px 0 0;font-size:13px', text: sec })),
    el('div', null, el('h3', { text: 'Gdzie jest teraz widoczny' }),
      el('ul', null, srcs.length ? srcs.map((x) => el('li', { text: x })) : el('li', { class: 'info', text: 'Tylko w danych rynkowych.' })),
      el('p', { style: 'margin:6px 0 0;font-size:13px', text: `${TG_ICON[(t.tg || {}).s] || ''} Telegram: ${tgText(t.tg, t.socials && t.socials.telegram)}` }),
      t.pump ? el('p', { class: 'mute', style: 'margin:6px 0 0;font-size:13px', text: `pump.fun: ${t.pump.replyCount} komentarzy` + (t.pump.live ? `, transmisja na żywo (${t.pump.participants} widzów)` : '') + (t.pump.complete ? ', po migracji z krzywej' : ', jeszcze na krzywej') }) : null),
    el('div', null, el('h3', { text: 'Linki' }),
      el('div', { class: 'links' }, link(t.url, t.dataFrom === 'geckoterminal' ? 'Wykres (GeckoTerminal)' : 'Wykres (DexScreener)'), link(t.pumpUrl, 'pump.fun'), link(t.socials && t.socials.twitter, 'X'), link(t.socials && t.socials.telegram, 'Telegram'), link(t.socials && t.socials.website, 'Strona')),
      el('div', { class: 'addr', style: 'margin-top:8px', text: t.address }),
      el('button', { class: 'linkbtn', style: 'font-size:13px', text: 'Kopiuj adres', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(t.address).then(() => { e.target.textContent = 'Skopiowano'; }); } })));
}

function renderTokens() {
  const view = $('view');
  const early = isEarly();
  const chains = [...new Set(S.tokens.filter((t) => inScope(t.chain)).map((t) => t.chain))].sort();
  if (ui.chain && !chains.includes(ui.chain)) ui.chain = '';
  const list = filteredTokens();
  const sel = (id, opts, val, on) => el('select', { id, onchange: (e) => { on(e.target.value); render(); } }, opts.map(([v, t]) => el('option', { value: v, selected: String(v) === String(val), text: t })));
  const focusQ = document.activeElement && document.activeElement.id === 'q';
  const caret = focusQ ? document.activeElement.selectionStart : null;
  const filters = el('div', { class: 'filters' },
    el('input', { type: 'search', id: 'q', placeholder: 'Szukaj: symbol, nazwa, adres', value: ui.q, 'aria-label': 'Szukaj tokena', oninput: (e) => { ui.q = e.target.value; render(); } }),
    sel('fChain', [['', 'Wszystkie sieci'], ...chains.map((c) => [c, c])], ui.chain, (v) => (ui.chain = v)),
    sel('fLiq', [[0, 'Dowolna płynność'], [10000, 'Płynność od $10 tys.'], [50000, 'od $50 tys.'], [250000, 'od $250 tys.'], [1000000, 'od $1 mln']], ui.minLiq, (v) => (ui.minLiq = +v)),
    sel('fSort', [['score', 'Sortuj: wynik'], ...(early ? [] : [['momentum', 'momentum (bez kar)']]), ['vol1', 'wolumen 1 h'], ['chg1', 'zmiana 1 h'], ['age', 'najmłodsze'], ['chain', 'sieć, potem wynik']], ui.sort, (v) => (ui.sort = v)),
    el('label', null, el('input', { type: 'checkbox', checked: ui.hideCrit, onchange: (e) => { ui.hideCrit = e.target.checked; render(); } }), 'Ukryj krytyczne ryzyko'),
    ui.meta ? el('button', { class: 'linkbtn', text: 'Wyczyść filtr narracji', onclick: () => { ui.meta = ''; render(); } }) : null);
  const legend = el('div', { class: 'legend' }, el('span', { text: 'Pasek wyniku:' }),
    early ? EPARTS.map(([, n, , c]) => el('span', null, el('i', { style: `background:var(--p-${c})` }), n)) : PARTS.map(([k, n]) => el('span', null, el('i', { style: `background:var(--p-${k})` }), n)));
  const E = S.config.early;
  const intro = early ? el('p', { class: 'mute', style: 'margin:0 0 10px;max-width:86ch', text:
    `Tokeny, w których popyt rośnie, a cena jeszcze nie uciekła. Tylko po migracji z krzywej, z płynnością od ${usd(E.minLiquidityUsd)}, wyceną do ${usd(E.maxMarketCapUsd)} i co najmniej ${E.minAgeMin} minutami historii. Alert wychodzi od wyniku ${E.minScore}.` }) : null;

  const head = el('tr', null, ['#', 'Token', early ? 'Wynik wczesny' : 'Wynik', 'Cena', '1 h', '6 h', '24 h', 'Wol. 1 h', early ? 'Wol. vs średnia' : 'Wol. 24 h', 'Płynność', 'Wycena', 'Wiek', 'Kupujący 1 h', 'Ryzyko'].map((h, i) => el('th', { class: i === 1 || i === 2 || i === 13 ? 'l' : '', text: h })));
  const rows = [];
  list.slice(0, 150).forEach((t, i) => {
    const s = t.s;
    const tr = el('tr', { class: 'row r-' + s.risk, tabindex: '0', 'aria-expanded': String(ui.open.has(t.key)) },
      el('td', { text: i + 1 }),
      el('td', { class: 'l' }, el('div', { class: 'tok' }, avatar(t.image), el('div', null,
        el('div', null, el('span', { class: 'sym', text: t.symbol }), el('span', { class: 'chain', text: t.chain }), t.tg && t.tg.s !== 'none' ? el('span', { style: 'margin-left:6px;font-size:12px', title: 'Telegram: ' + tgText(t.tg), text: TG_ICON[t.tg.s] + (t.tg.n != null ? ' ' + (t.tg.n >= 1000 ? nf({ maximumFractionDigits: 1 }).format(t.tg.n / 1000) + ' tys.' : t.tg.n) : '') }) : null, t.isNew ? el('span', { class: 'badge-new', text: 'nowy na liście' }) : null),
        el('div', { class: 'nm', text: t.name })))),
      el('td', { class: 'l' }, early ? earlyCell(t.e) : scoreCell(s, t.delta)),
      el('td', { text: price(t.priceUsd) }),
      el('td', null, pct(t.chg.h1)), el('td', null, pct(t.chg.h6)), el('td', null, pct(t.chg.h24)),
      el('td', { text: usd(t.vol.h1) }),
      el('td', { text: early ? (t.e.volX == null ? '–' : nf({ maximumFractionDigits: 1 }).format(t.e.volX) + '×') : usd(t.vol.h24) }),
      el('td', { text: t.liquidityUsd == null ? (t.bondingCurve ? 'krzywa' : '–') : usd(t.liquidityUsd) }),
      el('td', { text: usd(t.marketCap || t.fdv) }),
      el('td', { text: ageTxt(s.parts.ageH) }),
      el('td', { text: s.parts.buyRatio == null ? '–' : Math.round(s.parts.buyRatio * 100) + '% z ' + nf({}).format(s.parts.tx1) }),
      el('td', { class: 'l' }, flagChips(s.flags)));
    const toggle = () => { ui.open.has(t.key) ? ui.open.delete(t.key) : ui.open.add(t.key); render(); };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    rows.push(tr);
    if (ui.open.has(t.key)) rows.push(el('tr', { class: 'detail' }, el('td', { colspan: '14' }, tokenDetail(t))));
  });
  let body;
  if (!S.tokens.length) body = el('div', { class: 'empty', text: S.scannedAt ? 'Żadne źródło nie zwróciło tokenów. Rozwiń „Źródła” u góry, żeby zobaczyć błędy.' : 'Trwa pierwszy skan – zwykle kilkanaście sekund.' });
  else if (!list.length) body = el('div', { class: 'empty', text: early && !ui.q && !ui.chain && !ui.minLiq && !ui.meta && !ui.hideCrit ? 'Teraz żaden token nie mieści się w zakresie wczesnych sygnałów. Lista zapełnia się w miarę kolejnych skanów.' : 'Żaden token nie spełnia filtrów. Poluzuj płynność albo odznacz „Ukryj krytyczne ryzyko”.' });
  else body = el('table', null, el('thead', null, head), el('tbody', null, rows));
  const y = window.scrollY;
  put(view, intro, filters, legend, el('div', { class: 'tablewrap' }, body), list.length > 150 ? el('p', { class: 'mute', text: `Pokazuję 150 z ${list.length}.` }) : null);
  window.scrollTo(0, y);
  if (focusQ) { const q = $('q'); q.focus(); q.setSelectionRange(caret, caret); }
}

function renderNfts() {
  const view = $('view');
  const nfig = (x, sym) => (x == null ? '–' : nf({ maximumSignificantDigits: 3 }).format(x) + (sym ? ' ' + sym : ''));
  const head = el('tr', null, ['#', 'Kolekcja', 'Wynik', 'Floor', 'Zmiana floor', 'Sprzedaże 24 h', 'Wolumen 24 h', 'Wolumen 7 dni', 'Doba vs średnia 7 dni', 'Posiadacze', 'Pozycja 1 h / 24 h', 'Ryzyko'].map((h, i) => el('th', { class: i === 1 || i === 2 || i === 11 ? 'l' : '', text: h })));
  const nchains = [...new Set(S.nfts.map((c) => c.chain).filter(Boolean))].sort();
  if (ui.nftChain && !nchains.includes(ui.nftChain)) ui.nftChain = '';
  const nfts = S.nfts.filter((c) => !ui.nftChain || c.chain === ui.nftChain);
  const nftFilter = nchains.length > 1 ? el('div', { class: 'filters' }, el('select', { 'aria-label': 'Sieć', onchange: (e) => { ui.nftChain = e.target.value; render(); } },
    [['', 'Wszystkie sieci'], ...nchains.map((c) => [c, c])].map(([v, t]) => el('option', { value: v, selected: (ui.nftChain || '') === v, text: t })))) : null;
  const rows = nfts.map((c, i) => {
    const s = c.s;
    const bar = el('div', { class: 'bar', title: `Przyspieszenie: ${s.parts.accel}\nSprzedaże: ${s.parts.sales}\nPozycja w trendach: ${s.parts.rank}\nFloor: ${s.parts.floor}` },
      el('span', { class: 'vol', style: `width:${s.parts.accel}%` }), el('span', { class: 'act', style: `width:${s.parts.sales}%` }), el('span', { class: 'attn', style: `width:${s.parts.rank}%` }), el('span', { class: 'price', style: `width:${s.parts.floor}%` }));
    return el('tr', { class: 'row r-' + s.risk, style: 'cursor:default' },
      el('td', { text: i + 1 }),
      el('td', { class: 'l' }, el('div', { class: 'tok' }, avatar(c.image), el('div', null,
        el('div', null, link(c.url, c.name) || el('span', { class: 'sym', text: c.name }), c.chain ? el('span', { class: 'chain', text: c.chain }) : null),
        el('div', { class: 'nm', text: (c.category || '').toLowerCase().replace(/_/g, ' ') })))),
      el('td', { class: 'l' }, el('div', { class: 'score' }, el('span', { class: 'val', text: Math.round(s.score) }), bar, el('span', { class: 'pen', text: s.penalty ? '−' + s.penalty : '' }))),
      el('td', { text: nfig(c.floor, c.symbol) }),
      el('td', { title: c.floorSinceH ? `od ${c.floorSinceH} h` : 'Liczone od uruchomienia aplikacji – potrzeba min. godziny danych' }, pct(c.floorChangePct)),
      el('td', { text: nf({}).format(c.sales1d) }),
      el('td', { text: nfig(c.vol1d, c.symbol) }),
      el('td', { text: nfig(c.vol7d, c.symbol) }),
      el('td', { text: s.dayShare == null ? '–' : nf({ maximumFractionDigits: 1 }).format(s.dayShare) + '×' }),
      el('td', { text: c.owners == null ? '–' : nf({}).format(c.owners) }),
      el('td', { text: (c.rank1h || '–') + ' / ' + (c.rank1d || '–') }),
      el('td', { class: 'l' }, flagChips(s.flags)));
  });
  const legend = el('div', { class: 'legend' }, el('span', { text: 'Pasek wyniku:' }),
    [['vol', 'Doba względem tygodnia'], ['act', 'Liczba sprzedaży'], ['attn', 'Pozycja w trendach OpenSea'], ['price', 'Wzrost floor']].map(([k, n]) => el('span', null, el('i', { style: `background:var(--p-${k})` }), n)));
  const cg = S.topics.cgNfts || [];
  put(view,
    nftFilter,
    legend,
    el('div', { class: 'tablewrap' }, S.nfts.length ? el('table', null, el('thead', null, head), el('tbody', null, rows)) : el('div', { class: 'empty', text: S.nftScannedAt ? 'OpenSea nie zwróciło kolekcji. Rozwiń „Źródła” u góry, żeby zobaczyć błąd.' : 'Pierwszy skan NFT jeszcze trwa.' })),
    cg.length ? el('p', { class: 'mute', style: 'margin-top:14px' }, 'Najczęściej wyszukiwane NFT na CoinGecko: ', cg.map((x, i) => el('span', null, i ? ', ' : '', x.name + ' (floor ' + (x.floor || '–') + ', ', pct(x.floorChg24), ')'))) : null);
}

// ---- Zakładka Alerty ------------------------------------------------------------

const WINS = [['h1', '1 h'], ['h24', '24 h'], ['h72', '72 h'], ['d7', '7 dni']];
const WIN_MS = { h1: 3.6e6, h24: 864e5, h72: 3 * 864e5, d7: 7 * 864e5 };

// Wspólny format wiersza z indeksu (30 dni) i z listy 24 h (bieżące szczyty).
function alertRows() {
  const byId = new Map();
  for (const r of (ALERTS && ALERTS.index && ALERTS.index.rows) || []) {
    byId.set(r.id, { id: r.id, at: r.at, type: r.t === 'n' ? 'nft' : 'token', kind: r.t === 'e' ? 'early' : 'momentum', symbol: r.s, chain: r.c, score: r.sc, risk: r.r, price0: r.p0, sent: !!r.se, muted: !!r.mu, x: r.x || {} });
  }
  for (const a of (ALERTS && ALERTS.live && ALERTS.live.alerts) || []) {
    const x = {};
    for (const [w] of WINS) {
      const c = a.checks && a.checks[w];
      if (c) x[w] = c.missed ? ['m'] : [c.chg, c.pk ?? null, c.lo ?? null, c.dead ? 'd' : c.rug ? 'r' : c.approx ? 'a' : ''];
    }
    byId.set(a.id || a.at + a.symbol, Object.assign({}, byId.get(a.id) || {}, { id: a.id, at: a.at, type: a.type, kind: a.kind || 'momentum', symbol: a.symbol, chain: a.chain, score: a.score, risk: a.risk, price0: a.price0, sent: a.sent, muted: !!a.muted, error: a.error, x, live: a }));
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

const pctTxt = (v) => (v > 0 ? '+' : '') + nf({ maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 }).format(v) + '%';
// Komórka wyniku okna: zmiana ceny (albo szczyt / dołek w trybie „szczyt i dołek”).
function winCell(r, w, mode) {
  const v = r.x && r.x[w];
  if (r.type === 'nft') return el('span', { class: 'mute', text: '–' });
  if (!v) return el('span', { class: 'mute', text: Date.now() - r.at < WIN_MS[w] ? 'czekam' : '–' });
  if (v[0] === 'm') return el('span', { class: 'mute', text: 'pominięty', title: 'Aplikacja była wtedy wyłączona albo źródło nie odpowiadało' });
  const tip = `zmiana ${pctTxt(v[0])}` + (v[1] != null ? `, szczyt ${pctTxt(v[1])}, dołek ${pctTxt(v[2])}` : '') + (v[3] === 'a' ? ' (szczyt przybliżony)' : '');
  if (v[3] === 'd') return el('span', { class: 'down', text: 'zniknął', title: 'Token zniknął z DexScreenera – liczony jako −100%' });
  if (mode === 'ext' && v[1] != null) return el('span', { title: tip }, pct(v[1]), el('span', { class: 'mute', text: ' / ' }), pct(v[2]));
  const n = pct(v[0]);
  n.title = tip;
  if (v[3] === 'r') n.textContent += ' !';
  return n;
}

function alertTable(rows, mode) {
  const when = (t) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const KIND = { early: 'wczesny', momentum: 'gorący' };
  const body = [];
  for (const r of rows) {
    const key = r.id || r.at + r.symbol;
    const open = ui.openAlerts.has(key);
    const toggle = () => { open ? ui.openAlerts.delete(key) : ui.openAlerts.add(key); if (!open) loadDetail(r.id); render(); };
    const peak24 = r.live && r.live.peak > 0 && r.price0 > 0 && !(r.x.h24 && r.x.h24[1] != null) ? (r.live.peak / r.price0 - 1) * 100 : r.x.h24 && r.x.h24[1];
    body.push(el('tr', { class: 'row r-' + (r.risk || 'none'), tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      el('td', { class: 'l', text: when(r.at) }),
      el('td', { class: 'l', style: 'font-family:var(--ui)' }, el('b', { text: r.symbol }), r.chain ? el('span', { class: 'chain', text: r.chain }) : null),
      el('td', { class: 'l', style: 'font-family:var(--ui)', text: r.type === 'nft' ? 'NFT' : KIND[r.kind] }),
      el('td', { text: r.score == null ? '–' : Math.round(r.score) }),
      el('td', { text: r.type === 'nft' ? '–' : price(r.price0) }),
      WINS.map(([w]) => el('td', null, winCell(r, w, mode))),
      el('td', null, peak24 != null && r.type !== 'nft' ? pct(peak24) : el('span', { class: 'mute', text: '–' })),
      el('td', { class: 'l', style: 'font-family:var(--ui);font-size:13px' }, el('span', { class: r.sent ? 'up' : 'mute', text: r.sent ? 'wysłano' : r.muted ? 'wyciszony' : r.error || 'nie wysłano', title: r.muted ? 'Solana bez powiadomień – alert tylko zapisany i mierzony' : '' }))));
    if (open) body.push(el('tr', { class: 'detail' }, el('td', { colspan: '11' }, detailFor(r))));
  }
  return el('div', { class: 'tablewrap' }, el('table', null,
    el('thead', null, el('tr', null, ['Czas', 'Token', 'Rodzaj', 'Wynik', 'Cena przy alercie', ...WINS.map(([, l]) => (mode === 'ext' ? `Szczyt / dołek ${l}` : `Po ${l}`)), 'Szczyt 24 h', 'Telegram'].map((h, i) => el('th', { class: i < 3 || i === 10 ? 'l' : '', text: h })))),
    el('tbody', null, body)));
}

function renderAlerts() {
  const view = $('view');
  ui.alertKind = ui.alertKind || '';
  ui.ovMode = ui.ovMode || 'chg';
  ui.ovWin = ui.ovWin || 'h24';
  const all = alertRows().filter((r) => (r.type === 'nft' ? !isSol() : inScope(r.chain)));
  if (isSol() && ui.alertKind === 'nft') ui.alertKind = '';
  const mode = ui.ovMode;
  const kindOk = (r) => !ui.alertKind || (ui.alertKind === 'nft' ? r.type === 'nft' : r.type !== 'nft' && r.kind === ui.alertKind);
  const chainCounts = new Map();
  for (const r of all.filter(kindOk)) chainCounts.set(r.chain || '–', (chainCounts.get(r.chain || '–') || 0) + 1);
  if (ui.alertChain && !chainCounts.has(ui.alertChain)) ui.alertChain = '';
  ui.alertSort = ui.alertSort || 'time';
  const sorters = {
    time: (a, b) => b.at - a.at,
    score: (a, b) => (b.score || 0) - (a.score || 0),
    chain: (a, b) => String(a.chain).localeCompare(String(b.chain)) || b.at - a.at,
    h24: (a, b) => ((b.x.h24 && Number.isFinite(b.x.h24[0]) ? b.x.h24[0] : -1e9) - (a.x.h24 && Number.isFinite(a.x.h24[0]) ? a.x.h24[0] : -1e9)),
    peak: (a, b) => ((b.x.h24 && b.x.h24[1] != null ? b.x.h24[1] : b.live && b.live.peak ? (b.live.peak / b.price0 - 1) * 100 : -1e9) - (a.x.h24 && a.x.h24[1] != null ? a.x.h24[1] : a.live && a.live.peak ? (a.live.peak / a.price0 - 1) * 100 : -1e9)),
  };
  const rows = all.filter(kindOk).filter((r) => !ui.alertChain || (r.chain || '–') === ui.alertChain).sort(sorters[ui.alertSort]);
  const tokens = rows.filter((r) => r.type !== 'nft');
  const UP = ui.upMin, DN = ui.downMin; // progi w % (liczby dodatnie) albo null

  // Wartość okna do porównań: zmiana po czasie albo szczyt / dołek w oknie.
  const upVal = (v) => (mode === 'ext' ? v[1] : v[0]);
  const dnVal = (v) => (mode === 'ext' ? v[2] : v[0]);
  const measured = (r, w) => r.x[w] && r.x[w][0] !== 'm' && Number.isFinite(r.x[w][0]) && (mode === 'chg' || r.x[w][1] != null);
  const match = (r, w) => {
    if (!measured(r, w)) return false;
    const v = r.x[w];
    return (UP != null && upVal(v) >= UP) || (DN != null && dnVal(v) <= -DN);
  };

  const share = (k, n) => (n ? ` (${Math.round((100 * k) / n)}%)` : '');
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const cards = WINS.map(([w, label]) => {
    const m = tokens.filter((r) => measured(r, w));
    const waiting = tokens.filter((r) => !r.x[w] && Date.now() - r.at < WIN_MS[w] + 12 * 3.6e6).length;
    const lines = [];
    if (!m.length) lines.push(el('div', { class: 'mute', text: waiting ? `${waiting} w trakcie pomiaru` : 'brak danych' }));
    else if (mode === 'chg') {
      const up = m.filter((r) => r.x[w][0] > 0).length, dn = m.filter((r) => r.x[w][0] < 0).length;
      lines.push(el('div', null, el('span', { class: 'up', text: '▲ ' }), `wzrosło ${up}${share(up, m.length)}`));
      lines.push(el('div', null, el('span', { class: 'down', text: '▼ ' }), `spadło ${dn}${share(dn, m.length)}`));
      lines.push(el('div', { class: 'mute' }, 'mediana ', pct(median(m.map((r) => r.x[w][0])))));
    } else {
      lines.push(el('div', null, 'mediana szczytu ', pct(median(m.map((r) => r.x[w][1])))));
      lines.push(el('div', null, 'mediana dołka ', pct(median(m.map((r) => r.x[w][2])))));
    }
    if (m.length && UP != null) { const k = m.filter((r) => upVal(r.x[w]) >= UP).length; lines.push(el('div', { class: 'up', style: 'font-weight:600', text: `≥ +${UP}%: ${k}${share(k, m.length)}` })); }
    if (m.length && DN != null) { const k = m.filter((r) => dnVal(r.x[w]) <= -DN).length; lines.push(el('div', { class: 'down', style: 'font-weight:600', text: `≤ −${DN}%: ${k}${share(k, m.length)}` })); }
    return el('button', { class: 'ovcard', 'aria-pressed': String(ui.ovWin === w), onclick: () => { ui.ovWin = w; render(); } },
      el('div', { class: 'ovh', text: (mode === 'ext' ? 'W ciągu ' : 'Po ') + label }),
      el('div', { class: 'ovn', text: m.length ? `${m.length} sprawdzonych` + (waiting ? `, ${waiting} w toku` : '') : '' }),
      ...lines);
  });

  const chip = (on, label, click, title) => el('button', { class: 'topic', 'aria-pressed': String(on), title, style: 'padding:4px 12px', onclick: click }, el('div', { class: 'nm', text: label }));
  const thr = (key, sign, presets) => {
    const cur = ui[key];
    const input = el('input', { type: 'number', min: '1', step: '1', placeholder: 'własny', 'aria-label': 'Własny próg w procentach', value: cur != null && !presets.includes(cur) ? cur : '', style: 'width:90px',
      onchange: (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); ui[key] = isFinite(v) && v > 0 ? Math.abs(v) : null; render(); } });
    return [chip(cur == null, 'bez progu', () => { ui[key] = null; render(); }), ...presets.map((p) => chip(cur === p, `${sign}${p}%`, () => { ui[key] = p; render(); })), input, el('span', { class: 'mute', text: '%' })];
  };
  const controls = el('div', { class: 'ovctl' },
    el('div', { class: 'filters' }, el('span', { class: 'ovlbl', text: 'Rodzaj' }), chip(ui.alertKind === '', 'Wszystkie', () => { ui.alertKind = ''; render(); }), chip(ui.alertKind === 'early', 'Wczesne', () => { ui.alertKind = 'early'; render(); }), chip(ui.alertKind === 'momentum', 'Gorące', () => { ui.alertKind = 'momentum'; render(); }), isSol() ? null : chip(ui.alertKind === 'nft', 'NFT', () => { ui.alertKind = 'nft'; render(); })),
    isSol() ? null : el('div', { class: 'filters' }, el('span', { class: 'ovlbl', text: 'Sieć' }),
      chip(!ui.alertChain, 'Wszystkie', () => { ui.alertChain = ''; render(); }),
      [...chainCounts].sort((a, b) => b[1] - a[1]).map(([c, n]) => chip(ui.alertChain === c, `${c} (${n})`, () => { ui.alertChain = c; render(); }))),
    el('div', { class: 'filters' }, el('span', { class: 'ovlbl', text: 'Licz' }),
      chip(mode === 'chg', 'zmianę po czasie', () => { ui.ovMode = 'chg'; render(); }, 'Cena dokładnie po 1 h, 24 h, 72 h, 7 dniach względem ceny z alertu'),
      chip(mode === 'ext', 'szczyt i dołek w tym czasie', () => { ui.ovMode = 'ext'; render(); }, 'Najwyższa i najniższa cena od alertu do końca okna – czy była okazja do zysku i jak głęboko spadło po drodze')),
    el('div', { class: 'filters' }, el('span', { class: 'ovlbl', text: 'Wzrost o min.' }), ...thr('upMin', '+', [25, 50, 100])),
    el('div', { class: 'filters' }, el('span', { class: 'ovlbl', text: 'Spadek o min.' }), ...thr('downMin', '−', [25, 50, 75])));

  const winLabel = WINS.find(([w]) => w === ui.ovWin)[1];
  const cond = [UP != null ? `${mode === 'ext' ? 'szczyt' : 'wzrost'} ≥ +${UP}%` : null, DN != null ? `${mode === 'ext' ? 'dołek' : 'spadek'} ≤ −${DN}%` : null].filter(Boolean).join(' lub ');
  const matched = UP != null || DN != null ? tokens.filter((r) => match(r, ui.ovWin)) : [];
  const matchedBlock = UP == null && DN == null
    ? el('p', { class: 'mute', style: 'margin:4px 0 18px', text: 'Ustaw próg wzrostu albo spadku, żeby zobaczyć listę pasujących alertów. Kliknij kartę, żeby wybrać okno (1 h, 24 h, 72 h, 7 dni).' })
    : el('div', { style: 'margin-bottom:22px' },
        el('h2', { class: 'ovsec', text: `Pasujące alerty – ${mode === 'ext' ? 'w ciągu' : 'po'} ${winLabel}: ${cond} (${matched.length})` }),
        matched.length ? alertTable(matched, mode) : el('p', { class: 'mute', text: 'Żaden alert nie spełnia tego warunku.' }));

  const dayAgo = Date.now() - 864e5;
  const recent = rows.filter((r) => r.at >= dayAgo);
  const older = rows.filter((r) => r.at < dayAgo);
  ui.histShow = ui.histShow || 100;
  const E = S.config.early;
  const tgOn = S.config.telegram.connected;
  const sortSel = el('label', { class: 'mute', style: 'display:inline-flex;gap:6px;align-items:center;font-size:13px' }, 'Sortuj listy:',
    el('select', { onchange: (e) => { ui.alertSort = e.target.value; render(); } }, [['time', 'najnowsze'], ['score', 'wynik'], ['chain', 'sieć'], ['h24', 'zmiana po 24 h'], ['peak', 'szczyt 24 h']].map(([v, t]) => el('option', { value: v, selected: ui.alertSort === v, text: t }))));
  put(view,
    el('h2', { class: 'ovsec', text: 'Skuteczność alertów z ostatnich 30 dni' + (isSol() ? ' – Solana' : solApart() ? ' (bez Solany)' : '') + (ui.alertChain && !isSol() ? ` – ${ui.alertChain}` : '') }),
    controls,
    el('div', { class: 'ovgrid' }, cards),
    el('p', { class: 'mute', style: 'margin:6px 0 14px;font-size:13px;max-width:92ch', text: (mode === 'chg'
      ? 'Wzrosło / spadło: cena dokładnie po tym czasie względem ceny z chwili alertu. '
      : 'Szczyt i dołek: najwyższa i najniższa cena od alertu do końca okna (72 h i 7 dni ze świec godzinowych GeckoTerminal). ') +
      'Token, który zniknął, liczy się jako −100%. Poniżej około 30 sprawdzonych wynik niewiele mówi.' }),
    matchedBlock,
    el('div', { class: 'filters', style: 'justify-content:space-between;margin-bottom:6px' }, el('h2', { class: 'ovsec', style: 'margin:0', text: `Alerty z ostatnich 24 h (${recent.length})` }), sortSel),
    tgOn ? null : el('p', { class: 'mute', style: 'margin:0 0 8px', text: 'Telegram nie jest połączony, więc alerty zapisują się tylko tutaj.' }),
    recent.length ? alertTable(recent, mode) : el('div', { class: 'tablewrap' }, el('div', { class: 'empty', text: `W ciągu ostatniej doby nie było alertu. Wczesny sygnał powstaje od wyniku ${E.minScore}, alert „gorący” od ${S.config.alerts.minScore}.` })),
    el('div', { class: 'rowbtn', style: 'margin:12px 0' },
      el('button', { class: 'btn ghost', 'aria-expanded': String(!!ui.histOpen), disabled: !older.length, onclick: () => { ui.histOpen = !ui.histOpen; render(); } },
        (ui.histOpen ? 'Ukryj historię' : 'Historia') + ` (${older.length} starszych)`),
      el('span', { class: 'mute', style: 'font-size:13px', text: 'Kliknij alert, żeby zobaczyć wykres ceny, powód wysłania i wyniki. Pełna historia z wszystkimi danymi: /eksport w Telegramie.' })),
    ui.histOpen && older.length ? [alertTable(older.slice(0, ui.histShow), mode),
      older.length > ui.histShow ? el('div', { class: 'rowbtn' }, el('button', { class: 'btn ghost', text: `Pokaż kolejne (${older.length - ui.histShow})`, onclick: () => { ui.histShow += 100; render(); } })) : null] : null);
  if (!ALERTS) put(view, el('div', { class: 'empty', text: 'Pobieram alerty…' }));
}

// ---- Szczegóły pojedynczego alertu --------------------------------------------

// Wykres zmiany ceny w % od chwili alertu (0–24 h), z oznaczeniem pomiarów po 1, 6 i 24 h.
function priceChart(a) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const pts = (a.path || []).map(([m, p]) => [m, (p / a.price0 - 1) * 100]);
  for (const [name, c] of Object.entries(a.checks || {})) if (c && c.t && Number.isFinite(c.chg)) pts.push([Math.round((c.t - a.at) / 60000), c.chg]);
  pts.sort((x, y) => x[0] - y[0]);
  if (pts.length < 2) return el('p', { class: 'mute', text: 'Wykres pojawi się po pierwszych 15 minutach od alertu.' });
  const W = 340, Hh = 130, padL = 38, padB = 18, padT = 8;
  const ys = pts.map((p) => p[1]).concat(0);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const X = (m) => padL + (Math.min(m, 1440) / 1440) * (W - padL - 6);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (Hh - padT - padB);
  const root = svg('svg', { viewBox: `0 0 ${W} ${Hh}`, width: '100%', style: 'max-width:420px;display:block', role: 'img', 'aria-label': 'Zmiana ceny od alertu w ciągu 24 godzin' });
  const txt = (x, y, s, anchor) => { const t = svg('text', { x, y, 'font-size': '10', fill: 'var(--muted)', 'text-anchor': anchor || 'start' }); t.textContent = s; return t; };
  for (const [m, label, anchor] of [[60, '1 h', 'start'], [360, '6 h', 'middle'], [1440, '24 h', 'end']]) {
    root.append(svg('line', { x1: X(m), x2: X(m), y1: padT, y2: Hh - padB, stroke: 'var(--line)', 'stroke-width': '1' }));
    root.append(txt(X(m) + (anchor === 'start' ? 2 : 0), Hh - 5, label, anchor));
  }
  root.append(svg('line', { x1: padL, x2: W - 6, y1: Y(0), y2: Y(0), stroke: 'var(--muted)', 'stroke-dasharray': '3 3', 'stroke-width': '1' }));
  // Podpisy osi Y: 0% zawsze, góra i dół tylko gdy nie nachodzą na 0%.
  root.append(txt(padL - 4, Y(0) + 3, '0%', 'end'));
  if (Y(0) - Y(hi) > 14) root.append(txt(padL - 4, Y(hi) + 8, (hi > 0 ? '+' : '') + Math.round(hi) + '%', 'end'));
  if (Y(lo) - Y(0) > 14) root.append(txt(padL - 4, Y(lo), Math.round(lo) + '%', 'end'));
  const last = pts[pts.length - 1][1];
  root.append(svg('polyline', { points: pts.map(([m, v]) => `${X(m).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: last >= 0 ? 'var(--up)' : 'var(--down)', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
  for (const [name, c] of Object.entries(a.checks || {})) {
    if (!c || !c.t || !Number.isFinite(c.chg)) continue;
    root.append(svg('circle', { cx: X((c.t - a.at) / 60000), cy: Y(c.chg), r: '3.5', fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': '1.5' }));
  }
  return root;
}

function alertDetail(a) {
  const d = a.d || {};
  const ago = (t) => (t ? (t - a.at < 3.6e6 ? Math.round((t - a.at) / 60000) + ' min' : nf({ maximumFractionDigits: 1 }).format((t - a.at) / 3.6e6) + ' h') : '–');
  const li = (label, ...val) => el('li', null, el('span', { class: 'mute', text: label + ': ' }), ...val);
  if (a.type === 'nft') {
    return el('div', { class: 'dgrid' },
      el('div', null, el('h3', { text: 'Kolekcja NFT w chwili alertu' }), el('ul', null,
        li('Floor', d.floor == null ? '–' : `${d.floor} ${d.currency || ''}`), li('Sprzedaże 24 h', String(d.sales1d ?? '–')), li('Wolumen 24 h / 7 dni', `${d.vol1d ?? '–'} / ${d.vol7d ?? '–'}`),
        li('Posiadaczy', String(d.owners ?? '–')), li('Pozycja w trendach 1 h / 24 h', `${d.rank1h || '–'} / ${d.rank1d || '–'}`))),
      el('div', null, el('h3', { text: 'Linki' }), el('div', { class: 'links' }, link(a.url, 'OpenSea'))));
  }
  const res = (name, label) => {
    const c = a.checks && a.checks[name];
    if (!c) return li(label, el('span', { class: 'mute', text: 'czekam' }));
    if (c.missed) return li(label, el('span', { class: 'mute', text: 'pominięty (aplikacja nie działała)' }));
    if (c.dead) return li(label, el('span', { class: 'down', text: 'token zniknął (−100%)' }));
    return li(label, pct(c.chg), c.p ? ` – ${price(c.p)}` : '', c.pk != null ? el('span', { class: 'mute', text: ` (szczyt ${pctTxt(c.pk)}, dołek ${pctTxt(c.lo)}${c.approx ? ', przybliżony' : ''})` }) : '', c.rug ? el('span', { class: 'down', text: ' – płynność wycofana' }) : '');
  };
  const peakPct = a.peak > 0 ? (a.peak / a.price0 - 1) * 100 : null;
  const lowPct = a.low > 0 ? (a.low / a.price0 - 1) * 100 : null;
  const results = el('div', null, el('h3', { text: a.done ? 'Wyniki (pomiar zakończony po 7 dniach)' : 'Wyniki (pomiar trwa)' }),
    priceChart(a),
    el('ul', { style: 'margin-top:8px' },
      res('h1', 'Po 1 h'), res('h6', 'Po 6 h'), res('h24', 'Po 24 h'), res('h72', 'Po 72 h'), res('d7', 'Po 7 dniach'),
      li('Szczyt w 24 h', peakPct == null ? '–' : pct(peakPct), a.peakAt && a.peakAt > a.at ? ` po ${ago(a.peakAt)}` : ''),
      li('Dołek w 24 h', lowPct == null ? '–' : pct(lowPct), a.lowAt && a.lowAt > a.at ? ` po ${ago(a.lowAt)}` : '')));
  const u = d.uniq;
  const atAlert = el('div', null, el('h3', { text: 'Stan w chwili alertu' }), el('ul', null,
    li('Cena', price(a.price0)), li('Płynność', usd(d.liq ?? a.liq0)), li('Wycena', usd(d.mc ?? a.mc0)),
    li('Wolumen 1 h / 24 h', `${usd(d.vol && d.vol.h1)} / ${usd(d.vol && d.vol.h24)}`),
    li('Zmiana ceny 1 h / 6 h / 24 h', pct(d.chg && d.chg.h1), ' / ', pct(d.chg && d.chg.h6), ' / ', pct(d.chg && d.chg.h24)),
    li('Wiek tokena', ageTxt(d.ageH)),
    li('Kupujący w 1 h', d.buyRatio == null ? '–' : `${Math.round(d.buyRatio * 100)}% z ${d.tx1} transakcji` + (u ? ` (portfele: ${u.buyers} kup. / ${u.sellers} sprz.)` : '')),
    li('Kontrakt', { checked: 'sprawdzony', failed: 'nie udało się sprawdzić', unsupported: 'niesprawdzony – sieć nieobsługiwana' }[d.security] || '–')));
  const isE = (a.kind || 'momentum') === 'early';
  const sc = isE ? d.early : d.momentum;
  const why = el('div', null, el('h3', { text: `Dlaczego alert: wynik ${Math.round(a.score)}` + (d.threshold != null ? ` (próg ${d.threshold})` : '') }),
    sc && sc.parts ? el('div', { class: 'parts' }, (isE ? EPARTS : PARTS).flatMap(([k, n, max, c]) => [el('span', { text: n }), el('div', { class: 'pb' }, el('span', { style: `width:${Math.min(100, (100 * (sc.parts[k] || 0)) / max)}%;background:var(--p-${c || k})` })), el('span', { class: 'pv', text: `${sc.parts[k] ?? 0} / ${max}` })])) : el('p', { class: 'mute', text: 'Szczegóły wyniku są tylko dla alertów zapisanych w dzienniku.' }),
    sc && isE && (sc.late || sc.penalty) ? el('p', { class: 'mute', style: 'margin:6px 0 0;font-size:13px', text: `Odjęto: ${sc.penalty || 0} za flagi, ${sc.late || 0} za wzrost, który już był.` }) : null,
    el('h3', { style: 'margin-top:10px', text: 'Flagi ryzyka: ' + (RISK[a.risk] || '–') }),
    el('ul', null, (d.flags || []).length ? d.flags.map((f) => el('li', { class: f.sev, text: f.text })) : el('li', { class: 'info', text: d.flags ? 'Żadna reguła nie zadziałała.' : '–' })));
  const srcs = (d.sources || []).map((x) => SRC[x] || x).concat((d.metas || []).map((m) => 'narracja „' + m + '”'));
  const links = el('div', null, el('h3', { text: 'Gdzie był widoczny' }),
    el('ul', null, srcs.length ? srcs.map((x) => el('li', { text: x })) : el('li', { class: 'info', text: '–' })),
    el('h3', { style: 'margin-top:10px', text: 'Linki' }),
    el('div', { class: 'links' }, link(a.url, 'Wykres'), link(d.pumpUrl, 'pump.fun')),
    d.address ? el('div', { class: 'addr', style: 'margin-top:8px', text: d.address }) : null,
    d.address ? el('button', { class: 'linkbtn', style: 'font-size:13px', text: 'Kopiuj adres', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(d.address).then(() => { e.target.textContent = 'Skopiowano'; }); } }) : null);
  return el('div', null, el('div', { class: 'dgrid' }, results, why, atAlert, links), extraDetail(a));
}

// Dane dodatkowe przy alercie: rynek, posiadacze, insiderzy i twórca, transakcje, Telegram, realne wejście.
function extraDetail(a) {
  const d = a.d || {};
  const en = a.enrich || {};
  const ea = en.alert || {};
  const li = (label, ...val) => el('li', null, el('span', { class: 'mute', text: label + ': ' }), ...val);
  const n0 = (x) => (x == null ? '–' : nf({ maximumFractionDigits: 0 }).format(x));
  const sec = d.secInfo || {};
  const ins = ea.insiders || {};
  const blocks = [];

  const m = d.market;
  if (m) {
    const row = (k, lbl) => (m[k] ? li(lbl, pct(m[k].h1), ' 1 h, ', pct(m[k].h24), ' 24 h') : null);
    blocks.push(el('div', null, el('h3', { text: 'Rynek w chwili alertu' }), el('ul', null,
      row('btc', 'BTC'), row('sol', 'SOL'), row('eth', 'ETH'), row('bnb', 'BNB'),
      m.memes ? li('Memecoiny (narracje DexScreener)', pct(m.memes.h1), ' 1 h, ', pct(m.memes.h24), ' 24 h') : null)));
  }

  const hp = d.holdersPre;
  const hAt = ea.holders ? ea.holders.count : hp ? hp.count : sec.holders;
  const after = ['h1', 'h24', 'h72', 'd7'].map((t) => [t, en[t] && en[t].holders ? en[t].holders.count : null]).filter(([, v]) => v != null);
  const top10 = (ea.holders && ea.holders.top10) ?? ins.top10Pct ?? sec.top10Pct;
  blocks.push(el('div', null, el('h3', { text: 'Posiadacze' }), el('ul', null,
    li('Przy alercie', n0(hAt)),
    hp && hp.change != null ? li('Przed alertem', (hp.change >= 0 ? '+' : '') + n0(hp.change), ` w ${hp.minutes} min`, hp.changePct != null ? ` (${hp.changePct > 0 ? '+' : ''}${hp.changePct}%)` : '') : li('Przed alertem', el('span', { class: 'mute', text: 'brak wcześniejszego pomiaru' })),
    after.length ? li('Po alercie', after.map(([t, v]) => `${{ h1: '1 h', h24: '24 h', h72: '72 h', d7: '7 dni' }[t]}: ${n0(v)}${hAt ? ` (${v - hAt >= 0 ? '+' : ''}${n0(v - hAt)})` : ''}`).join(', ')) : null,
    top10 != null ? li('Top 10 portfeli', nf({ maximumFractionDigits: 1 }).format(top10) + '% podaży') : null)));

  const lp = ins.lpLockedPct ?? sec.lpLockedPct;
  const creator = ins.creatorPct ?? sec.creatorPct;
  const insItems = [
    ins.insidersDetected != null ? li('Wykryci insiderzy', n0(ins.insidersDetected) + (ins.insiderNetworks ? ` w ${ins.insiderNetworks} sieciach powiązanych portfeli` : '')) : null,
    ins.insiderPctTop != null ? li('Insiderzy wśród top posiadaczy', `${nf({ maximumFractionDigits: 1 }).format(ins.insiderPctTop)}% podaży (${ins.insiderHoldersTop} portfeli)`) : null,
    creator != null ? li('Twórca', nf({ maximumFractionDigits: 2 }).format(creator) + '% podaży') : null,
    sec.ownerPct != null ? li('Właściciel kontraktu', nf({ maximumFractionDigits: 2 }).format(sec.ownerPct) + '%') : null,
    lp != null ? li('Płynność zablokowana / spalona', nf({ maximumFractionDigits: 1 }).format(lp) + '%') : null,
    sec.buyTax != null || sec.sellTax != null ? li('Podatek kupno / sprzedaż', `${sec.buyTax ?? '–'}% / ${sec.sellTax ?? '–'}%`) : null,
    ins.rugged ? li('RugCheck', el('span', { class: 'down', text: 'oznaczony jako rug' })) : null,
  ].filter(Boolean);
  blocks.push(el('div', null, el('h3', { text: 'Insiderzy, twórca, płynność' }),
    insItems.length ? el('ul', null, insItems) : el('p', { class: 'mute', text: a.chain === 'solana' ? 'Raport RugCheck jeszcze nie dotarł albo nie zawiera tych danych.' : 'Brak danych dla tej sieci.' })));

  const tr = ea.trades;
  const tradeDiv = el('div', null, el('h3', { text: 'Transakcje przy alercie' }));
  if (tr) {
    const B = tr.bucketsBuy || [];
    tradeDiv.append(el('ul', null,
      li('Ostatnie transakcje', `${tr.n} w ${tr.spanMin ?? '–'} min (kupna ${tr.buy.n}, sprzedaże ${tr.sell.n})`),
      li('Kupno: średnio / mediana / 90%', `${usd(tr.buy.avg)} / ${usd(tr.buy.med)} / ${usd(tr.buy.p90)}`),
      li('Rozkład kupna', `<$50: ${B[0] || 0}, $50–500: ${B[1] || 0}, $500–5 tys.: ${B[2] || 0}, ≥$5 tys.: ${B[3] || 0}`),
      li('Unikalni kupujący / sprzedający', `${tr.uniqueBuyers} / ${tr.uniqueSellers}`),
      tr.top5Share != null ? li('Top 5 kupujących', `${nf({ maximumFractionDigits: 1 }).format(tr.top5Share)}% wolumenu kupna`) : null,
      li('Kupujący 3+ razy', String(tr.repeatBuyers)),
      li('Saldo kupno − sprzedaż', usd(tr.netUsd))));
  } else if (d.avgTx) tradeDiv.append(el('ul', null, li('Średnia transakcja 1 h', usd(d.avgTx.h1)), li('Średnia transakcja 24 h', usd(d.avgTx.h24))));
  else tradeDiv.append(el('p', { class: 'mute', text: 'Brak danych o transakcjach.' }));
  blocks.push(tradeDiv);

  const tp = d.tgPre;
  const tgAt = ea.tgMembers ?? (tp && tp.count) ?? (d.tg && d.tg.n);
  const tgAfter = ['h1', 'h24', 'h72', 'd7'].map((t) => [t, en[t] && en[t].tgMembers]).filter(([, v]) => v != null);
  const g = d.tg || (ea.tgStatus ? { s: ea.tgStatus } : null);
  const isPub = g ? g.s === 'public' : !!d.tgLink;
  blocks.push(el('div', null, el('h3', { text: 'Telegram tokena' }), el('ul', null,
    li('Stan', `${TG_ICON[(g || {}).s] || ''} ${g || d.tgLink ? tgText(g && Object.assign({}, g, { n: null }), d.tgLink) : 'brak danych (alert sprzed tej funkcji)'}`),
    isPub && tgAt != null ? li('Członków przy alercie', n0(tgAt)) : null,
    isPub && tp && tp.change != null ? li('Przed alertem', (tp.change >= 0 ? '+' : '') + n0(tp.change), ` w ${tp.minutes} min`) : null,
    isPub && tgAfter.length ? li('Po alercie', tgAfter.map(([t, v]) => `${{ h1: '1 h', h24: '24 h', h72: '72 h', d7: '7 dni' }[t]}: ${n0(v)}${tgAt ? ` (${v - tgAt >= 0 ? '+' : ''}${n0(v - tgAt)})` : ''}`).join(', ')) : null),
    d.tgLink ? link(d.tgLink, 'Otwórz Telegram') : null));

  const c2 = a.checks && a.checks.m2, c5 = a.checks && a.checks.m5;
  if (c2 || c5) {
    const v = (c) => (!c ? el('span', { class: 'mute', text: 'czekam' }) : c.missed ? el('span', { class: 'mute', text: 'pominięty' }) : pct(c.chg));
    blocks.push(el('div', null, el('h3', { text: 'Realne wejście' }), el('ul', null,
      li('Cena 2 min po alercie', v(c2)), li('Cena 5 min po alercie', v(c5))),
      el('p', { class: 'mute', style: 'margin:4px 0 0;font-size:13px', text: 'Tyle mniej więcej ucieka, zanim zdążysz kupić.' })));
  }
  return el('div', { class: 'dgrid', style: 'margin-top:16px;padding-top:14px;border-top:1px solid var(--line)' }, blocks);
}



// Dane alertów: lokalnie /api/alerts, na GitHubie alerts-live.json i alerts-index.json z tego samego commita co data.json.
let ALERTS = null, alertsSha = null;
const rawUrl = (ref, file) => `https://raw.githubusercontent.com/${REMOTE.owner}/${REMOTE.repo}/${ref}/${file}`;
async function loadAlerts() {
  try {
    if (!REMOTE) ALERTS = await toLogin(await fetch('/api/alerts', { cache: 'no-store' })).json();
    else if (REMOTE.url) {
      const base = REMOTE.url.replace(/data\.json(\?.*)?$/, '');
      const [live, index] = await Promise.all(['alerts-live.json', 'alerts-index.json'].map((f) => fetch(base + f, { cache: 'no-store' }).then((r) => r.json())));
      ALERTS = { live, index };
    } else {
      const ref = lastSha || REMOTE.branch;
      if (ref === alertsSha && ALERTS) return;
      const q = lastSha ? '' : '?t=' + Math.floor(Date.now() / 60000);
      const [live, index] = await Promise.all(['alerts-live.json', 'alerts-index.json'].map((f) => fetch(rawUrl(ref, f) + q).then((r) => (r.ok ? r.json() : null))));
      if (!live || !index) return;
      ALERTS = { live, index };
      alertsSha = ref;
    }
  } catch (e) {
    // pliki jeszcze nie istnieją (starsza wersja na Orange Pi) – spróbujemy przy następnym odświeżeniu
  }
  if (S && (ui.tab === 'alerts' || (isSol() && ui.solView === 'alerts'))) render();
}

// Szczegóły jednego alertu pobieramy dopiero po jego rozwinięciu.
const DETAILS = new Map();
async function loadDetail(id) {
  if (!id || DETAILS.has(id)) return;
  DETAILS.set(id, 'loading');
  try {
    let r;
    if (!REMOTE) r = await toLogin(await fetch('/api/alert?id=' + encodeURIComponent(id), { cache: 'no-store' }));
    else if (REMOTE.url) r = await fetch(REMOTE.url.replace(/data\.json(\?.*)?$/, '') + `details/${id}.json`, { cache: 'no-store' });
    else r = await fetch(rawUrl(lastSha || REMOTE.branch, `details/${id}.json`));
    DETAILS.set(id, r.ok ? await r.json() : 'missing');
  } catch (e) {
    DETAILS.delete(id);
  }
  if (ui.tab === 'alerts' || (isSol() && ui.solView === 'alerts')) render();
}

function detailFor(r) {
  const d = DETAILS.get(r.id);
  if (d === 'loading' || (d == null && r.id)) return el('p', { class: 'mute', text: 'Wczytuję szczegóły…' });
  // Bieżące dane z listy 24 h mają pierwszeństwo przed zapisanym plikiem (świeższy szczyt i wykres).
  const a = Object.assign({}, d && d !== 'missing' ? d : {}, r.live || {});
  a.d = (d && d !== 'missing' && d.d) || null;
  if (!a.price0) Object.assign(a, { price0: r.price0, at: r.at, kind: r.kind, type: r.type, score: r.score, risk: r.risk, symbol: r.symbol, chain: r.chain });
  return alertDetail(a);
}

// Na GitHubie ustawienia tylko pokazujemy – zmienia się je komendami w Telegramie
// albo w panelu otwartym bezpośrednio na Orange Pi.
function renderSettingsReadOnly() {
  const a = S.config.alerts, e = S.config.early;
  const onoff = (x) => (x ? 'włączone' : 'wyłączone');
  const money = (x) => usd(x);
  const rows = [
    ['Alerty', onoff(a.enabled), '/ustaw alerty on|off  (albo /pauza, /wznow)'],
    ['Wczesne sygnały', onoff(e.enabled), '/ustaw wczesne on|off'],
    ['Minimalny wynik wczesny', e.minScore, '/ustaw wczesny 50'],
    ['Wczesne: minimalna płynność', money(e.minLiquidityUsd), '/ustaw wczesna_plynnosc 20k'],
    ['Wczesne: minimalny wolumen 1 h', money(e.minVolume1hUsd), '/ustaw wczesny_wolumen 5k'],
    ['Wczesne: maksymalna wycena', money(e.maxMarketCapUsd), '/ustaw wczesna_wycena 10m'],
    ['Gorące teraz: minimalny wynik', a.minScore, '/ustaw goracy 60'],
    ['Gorące teraz: minimalna płynność', money(a.minLiquidityUsd), '/ustaw plynnosc 20k'],
    ['Gorące teraz: minimalny wolumen 1 h', money(a.minVolume1hUsd), '/ustaw wolumen 10k'],
    ['Tokeny na krzywej pump.fun', onoff(a.allowBondingCurve), '/ustaw krzywa on|off'],
    ['Przerwa między alertami o tym samym tokenie', a.cooldownHours + ' h', '/ustaw przerwa 6'],
    ['Najwięcej alertów na skan', a.maxPerScan, '/ustaw max 3'],
    ['Tylko te sieci', (a.chains || []).length ? a.chains.join(', ') : 'wszystkie', '/ustaw sieci solana,base  albo  /ustaw sieci wszystkie'],
    ['Alerty NFT', onoff(a.nft), '/ustaw nft on|off'],
    ['Minimalny wynik kolekcji NFT', a.nftMinScore, '/ustaw nft_wynik 50'],
    ['Odstęp między skanami', S.config.scanIntervalSec + ' s', '/ustaw interwal 60'],
  ];
  const tbl = el('div', { class: 'tablewrap' }, el('table', { style: 'min-width:0' },
    el('thead', null, el('tr', null, el('th', { class: 'l', text: 'Ustawienie' }), el('th', { class: 'l', text: 'Wartość' }), el('th', { class: 'l', text: 'Zmiana w Telegramie' }))),
    el('tbody', null, rows.map(([k, v, c]) => el('tr', null, el('td', { class: 'l', text: k }), el('td', { class: 'l', text: String(v) }), el('td', { class: 'l' }, el('code', { text: c })))))));
  const tgState = S.config.telegram.connected ? 'Telegram połączony – komendy działają.' : 'Telegram nie jest jeszcze połączony. Połącz go w panelu na Orange Pi (zakładka Ustawienia).';
  put($('view'),
    el('div', { class: 'panel' },
      el('h2', { text: 'Ustawienia (tylko podgląd)' }),
      el('p', { text: 'Ta strona tylko pokazuje dane wysłane przez Orange Pi. Ustawienia zmieniasz komendami w rozmowie z botem na Telegramie – strona pokaże zmianę przy następnej publikacji (zwykle w ciągu 2 minut). Lista komend: /pomoc.' }),
      el('p', { class: S.config.telegram.connected ? 'msg ok' : 'mute', text: tgState })),
    el('div', { style: 'max-width:980px' }, tbl));
}

function renderSettings() {
  if (REMOTE) return renderSettingsReadOnly();
  if (ui.settingsBuilt) return updateTgStatus();
  ui.settingsBuilt = true;
  const a = S.config.alerts;
  const view = $('view');
  const msg = (id) => el('span', { class: 'msg', id, role: 'status' });
  const say = (id, text, ok) => { const m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'bad'); };
  const numField = (id, label, val, hint, step) => [el('label', { for: id, text: label }), el('input', { type: 'number', id, value: val, step: step || 'any', min: '0' }), hint ? el('div', { class: 'hint', text: hint }) : null];

  const tgPanel = el('div', { class: 'panel' },
    el('h2', { text: 'Alerty na Telegram' }),
    el('ol', null,
      el('li', null, 'W Telegramie otwórz rozmowę z ', el('b', { text: '@BotFather' }), ', wyślij /newbot i nadaj botowi nazwę.'),
      el('li', { text: 'Skopiuj token, który BotFather poda na końcu, wklej go poniżej i zapisz.' }),
      el('li', { text: 'Otwórz rozmowę ze swoim nowym botem i wyślij mu kod parowania, który pojawi się poniżej. Aplikacja połączy się tylko z rozmową, z której przyjdzie ten kod.' })),
    el('div', { class: 'field' }, el('label', { for: 'tgToken', text: 'Token bota' }), el('input', { type: 'password', id: 'tgToken', autocomplete: 'off', placeholder: S.config.telegram.hasToken ? 'zapisany – wklej nowy, żeby zmienić' : '123456789:AA…' })),
    el('p', { id: 'tgStatus', class: 'mute' }),
    el('div', { class: 'rowbtn' },
      el('button', { class: 'btn', text: 'Zapisz token', onclick: async () => {
        const v = $('tgToken').value.trim();
        if (!v) return say('tgMsg', 'Wklej token od BotFather.', false);
        try { const d = await post('/api/config', { telegramToken: v }); S.config = d.config; $('tgToken').value = ''; say('tgMsg', 'Token zapisany.', true); updateTgStatus(); } catch (e) { say('tgMsg', e.message, false); }
      } }),
      el('button', { class: 'btn ghost', text: 'Wyślij wiadomość testową', onclick: async () => {
        try { await post('/api/telegram/test'); say('tgMsg', 'Wysłano. Sprawdź Telegram.', true); } catch (e) { say('tgMsg', e.message, false); }
        load();
      } }),
      el('button', { class: 'linkbtn', text: 'Odłącz bota', onclick: async () => {
        try { const d = await post('/api/config', { telegramToken: '' }); S.config = d.config; say('tgMsg', 'Bot odłączony.', true); updateTgStatus(); } catch (e) { say('tgMsg', e.message, false); }
      } }),
      msg('tgMsg')));

  const ea = S.config.early;
  const alPanel = el('div', { class: 'panel' },
    el('h2', { text: 'Kiedy wysyłać alert' }),
    el('div', { class: 'field' },
      el('label', { for: 'aOn', text: 'Alerty włączone' }), el('input', { type: 'checkbox', id: 'aOn', checked: a.enabled, style: 'justify-self:start' }),
      el('label', { for: 'eOn', text: 'Wczesne sygnały' }), el('input', { type: 'checkbox', id: 'eOn', checked: ea.enabled, style: 'justify-self:start' }),
      ...numField('eScore', 'Minimalny wynik wczesny', ea.minScore, 'Im wyżej, tym mniej sygnałów. Dostrój po kilku dniach według zakładki Alerty.', '1'),
      ...numField('eLiq', 'Wczesne: minimalna płynność ($)', ea.minLiquidityUsd, 'Poniżej tej płynności token nie pojawia się na liście wczesnych sygnałów.'),
      ...numField('eVol', 'Wczesne: minimalny wolumen z ostatniej godziny ($)', ea.minVolume1hUsd),
      ...numField('eMc', 'Wczesne: maksymalna wycena ($)', ea.maxMarketCapUsd, 'Większe tokeny znikają z listy wczesnych sygnałów; nadal są w „Gorące teraz”.'),
      ...numField('aScore', 'Gorące teraz: minimalny wynik', a.minScore, 'Tokeny z krytyczną flagą nigdy nie wywołują alertu.', '1'),
      ...numField('aLiq', 'Gorące teraz: minimalna płynność ($)', a.minLiquidityUsd),
      ...numField('aVol', 'Gorące teraz: minimalny wolumen z ostatniej godziny ($)', a.minVolume1hUsd),
      el('label', { for: 'aCurve', text: 'Tokeny jeszcze na krzywej pump.fun' }), el('input', { type: 'checkbox', id: 'aCurve', checked: a.allowBondingCurve, style: 'justify-self:start' }),
      el('div', { class: 'hint', text: 'Nie mają puli płynności, więc zamiast płynności liczy się minimalna wycena.' }),
      ...numField('aMc', 'Minimalna wycena tokena na krzywej ($)', a.minMarketCapUsd),
      ...numField('aCool', 'Przerwa między alertami o tym samym tokenie (godziny)', a.cooldownHours),
      ...numField('aMax', 'Najwięcej alertów na jeden skan', a.maxPerScan, null, '1'),
      el('label', { for: 'aChains', text: 'Tylko te sieci' }), el('input', { type: 'text', id: 'aChains', value: (a.chains || []).join(', '), placeholder: 'puste = wszystkie, np. solana, base' }),
      el('label', { for: 'aNft', text: 'Alerty o nowych kolekcjach NFT w trendach' }), el('input', { type: 'checkbox', id: 'aNft', checked: a.nft, style: 'justify-self:start' }),
      ...numField('aNftScore', 'Minimalny wynik kolekcji NFT', a.nftMinScore, null, '1'),
      ...numField('sInt', 'Odstęp między skanami (sekundy)', S.config.scanIntervalSec, `Najmniej ${S.config.minScanSec || 45}. GeckoTerminal bez klucza przyjmuje około 10 zapytań na minutę, a jeden skan to do 6.`, '1')),
    el('div', { class: 'rowbtn' },
      el('button', { class: 'btn', text: 'Zapisz ustawienia', onclick: async () => {
        const v = (id) => { const x = parseFloat($(id).value); return isFinite(x) ? x : undefined; };
        try {
          const d = await post('/api/config', {
            scanIntervalSec: v('sInt'),
            early: { enabled: $('eOn').checked, minScore: v('eScore'), minLiquidityUsd: v('eLiq'), minVolume1hUsd: v('eVol'), maxMarketCapUsd: v('eMc') },
            alerts: { enabled: $('aOn').checked, nft: $('aNft').checked, allowBondingCurve: $('aCurve').checked, minScore: v('aScore'), nftMinScore: v('aNftScore'), minLiquidityUsd: v('aLiq'), minVolume1hUsd: v('aVol'), minMarketCapUsd: v('aMc'), cooldownHours: v('aCool'), maxPerScan: v('aMax'), chains: $('aChains').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) },
          });
          S.config = d.config; say('alMsg', 'Zapisano.', true);
        } catch (e) { say('alMsg', e.message, false); }
      } }),
      msg('alMsg')));

  const how = el('div', { class: 'panel' },
    el('h2', { text: 'Jak powstaje wynik' }),
    el('p', { text: 'Wynik wczesny (0–100) to suma pięciu składników: rosnący popyt, czyli wolumen ostatniej godziny względem własnej średniej i impuls z ostatnich 5 minut (do 30), kupujący – udział zakupów, przyspieszenie liczby transakcji i przewaga unikalnych portfeli kupujących (do 20), zapas ceny – najwięcej punktów, gdy cena prawie stoi (do 20), mała wycena przy sensownej płynności (do 15) oraz świeżość (do 15). Odejmujemy do 26 punktów za wzrost, który już był, oraz kary za flagi ryzyka.' }),
    el('p', { text: 'Po każdym alercie aplikacja zapisuje cenę i sprawdza ją po 1, 6 i 24 godzinach. Wyniki są w zakładce Alerty; komputer musi być wtedy włączony.' }),
    el('p', { text: 'Wynik „gorące teraz” (momentum, 0–100) to suma pięciu składników: przyspieszenie wolumenu względem ostatnich 6 i 24 godzin (do 28), liczba transakcji i wolumen z ostatniej godziny (do 20), przewaga kupujących (do 15), wzrost ceny w 1, 6 i 24 godziny (do 20) oraz to, w ilu miejscach token jest teraz widoczny (do 17).' }),
    el('p', { text: 'Od momentum odejmujemy kary za flagi ryzyka: 30 punktów za krytyczną, 6 za ostrzeżenie. Krytyczne to m.in. płynność poniżej $5 tys., gwałtowny zjazd ceny, honeypot albo poważne ostrzeżenie RugCheck.' }),
    el('p', { text: 'Zamiast danych z X aplikacja używa darmowych wskaźników uwagi: trendów GeckoTerminal i CoinGecko, narracji i promocji z DexScreener oraz komentarzy i transmisji na pump.fun.' }));
  const pub = S.config.publish || {};
  const pubPanel = el('div', { class: 'panel' },
    el('h2', { text: 'Strona na GitHubie' }),
    pub.enabled
      ? el('p', null, 'Dane są wysyłane co ' + Math.round((pub.intervalSec || 120) / 60) + ' min. ', pub.site ? link(pub.site, 'Otwórz stronę') : null, '. Stan ostatniej wysyłki jest na liście źródeł u góry.')
      : el('p', { class: 'mute', text: 'Wysyłanie na GitHuba jest wyłączone. Włącza je skrypt deploy/install.sh (sekcja „publish” w config.json).' }));
  view.replaceChildren(tgPanel, alPanel, pubPanel, how);
  updateTgStatus();
}
function updateTgStatus() {
  const p = $('tgStatus');
  if (!p) return;
  const t = S.config.telegram;
  if (t.error) { p.textContent = t.error; p.className = 'msg bad'; }
  else if (t.connected) { p.textContent = 'Połączono' + (t.bot ? ' z botem @' + t.bot : '') + '. Alerty będą przychodzić na Telegram.'; p.className = 'msg ok'; }
  else if (t.hasToken) {
    p.className = 'mute';
    p.replaceChildren('Token zapisany. Teraz wyślij do bota' + (t.bot ? ' @' + t.bot : '') + ' w prywatnej rozmowie kod ', el('b', { text: t.pairCode || '…' }), ' – połączenie pojawi się przy następnym skanie.');
  }
  else { p.textContent = 'Bot nie jest jeszcze podłączony.'; p.className = 'mute'; }
}

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => { ui.tab = b.dataset.tab; if (S) render(); if (S && (ui.tab === 'alerts' || (isSol() && ui.solView === 'alerts'))) loadAlerts(); });
$('srcToggle').addEventListener('click', () => { const open = $('sources').classList.toggle('open'); $('srcToggle').setAttribute('aria-expanded', String(open)); });
$('logout').addEventListener('click', async () => { try { await fetch('/logout', { method: 'POST' }); } catch (e) {} location.href = '/login'; });
$('scanNow').addEventListener('click', async () => { $('scanNow').disabled = true; try { await post('/api/scan'); } catch (e) {} setTimeout(load, 1500); });
load();
// Na GitHubie dane zmieniają się co ~2 minuty, a API GitHuba bez logowania daje 60 zapytań na godzinę.
setInterval(() => { if (!document.hidden) load(); }, REMOTE ? 90000 : 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S) load(); });
