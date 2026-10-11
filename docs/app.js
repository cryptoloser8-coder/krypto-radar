'use strict';
const $ = (id) => document.getElementById(id);
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
const isEarly = () => ui.tab === 'early';

const ui = { tab: 'early', q: '', chain: '', minLiq: 0, hideCrit: true, sort: 'score', meta: '', open: new Set(), settingsBuilt: false };
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
  $('ctEarly').textContent = S.tokens.filter((t) => t.e && t.e.inScope).length || '';
  $('ctTokens').textContent = S.tokens.length || '';
  $('ctPump').textContent = S.tokens.filter((t) => t.isPump).length || '';
  $('ctNft').textContent = S.nfts.length || '';
  $('ctAlerts').textContent = S.alerts.length || '';
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  if (ui.tab === 'settings') return renderSettings();
  ui.settingsBuilt = false;
  if (ui.tab === 'nft') return renderNfts();
  if (ui.tab === 'alerts') return renderAlerts();
  renderTokens();
}

function renderTop() {
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
          const b = el('button', { class: 'topic', 'aria-pressed': String(ui.meta === m.slug), title: m.description || '', onclick: () => { ui.meta = ui.meta === m.slug ? '' : m.slug; if (!['early', 'tokens', 'pump'].includes(ui.tab)) ui.tab = 'early'; render(); } },
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
  let list = S.tokens.slice();
  if (ui.tab === 'pump') list = list.filter((t) => t.isPump);
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
      t.pump ? el('p', { class: 'mute', style: 'margin:6px 0 0;font-size:13px', text: `pump.fun: ${t.pump.replyCount} komentarzy` + (t.pump.live ? `, transmisja na żywo (${t.pump.participants} widzów)` : '') + (t.pump.complete ? ', po migracji z krzywej' : ', jeszcze na krzywej') }) : null),
    el('div', null, el('h3', { text: 'Linki' }),
      el('div', { class: 'links' }, link(t.url, t.dataFrom === 'geckoterminal' ? 'Wykres (GeckoTerminal)' : 'Wykres (DexScreener)'), link(t.pumpUrl, 'pump.fun'), link(t.socials && t.socials.twitter, 'X'), link(t.socials && t.socials.telegram, 'Telegram'), link(t.socials && t.socials.website, 'Strona')),
      el('div', { class: 'addr', style: 'margin-top:8px', text: t.address }),
      el('button', { class: 'linkbtn', style: 'font-size:13px', text: 'Kopiuj adres', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(t.address).then(() => { e.target.textContent = 'Skopiowano'; }); } })));
}

function renderTokens() {
  const view = $('view');
  const early = isEarly();
  const chains = [...new Set(S.tokens.map((t) => t.chain))].sort();
  const list = filteredTokens();
  const sel = (id, opts, val, on) => el('select', { id, onchange: (e) => { on(e.target.value); render(); } }, opts.map(([v, t]) => el('option', { value: v, selected: String(v) === String(val), text: t })));
  const focusQ = document.activeElement && document.activeElement.id === 'q';
  const caret = focusQ ? document.activeElement.selectionStart : null;
  const filters = el('div', { class: 'filters' },
    el('input', { type: 'search', id: 'q', placeholder: 'Szukaj: symbol, nazwa, adres', value: ui.q, 'aria-label': 'Szukaj tokena', oninput: (e) => { ui.q = e.target.value; render(); } }),
    sel('fChain', [['', 'Wszystkie sieci'], ...chains.map((c) => [c, c])], ui.chain, (v) => (ui.chain = v)),
    sel('fLiq', [[0, 'Dowolna płynność'], [10000, 'Płynność od $10 tys.'], [50000, 'od $50 tys.'], [250000, 'od $250 tys.'], [1000000, 'od $1 mln']], ui.minLiq, (v) => (ui.minLiq = +v)),
    sel('fSort', [['score', 'Sortuj: wynik'], ...(early ? [] : [['momentum', 'momentum (bez kar)']]), ['vol1', 'wolumen 1 h'], ['chg1', 'zmiana 1 h'], ['age', 'najmłodsze']], ui.sort, (v) => (ui.sort = v)),
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
        el('div', null, el('span', { class: 'sym', text: t.symbol }), el('span', { class: 'chain', text: t.chain }), t.isNew ? el('span', { class: 'badge-new', text: 'nowy na liście' }) : null),
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
  const rows = S.nfts.map((c, i) => {
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
    legend,
    el('div', { class: 'tablewrap' }, S.nfts.length ? el('table', null, el('thead', null, head), el('tbody', null, rows)) : el('div', { class: 'empty', text: S.nftScannedAt ? 'OpenSea nie zwróciło kolekcji. Rozwiń „Źródła” u góry, żeby zobaczyć błąd.' : 'Pierwszy skan NFT jeszcze trwa.' })),
    cg.length ? el('p', { class: 'mute', style: 'margin-top:14px' }, 'Najczęściej wyszukiwane NFT na CoinGecko: ', cg.map((x, i) => el('span', null, i ? ', ' : '', x.name + ' (floor ' + (x.floor || '–') + ', ', pct(x.floorChg24), ')'))) : null);
}

function renderAlerts() {
  const view = $('view');
  const tgOn = S.config.telegram.connected;
  const O = S.outcomes || {};
  const tracked = (a) => a.type === 'token' && a.price0 > 0;
  const chk = (a, name) => {
    if (!tracked(a)) return el('span', { class: 'mute', text: '–' });
    const c = a.checks && a.checks[name];
    if (!c) return el('span', { class: 'mute', text: 'czekam' });
    if (c.missed) return el('span', { class: 'mute', text: 'pominięty', title: 'Aplikacja była wtedy wyłączona albo źródło nie odpowiadało' });
    if (c.dead) return el('span', { class: 'down', text: 'zniknął', title: 'DexScreener nie zna już tego tokena – liczony jako −100%' });
    const n = pct(c.chg);
    if (c.rug) { n.textContent += ' !'; n.title = 'Płynność spadła poniżej 1/5 tej z chwili alertu'; }
    return n;
  };
  const win = (w) => (!w || !w.n ? el('span', { class: 'mute', text: 'jeszcze brak' }) : el('span', { title: `${w.big}% zyskało co najmniej 50%, ${w.bad}% straciło co najmniej 50%` }, `${w.up}% na plusie, mediana `, pct(w.median), ` (${w.n})`));
  const statRow = (label, o) => el('tr', { class: 'row', style: 'cursor:default' },
    el('td', { class: 'l', style: 'font-family:var(--ui);font-weight:600', text: label }),
    el('td', { text: o ? o.total : 0 }),
    el('td', null, win(o && o.h1)), el('td', null, win(o && o.h6)), el('td', null, win(o && o.h24)),
    el('td', null, !o || !o.peak || !o.peak.n ? el('span', { class: 'mute', text: 'jeszcze brak' }) : el('span', null, 'mediana ', pct(o.peak.median), `, ${o.peak.big}% doszło do +50%`)));
  const closed = ['early', 'momentum'].reduce((s, k) => s + ((O[k] && O[k].h24 && O[k].h24.n) || 0), 0);
  const stats = el('div', null,
    el('h2', { style: 'font:600 15px/1.2 var(--ui);margin:0 0 8px', text: 'Skuteczność sygnałów z ostatnich 30 dni' }),
    el('div', { class: 'tablewrap', style: 'margin-bottom:8px' }, el('table', { style: 'min-width:900px' },
      el('thead', null, el('tr', null, ['Rodzaj', 'Sygnałów', 'Po 1 h', 'Po 6 h', 'Po 24 h', 'Najwyższa cena w 24 h'].map((h, i) => el('th', { class: i === 0 ? 'l' : '', text: h })))),
      el('tbody', null, statRow('Wczesne sygnały', O.early), statRow('Gorące teraz', O.momentum)))),
    el('p', { class: 'mute', style: 'margin:0 0 18px;max-width:86ch;font-size:13px', text:
      'Zmiana ceny liczona od chwili alertu. W nawiasie liczba sprawdzonych sygnałów. ' +
      (closed < 30 ? `Na razie zamkniętych po 24 h jest ${closed}; poniżej około 30 wynik niewiele mówi.` : 'Token, który zniknął z DexScreenera, liczy się jako −100%.') }));

  const when = (t) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const KIND = { early: 'wczesny', momentum: 'gorący' };
  const rows = S.alerts.map((a) => el('tr', { class: 'row r-' + (a.risk || 'none'), style: 'cursor:default' },
    el('td', { class: 'l', text: when(a.at) }),
    el('td', { class: 'l', style: 'font-family:var(--ui)' }, link(a.url, a.symbol) || a.symbol, a.chain ? el('span', { class: 'chain', text: a.chain }) : null),
    el('td', { class: 'l', style: 'font-family:var(--ui)', text: a.type === 'nft' ? 'NFT' : KIND[a.kind || 'momentum'] }),
    el('td', { text: Math.round(a.score) }),
    el('td', { text: tracked(a) ? price(a.price0) : '–' }),
    el('td', null, chk(a, 'h1')), el('td', null, chk(a, 'h6')), el('td', null, chk(a, 'h24')),
    el('td', null, tracked(a) && a.peak > 0 ? pct((a.peak / a.price0 - 1) * 100) : el('span', { class: 'mute', text: '–' })),
    el('td', { class: 'l', style: 'font-family:var(--ui);font-size:13px' }, el('span', { class: a.sent ? 'up' : 'mute', text: a.sent ? 'wysłano' : a.error || 'nie wysłano' }))));
  const E = S.config.early;
  put(view, stats,
    el('h2', { style: 'font:600 15px/1.2 var(--ui);margin:0 0 8px', text: 'Alerty' }),
    tgOn ? null : el('p', { class: 'mute', style: 'margin:0 0 8px', text: 'Telegram nie jest połączony, więc alerty zapisują się tylko tutaj. Połącz go w zakładce Ustawienia.' }),
    el('div', { class: 'tablewrap' }, S.alerts.length
      ? el('table', null,
          el('thead', null, el('tr', null, ['Czas', 'Token', 'Rodzaj', 'Wynik', 'Cena przy alercie', 'Po 1 h', 'Po 6 h', 'Po 24 h', 'Szczyt', 'Telegram'].map((h, i) => el('th', { class: i < 3 || i === 9 ? 'l' : '', text: h })))),
          el('tbody', null, rows))
      : el('div', { class: 'empty', text: `Jeszcze żadnego. Wczesny sygnał powstaje od wyniku ${E.minScore}, alert „gorący” od ${S.config.alerts.minScore}; token z krytyczną flagą nie wywołuje żadnego.` })));
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

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => { ui.tab = b.dataset.tab; if (S) render(); });
$('srcToggle').addEventListener('click', () => { const open = $('sources').classList.toggle('open'); $('srcToggle').setAttribute('aria-expanded', String(open)); });
$('logout').addEventListener('click', async () => { try { await fetch('/logout', { method: 'POST' }); } catch (e) {} location.href = '/login'; });
$('scanNow').addEventListener('click', async () => { $('scanNow').disabled = true; try { await post('/api/scan'); } catch (e) {} setTimeout(load, 1500); });
load();
// Na GitHubie dane zmieniają się co ~2 minuty, a API GitHuba bez logowania daje 60 zapytań na godzinę.
setInterval(() => { if (!document.hidden) load(); }, REMOTE ? 90000 : 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S) load(); });
