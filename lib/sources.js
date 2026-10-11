'use strict';
// Pobieranie danych z darmowych API i sprowadzanie ich do wspólnego formatu.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const API_DEFAULTS = {
  dexscreener: 'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com/api/v2',
  coingecko: 'https://api.coingecko.com/api/v3',
  pumpfun: 'https://frontend-api-v3.pump.fun',
  opensea: 'https://api.opensea.io/api/v2',
  rugcheck: 'https://api.rugcheck.xyz',
  goplus: 'https://api.gopluslabs.io',
  telegram: 'https://api.telegram.org',
};

// Po odpowiedzi 429 (przekroczony limit) dany serwis dostaje przerwę: tyle, ile poda w Retry-After,
// a bez tego nagłówka 1, 2, 4… minuty (najwyżej 15). W tym czasie zapytania do niego nie wychodzą,
// tylko od razu kończą się błędem 429 – kod wyżej traktuje go tak samo jak prawdziwą odmowę.
const hostBlock = new Map(); // host -> { until, strikes }
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
};
// Budżet zapytań na minutę dla serwisów z małym limitem (GeckoTerminal bez klucza: ~10/min).
// Zapytania „optional” (dodatkowe dane) czekają na następny skan, gdy budżet jest wyczerpany;
// obowiązkowe (listy trendów) zawsze wychodzą, ale też się liczą.
const BUDGET = { gt: 9 };
const spent = new Map(); // nazwa → czasy zapytań z ostatniej minuty
function budgetLeft(name) {
  const now = Date.now();
  const arr = (spent.get(name) || []).filter((t) => now - t < 60e3);
  spent.set(name, arr);
  return (BUDGET[name] == null ? Infinity : BUDGET[name]) - arr.length;
}
function setBudget(name, perMin) {
  if (Number.isFinite(perMin) && perMin > 0) BUDGET[name] = perMin;
}

function backoffState() {
  const now = Date.now();
  return [...hostBlock].filter(([, b]) => b.until > now).map(([host, b]) => ({ host, untilMs: b.until - now, strikes: b.strikes }));
}

async function fetchJson(url, opts = {}) {
  if (opts.budget) {
    if (opts.optional && budgetLeft(opts.budget) <= 0) {
      const err = new Error('limit zapytań na minutę – odłożone do następnego skanu');
      err.status = 0;
      err.budget = true;
      throw err;
    }
    budgetLeft(opts.budget);
    spent.get(opts.budget).push(Date.now());
  }
  const host = hostOf(url);
  const blk = hostBlock.get(host);
  if (blk && Date.now() < blk.until) {
    const err = new Error(`HTTP 429 – przerwa po przekroczeniu limitu, jeszcze ${Math.ceil((blk.until - Date.now()) / 1000)} s`);
    err.status = 429;
    err.backoff = true;
    throw err;
  }
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign({ accept: 'application/json', 'user-agent': UA }, opts.headers || {}),
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  if (res.status === 429) {
    const strikes = (blk ? blk.strikes : 0) + 1;
    const ra = parseFloat(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30 * 60e3) : Math.min(60e3 * 2 ** (strikes - 1), 15 * 60e3);
    hostBlock.set(host, { until: Date.now() + wait, strikes });
  } else if (blk) {
    hostBlock.delete(host);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${txt.slice(0, 120).replace(/\s+/g, ' ')}`);
    err.status = res.status;
    err.body = txt.slice(0, 2000);
    throw err;
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : null;
};

// GeckoTerminal nazywa niektóre sieci inaczej niż DexScreener.
const GT_TO_DS = {
  eth: 'ethereum',
  polygon_pos: 'polygon',
  avax: 'avalanche',
  'sui-network': 'sui',
  cro: 'cronos',
  ftm: 'fantom',
  'sei-evm': 'seiv2',
  'starknet-alpha': 'starknet',
  'world-chain': 'worldchain',
  'near-protocol': 'near',
  'polygon-zkevm': 'polygonzkevm',
};

// Stablecoiny i „duże” aktywa – trendują zawsze, a nie o nie tu chodzi.
const SKIP_SYMBOLS = new Set(
  ('USDC USDT DAI USDE USDS FDUSD PYUSD TUSD USD1 USDC.E USDT0 USDBC BUSD FRAX EURC WETH ETH WBTC BTC CBBTC TBTC ' +
    'SOL WSOL BNB WBNB MATIC WMATIC POL WPOL AVAX WAVAX TON TRX WTRX SUI WSUI STETH WSTETH CBETH RETH WEETH JITOSOL MSOL BNSOL JUPSOL HYPE WHYPE S WS XRP')
    .split(' ')
);

const keyOf = (chain, address) => `${chain}:${/^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address}`;

function socialsFromInfo(info) {
  const out = {};
  if (!info) return out;
  for (const s of info.socials || []) {
    if (s.type === 'twitter' && !out.twitter) out.twitter = s.url;
    if (s.type === 'telegram' && !out.telegram) out.telegram = s.url;
  }
  if (info.websites && info.websites[0]) out.website = info.websites[0].url;
  return out;
}

function fromDexPair(p) {
  const liq = p.liquidity && num(p.liquidity.usd);
  const tx = p.txns || {};
  const pick = (w) => ({ buys: (tx[w] && tx[w].buys) || 0, sells: (tx[w] && tx[w].sells) || 0 });
  return {
    key: keyOf(p.chainId, p.baseToken.address),
    chain: p.chainId,
    address: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    url: p.url,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    priceUsd: num(p.priceUsd),
    liquidityUsd: liq,
    fdv: num(p.fdv),
    marketCap: num(p.marketCap),
    createdAt: p.pairCreatedAt || null,
    vol: { m5: num(p.volume && p.volume.m5) || 0, h1: num(p.volume && p.volume.h1) || 0, h6: num(p.volume && p.volume.h6) || 0, h24: num(p.volume && p.volume.h24) || 0 },
    txns: { m5: pick('m5'), h1: pick('h1'), h6: pick('h6'), h24: pick('h24') },
    chg: { m5: num(p.priceChange && p.priceChange.m5), h1: num(p.priceChange && p.priceChange.h1), h6: num(p.priceChange && p.priceChange.h6), h24: num(p.priceChange && p.priceChange.h24) },
    boostsActive: (p.boosts && p.boosts.active) || 0,
    socials: socialsFromInfo(p.info),
    image: (p.info && p.info.imageUrl) || null,
    bondingCurve: liq == null && /^pump/.test(p.dexId || ''),
    dataFrom: 'dexscreener',
  };
}

function fromGtPool(pool, included) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};
  const gtNet = (rel.network && rel.network.data && rel.network.data.id) || String(pool.id).split('_')[0];
  const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
  if (!baseId) return null;
  const address = baseId.slice(gtNet.length + 1);
  const tok = included.get(baseId);
  const chain = GT_TO_DS[gtNet] || gtNet;
  const tx = a.transactions || {};
  const pick = (w) => ({ buys: (tx[w] && tx[w].buys) || 0, sells: (tx[w] && tx[w].sells) || 0 });
  const v = a.volume_usd || {}, c = a.price_change_percentage || {};
  const symbol = (tok && tok.attributes.symbol) || String(a.name || '').split(' / ')[0];
  return {
    key: keyOf(chain, address),
    chain,
    address,
    symbol,
    name: (tok && tok.attributes.name) || symbol,
    url: `https://www.geckoterminal.com/${gtNet}/pools/${a.address}`,
    pairAddress: a.address,
    dexId: (rel.dex && rel.dex.data && rel.dex.data.id) || null,
    priceUsd: num(a.base_token_price_usd),
    liquidityUsd: num(a.reserve_in_usd),
    fdv: num(a.fdv_usd),
    marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    vol: { m5: num(v.m5) || 0, h1: num(v.h1) || 0, h6: num(v.h6) || 0, h24: num(v.h24) || 0 },
    txns: { m5: pick('m5'), h1: pick('h1'), h6: pick('h6'), h24: pick('h24') },
    chg: { m5: num(c.m5), h1: num(c.h1), h6: num(c.h6), h24: num(c.h24) },
    boostsActive: 0,
    socials: {},
    socialsUnknown: true, // GeckoTerminal nie podaje linków – nie karzemy za ich brak
    image: (tok && tok.attributes.image_url) || null,
    bondingCurve: false,
    coingeckoId: (tok && tok.attributes.coingecko_coin_id) || null,
    dataFrom: 'geckoterminal',
  };
}

// Z kilku par tego samego tokena bierzemy tę z największą płynnością
// (a gdy płynność nieznana – z największym wolumenem 24 h).
function betterPair(a, b) {
  if (!a) return b;
  const la = a.liquidityUsd || 0, lb = b.liquidityUsd || 0;
  if (la !== lb) return lb > la ? b : a;
  return (b.vol.h24 || 0) > (a.vol.h24 || 0) ? b : a;
}

// `extra` – tokeny, które chcemy odświeżyć niezależnie od list (obserwowane i te po alercie).
async function collectTokens(cfg, cache, report, extra) {
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  const tags = new Map(); // key -> Set(tag)
  const meta = new Map(); // key -> {chain,address}
  const records = new Map(); // key -> record
  const pumpInfo = new Map(); // mint -> pump data
  const metasOf = new Map(); // key -> [{slug,name,hot}]
  const topics = { metas: [], coins: [], categories: [] };
  const asked = new Set(); // klucze, o które DexScreener został skutecznie zapytany

  const want = (chain, address, tag) => {
    if (!chain || !address) return;
    const k = keyOf(chain, address);
    if (!tags.has(k)) tags.set(k, new Set());
    if (tag) tags.get(k).add(tag);
    if (!meta.has(k)) meta.set(k, { chain, address });
  };
  const run = async (name, fn) => {
    try {
      const count = await fn();
      report(name, true, count);
    } catch (e) {
      report(name, false, 0, e.message);
    }
  };
  // Dodane jako pierwsze, więc przy limicie zapytań mają pierwszeństwo.
  for (const e of extra || []) want(e.chain, e.address, null);

  // --- DexScreener: płatne promocje, nowe profile, przejęcia społeczności ----
  const dsLists = [
    ['DexScreener – top boosty', '/token-boosts/top/v1', 'ds-boost-top'],
    ['DexScreener – nowe boosty', '/token-boosts/latest/v1', 'ds-boost-new'],
    ['DexScreener – nowe profile', '/token-profiles/latest/v1', 'ds-profile'],
    ['DexScreener – przejęcia społeczności', '/community-takeovers/latest/v1', 'ds-cto'],
  ];
  await Promise.all(
    dsLists.map(([label, path, tag]) =>
      run(label, async () => {
        const arr = await fetchJson(api.dexscreener + path);
        for (const it of arr || []) want(it.chainId, it.tokenAddress, tag);
        return (arr || []).length;
      })
    )
  );

  // --- DexScreener: trendujące narracje („metas”) i tokeny w nich ------------
  await run('DexScreener – trendujące narracje', async () => {
    const metas = await fetchJson(api.dexscreener + '/metas/trending/v1');
    const list = (metas || []).map((m) => ({
      slug: m.slug,
      name: m.name,
      icon: m.icon && m.icon.type === 'emoji' ? m.icon.value : '',
      description: m.description || '',
      marketCap: num(m.marketCap),
      volume: num(m.volume),
      tokenCount: m.tokenCount,
      chg: { h1: num(m.marketCapChange && m.marketCapChange.h1), h6: num(m.marketCapChange && m.marketCapChange.h6), h24: num(m.marketCapChange && m.marketCapChange.h24) },
    }));
    for (const m of list) m.hot = (m.chg.h6 || 0) > 2 || (m.chg.h1 || 0) > 1;
    topics.metas = list;
    // Szczegóły narracji pobieramy rotacyjnie (4 na skan) i trzymamy 10 minut.
    cache.metaPairs = cache.metaPairs || new Map();
    cache.metaCursor = cache.metaCursor || 0;
    const stale = list.filter((m) => {
      const c = cache.metaPairs.get(m.slug);
      return !c || Date.now() - c.at > 10 * 60 * 1000;
    });
    const hotFirst = stale.sort((a, b) => (b.chg.h6 || 0) - (a.chg.h6 || 0)).slice(0, cfg.metasPerScan || 4);
    for (const m of hotFirst) {
      try {
        const d = await fetchJson(`${api.dexscreener}/metas/meta/v1/${encodeURIComponent(m.slug)}`);
        const top = (d.pairs || [])
          .filter((p) => p && p.baseToken)
          .sort((a, b) => ((b.volume && b.volume.h1) || 0) - ((a.volume && a.volume.h1) || 0))
          .slice(0, cfg.pairsPerMeta || 15);
        cache.metaPairs.set(m.slug, { at: Date.now(), pairs: top });
      } catch (e) {
        if (e.status === 429) break;
      }
    }
    for (const m of list) {
      const c = cache.metaPairs.get(m.slug);
      if (!c) continue;
      for (const p of c.pairs) {
        if (!p || !p.baseToken) continue;
        const rec = fromDexPair(p);
        records.set(rec.key, betterPair(records.get(rec.key), rec));
        want(rec.chain, rec.address, null);
        if (!metasOf.has(rec.key)) metasOf.set(rec.key, []);
        if (!metasOf.get(rec.key).some((x) => x.slug === m.slug)) metasOf.get(rec.key).push({ slug: m.slug, name: m.name, hot: m.hot });
      }
    }
    return list.length;
  });

  // --- CoinGecko: najczęściej wyszukiwane (co 5 minut) -----------------------
  await run('CoinGecko – najczęściej wyszukiwane', async () => {
    if (!cache.cg || Date.now() - cache.cg.at > 5 * 60 * 1000) {
      const d = await fetchJson(api.coingecko + '/search/trending');
      cache.cg = { at: Date.now(), d };
    }
    const d = cache.cg.d;
    topics.coins = (d.coins || []).map((c) => {
      const it = c.item || {};
      return {
        id: it.id,
        name: it.name,
        symbol: it.symbol,
        rank: it.market_cap_rank || null,
        chg24: num(it.data && it.data.price_change_percentage_24h && it.data.price_change_percentage_24h.usd),
        image: it.thumb || null,
        url: `https://www.coingecko.com/en/coins/${it.id}`,
      };
    });
    topics.categories = (d.categories || []).map((c) => ({
      name: c.name,
      chg24: num(c.data && c.data.market_cap_change_percentage_24h && c.data.market_cap_change_percentage_24h.usd),
    }));
    topics.cgNfts = (d.nfts || []).map((x) => ({
      name: x.name,
      symbol: x.symbol,
      floor: x.data && x.data.floor_price,
      floorChg24: num(x.floor_price_24h_percentage_change),
      vol24: x.data && x.data.h24_volume,
      image: x.thumb || null,
    }));
    return topics.coins.length;
  });
  const cgIds = new Set(topics.coins.map((c) => c.id));

  // --- GeckoTerminal: trendujące pule ze wszystkich sieci --------------------
  await run('GeckoTerminal – trendujące pule', async () => {
    let count = 0;
    // Trendy dobowe (domyślne) oraz 5-minutowe – te drugie pokazują ruch najwcześniej.
    const queries = [];
    for (let page = 1; page <= (cfg.gtPages || 2); page++) queries.push([`page=${page}`, 'gt-trending']);
    queries.push(['duration=5m&page=1', 'gt-trending-5m']);
    for (const [q, tag] of queries) {
      const d = await fetchJson(`${api.geckoterminal}/networks/trending_pools?include=base_token&${q}`, { budget: 'gt' });
      const inc = new Map((d.included || []).map((x) => [x.id, x]));
      for (const pool of d.data || []) {
        const rec = fromGtPool(pool, inc);
        if (!rec) continue;
        count++;
        records.set(rec.key, betterPair(records.get(rec.key), rec));
        want(rec.chain, rec.address, tag);
        if (rec.coingeckoId && cgIds.has(rec.coingeckoId)) tags.get(rec.key).add('cg-trending');
      }
    }
    return count;
  });

  // --- pump.fun: transmisje na żywo, najczęściej komentowane, aktywne --------
  const pumpLists = [
    ['pump.fun – na żywo', '/coins/currently-live?limit=50&offset=0&includeNsfw=false', 'pump-live'],
    ['pump.fun – najnowsze komentarze', '/coins?offset=0&limit=50&sort=last_reply&order=DESC&includeNsfw=false', 'pump-replies'],
    ['pump.fun – ostatnie transakcje', '/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false', 'pump-active'],
    ['pump.fun – świeżo po migracji', '/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false&complete=true', 'pump-migrated'],
  ];
  // pump.fun blokuje niektóre kraje (np. Wielką Brytanię) – wtedy nie pytamy go przez dobę i nie świecimy na czerwono.
  const pumpBlocked = cache.pumpBlockedUntil && Date.now() < cache.pumpBlockedUntil;
  if (pumpBlocked) {
    for (const [label] of pumpLists) report(label, true, 0);
    report('pump.fun – zablokowany w Twoim regionie (pomijam, sprawdzę ponownie za dobę)', true, 0);
  }
  await Promise.all(
    (pumpBlocked ? [] : pumpLists).map(([label, path, tag]) =>
      run(label, async () => {
        let arr;
        try {
          arr = await fetchJson(api.pumpfun + path, { headers: { origin: 'https://pump.fun', referer: 'https://pump.fun/' } });
        } catch (e) {
          if (e.status === 403 && /pump\.fun\/blocked|\/blocked/i.test(e.body || '')) cache.pumpBlockedUntil = Date.now() + 864e5;
          throw e;
        }
        for (const c of arr || []) {
          if (!c || !c.mint || c.nsfw || c.is_banned) continue;
          want('solana', c.mint, tag);
          pumpInfo.set(c.mint, {
            replyCount: c.reply_count || 0,
            live: !!c.is_currently_live,
            participants: c.num_participants || 0,
            complete: !!c.complete,
            mcUsd: num(c.usd_market_cap),
            athMcUsd: num(c.ath_market_cap), // pump.fun podaje szczyt wyceny w USD
            verdict: (c.security_verdict && c.security_verdict.verdict) || null,
            image: c.image_uri || null,
            twitter: c.twitter || null,
            telegram: c.telegram || null,
            website: c.website || null,
            url: `https://pump.fun/coin/${c.mint}`,
          });
        }
        return (arr || []).length;
      })
    )
  );

  // --- DexScreener: dane rynkowe dla wszystkich kandydatów (po 30 adresów) ---
  await run('DexScreener – dane rynkowe', async () => {
    const byChain = new Map();
    for (const { chain, address } of meta.values()) {
      if (!byChain.has(chain)) byChain.set(chain, []);
      byChain.get(chain).push(address);
    }
    const jobs = [];
    for (const [chain, list] of byChain) for (let i = 0; i < list.length; i += 30) jobs.push([chain, list.slice(i, i + 30)]);
    const todo = jobs.slice(0, cfg.maxEnrichCalls || 60);
    let got = 0, failed = 0, next = 0, stop = false;
    const worker = async () => {
      while (!stop && next < todo.length) {
        const [chain, batch] = todo[next++];
        try {
          const pairs = await fetchJson(`${api.dexscreener}/tokens/v1/${encodeURIComponent(chain)}/${batch.map(encodeURIComponent).join(',')}`);
          const wanted = new Set(batch.map((a) => keyOf(chain, a)));
          const best = new Map();
          for (const p of Array.isArray(pairs) ? pairs : []) {
            if (!p || !p.baseToken) continue;
            const rec = fromDexPair(p);
            if (!wanted.has(rec.key)) continue; // token jest w tej parze tylko walutą kwotowaną
            best.set(rec.key, betterPair(best.get(rec.key), rec));
          }
          for (const [k, rec] of best) {
            records.set(k, rec); // dane DexScreenera zastępują te z GeckoTerminal
            got++;
          }
          for (const k of wanted) asked.add(k);
        } catch (e) {
          failed++;
          if (e.status === 429) stop = true;
        }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker)); // cztery zapytania naraz
    if (todo.length && failed === todo.length) throw new Error('żadne zapytanie się nie powiodło');
    return got;
  });

  // --- Złożenie wyniku --------------------------------------------------------
  const out = [];
  for (const [k, rec] of records) {
    if (SKIP_SYMBOLS.has(String(rec.symbol || '').toUpperCase())) continue;
    if ((rec.vol.h24 || 0) < (cfg.minVolume24hUsd == null ? 1000 : cfg.minVolume24hUsd)) continue;
    rec.sources = [...(tags.get(k) || [])];
    rec.metas = metasOf.get(k) || [];
    const p = rec.chain === 'solana' ? pumpInfo.get(rec.address) : null;
    if (p) {
      rec.pump = p;
      rec.pumpUrl = p.url;
      if (!rec.image) rec.image = p.image;
      rec.socials = Object.assign({ twitter: p.twitter, telegram: p.telegram, website: p.website }, rec.socials);
      for (const s of ['twitter', 'telegram', 'website']) if (!rec.socials[s]) delete rec.socials[s];
      if (!p.complete && rec.liquidityUsd == null) rec.bondingCurve = true;
    } else if (rec.chain === 'solana' && /pump$/.test(rec.address)) {
      rec.pumpUrl = `https://pump.fun/coin/${rec.address}`;
    }
    rec.isPump = !!(p || rec.pumpUrl || /^pump/.test(rec.dexId || ''));
    out.push(rec);
  }
  return { tokens: out, topics, all: records, asked };
}

// ---- GeckoTerminal: unikalni kupujący dla wybranych tokenów ------------------

const DS_TO_GT = Object.fromEntries(Object.entries(GT_TO_DS).map(([g, d]) => [d, g]));

// DexScreener liczy transakcje, GeckoTerminal także portfele. Pytamy tylko o tokeny
// z czołówki (do `maxCalls` zapytań po 30 pul), wynik pamiętamy 3 minuty.
async function annotateUniq(tokens, cfg, cache, report, maxCalls = 3) {
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  cache.uniq = cache.uniq || new Map();
  cache.gtBadNet = cache.gtBadNet || new Map();
  const now = Date.now();
  const apply = (t, c) => {
    if (c.uniq) t.uniq = c.uniq;
    if (c.locked != null) t.lockedLiqPct = c.locked;
  };
  const need = new Map();
  for (const t of tokens) {
    if (!t.pairAddress) continue;
    const c = cache.uniq.get(t.key);
    if (c && now - c.at < 3 * 60 * 1000) {
      apply(t, c);
      continue;
    }
    const net = DS_TO_GT[t.chain] || t.chain;
    const bad = cache.gtBadNet.get(net);
    if (bad && now - bad < 3.6e6) continue;
    if (!need.has(net)) need.set(net, []);
    need.get(net).push(t);
  }
  let calls = 0, ok = 0, failed = 0;
  outer: for (const [net, list] of [...need].sort((a, b) => b[1].length - a[1].length)) {
    for (let i = 0; i < list.length; i += 30) {
      if (calls >= maxCalls) break outer;
      const batch = list.slice(i, i + 30);
      calls++;
      try {
        const d = await fetchJson(`${api.geckoterminal}/networks/${encodeURIComponent(net)}/pools/multi/${batch.map((t) => encodeURIComponent(t.pairAddress)).join(',')}`, { budget: 'gt', optional: true });
        const byAddr = new Map((d.data || []).map((p) => [String(p.attributes.address).toLowerCase(), p.attributes]));
        for (const t of batch) {
          const a = byAddr.get(String(t.pairAddress).toLowerCase());
          const entry = { at: now, uniq: null, locked: null };
          if (a && a.transactions) {
            const u = {};
            for (const w of ['m5', 'm15', 'm30', 'h1', 'h6', 'h24']) {
              const x = a.transactions[w];
              if (x && x.buyers != null && x.sellers != null) u[w] = { buyers: x.buyers, sellers: x.sellers };
            }
            if (u.h1) entry.uniq = u;
            entry.locked = num(a.locked_liquidity_percentage);
            if (entry.uniq) ok++;
          }
          cache.uniq.set(t.key, entry);
          apply(t, entry);
        }
      } catch (e) {
        if (e.budget) break outer;
        failed++;
        if (e.status === 404) cache.gtBadNet.set(net, now); // GeckoTerminal nie zna tej sieci pod tą nazwą
        if (e.status === 429) break outer;
      }
    }
  }
  for (const [k, v] of cache.uniq) if (now - v.at > 30 * 60 * 1000) cache.uniq.delete(k);
  if (calls) report('GeckoTerminal – unikalni kupujący', ok > 0 || failed === 0, ok, failed ? `${failed} nieudanych` : undefined);
}

// ---- GeckoTerminal: szczyt i dołek ze świec godzinowych (pomiary 72 h i 7 dni) ----

async function candleExtremes(cfg, a, from, to) {
  if (!a.pair) return null;
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  const net = DS_TO_GT[a.chain] || a.chain;
  const hours = Math.ceil((to - from) / 3.6e6) + 2;
  const q = `aggregate=1&limit=${Math.min(1000, hours)}&currency=usd&token=base&before_timestamp=${Math.ceil(to / 1000) + 3600}`;
  const d = await fetchJson(`${api.geckoterminal}/networks/${encodeURIComponent(net)}/pools/${encodeURIComponent(a.pair)}/ohlcv/hour?${q}`, { budget: 'gt', optional: true });
  const list = d && d.data && d.data.attributes && d.data.attributes.ohlcv_list;
  return require('./outcomes').extremesFromCandles(list, from, to);
}

// ---- Dane dodatkowe przy alercie --------------------------------------------

const apiOf = (cfg) => Object.assign({}, API_DEFAULTS, cfg.api || {});
const gtNet = (chain) => DS_TO_GT[chain] || chain;

// Posiadacze z GeckoTerminal (liczba i udział największych portfeli). Pole jest w becie – gdy go brak, zwracamy null.
async function tokenHolders(cfg, chain, address) {
  const d = await fetchJson(`${apiOf(cfg).geckoterminal}/networks/${encodeURIComponent(gtNet(chain))}/tokens/${encodeURIComponent(address)}/info`, { budget: 'gt', optional: true });
  const h = d && d.data && d.data.attributes && d.data.attributes.holders;
  if (!h || h.count == null || !Number.isFinite(Number(h.count))) return null;
  const dist = {};
  for (const [k, v] of Object.entries(h.distribution_percentage || {})) dist[k] = num(v);
  return { count: Number(h.count), top10: dist.top_10 == null ? null : dist.top_10, dist, src: 'gt' };
}

// Ostatnie ~300 transakcji puli (do 24 h): rozkład kwot, duzi kupujący, koncentracja portfeli.
async function poolTrades(cfg, chain, pair, now = Date.now()) {
  const d = await fetchJson(`${apiOf(cfg).geckoterminal}/networks/${encodeURIComponent(gtNet(chain))}/pools/${encodeURIComponent(pair)}/trades`, { budget: 'gt', optional: true });
  return tradesSummary((d && d.data) || [], now);
}

function tradesSummary(list, now = Date.now()) {
  const tr = list
    .map((x) => x && x.attributes)
    .filter(Boolean)
    .map((a) => ({ kind: a.kind, usd: num(a.volume_in_usd), from: a.tx_from_address || null, t: Date.parse(a.block_timestamp) }))
    .filter((x) => x.usd != null && (x.kind === 'buy' || x.kind === 'sell'));
  if (!tr.length) return null;
  const q = (v, p) => {
    const s = v.slice().sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null;
  };
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const stat = (arr) => {
    const v = arr.map((x) => x.usd);
    const sum = v.reduce((s, x) => s + x, 0);
    return { n: v.length, sum: r2(sum), avg: v.length ? r2(sum / v.length) : null, med: r2(q(v, 0.5)), p90: r2(q(v, 0.9)), max: r2(v.length ? Math.max(...v) : null) };
  };
  const EDGES = [50, 500, 5000];
  const buckets = (arr) => {
    const b = [0, 0, 0, 0];
    for (const x of arr) b[x.usd < EDGES[0] ? 0 : x.usd < EDGES[1] ? 1 : x.usd < EDGES[2] ? 2 : 3]++;
    return b;
  };
  const buys = tr.filter((x) => x.kind === 'buy'), sells = tr.filter((x) => x.kind === 'sell');
  const byWallet = new Map(), cnt = new Map();
  for (const x of buys) if (x.from) { byWallet.set(x.from, (byWallet.get(x.from) || 0) + x.usd); cnt.set(x.from, (cnt.get(x.from) || 0) + 1); }
  const buySum = buys.reduce((s, x) => s + x.usd, 0);
  const top5 = [...byWallet.values()].sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0);
  const ts = tr.map((x) => x.t).filter(Number.isFinite);
  return {
    n: tr.length,
    spanMin: ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 60000) : null,
    lastMinAgo: ts.length ? Math.round((now - Math.max(...ts)) / 60000) : null,
    buy: stat(buys), sell: stat(sells),
    bucketsBuy: buckets(buys), bucketsSell: buckets(sells), // < $50 | $50–500 | $500–5 tys. | ≥ $5 tys.
    whales: buys.filter((x) => x.usd >= 5000).length,
    uniqueBuyers: byWallet.size,
    uniqueSellers: new Set(sells.map((x) => x.from).filter(Boolean)).size,
    repeatBuyers: [...cnt.values()].filter((c) => c >= 3).length,
    top5Share: buySum > 0 ? Math.round((1000 * top5) / buySum) / 10 : null,
    netUsd: r2(buySum - sells.reduce((s, x) => s + x.usd, 0)),
  };
}

// Pełny raport RugCheck (Solana): posiadacze, insiderzy, twórca, zablokowana płynność. Pola nieudokumentowane –
// czytamy je ostrożnie i zapisujemy tylko to, co przyszło.
async function rugcheckReport(cfg, mint) {
  const d = await fetchJson(`${apiOf(cfg).rugcheck}/v1/tokens/${encodeURIComponent(mint)}/report`, { timeout: 20000 });
  return rugcheckInfo(d);
}
function rugcheckInfo(d) {
  if (!d || typeof d !== 'object') return null;
  const pctOf = (h) => num(h && (h.pct != null ? h.pct : h.percentage));
  const top = Array.isArray(d.topHolders) ? d.topHolders : [];
  const sum = (arr) => Math.round(arr.reduce((s, h) => s + (pctOf(h) || 0), 0) * 10) / 10;
  const nets = Array.isArray(d.insiderNetworks) ? d.insiderNetworks : [];
  const lps = (Array.isArray(d.markets) ? d.markets : []).map((m) => num(m && m.lp && m.lp.lpLockedPct)).filter((x) => x != null);
  let creatorPct = null;
  const supply = num(d.token && d.token.supply);
  const cb = num(d.creatorBalance);
  if (supply > 0 && cb != null) creatorPct = Math.round((10000 * cb) / supply) / 100;
  return {
    holders: num(d.totalHolders),
    top10Pct: top.length ? sum(top.slice(0, 10)) : null,
    insiderPctTop: top.length ? sum(top.filter((h) => h && h.insider)) : null,
    insiderHoldersTop: top.filter((h) => h && h.insider).length,
    insidersDetected: num(d.graphInsidersDetected),
    insiderNetworks: nets.length,
    insiderNetSizes: nets.map((n) => num(n && n.size)).filter((x) => x != null).slice(0, 5),
    creatorPct,
    lpLockedPct: lps.length ? Math.max(...lps) : num(d.lpLockedPct),
    rugged: d.rugged === true,
    score: num(d.score_normalised != null ? d.score_normalised : d.score),
  };
}

// Kontekst rynku: BTC, ETH, SOL, BNB (zmiana 1 h i 24 h), odświeżany co 5 minut.
const MARKET_IDS = { bitcoin: 'btc', ethereum: 'eth', solana: 'sol', binancecoin: 'bnb' };
async function marketContext(cfg, cache) {
  if (cache.market && Date.now() - cache.market.at < 5 * 60e3) return cache.market;
  const d = await fetchJson(`${apiOf(cfg).coingecko}/coins/markets?vs_currency=usd&ids=${Object.keys(MARKET_IDS).join(',')}&price_change_percentage=1h,24h`);
  const r1 = (x) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 10) / 10);
  const m = { at: Date.now() };
  for (const c of Array.isArray(d) ? d : []) {
    const k = MARKET_IDS[c.id];
    if (k) m[k] = { p: num(c.current_price), h1: r1(c.price_change_percentage_1h_in_currency), h24: r1(c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h) };
  }
  cache.market = m;
  return m;
}

// Liczba członków publicznego kanału/grupy Telegram (link z profilu tokena) – przez naszego bota.
function tgName(link) {
  const m = String(link || '').match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{5,32})(?:[/?#]|$)/i);
  if (!m || /^(joinchat|addlist|share|iv)$/i.test(m[1])) return null;
  return m[1];
}
async function tgMembers(cfg, link) {
  const name = tgName(link);
  if (!name || !cfg.telegram || !cfg.telegram.token) return null;
  try {
    const d = await fetchJson(`${apiOf(cfg).telegram}/bot${cfg.telegram.token}/getChatMemberCount?chat_id=${encodeURIComponent('@' + name)}`, { timeout: 8000 });
    return d && d.ok && Number.isFinite(d.result) ? d.result : null;
  } catch (e) {
    if (e.status === 400 || e.status === 403) return null; // prywatny albo nieistniejący kanał
    throw e;
  }
}

// ---- NFT: OpenSea -----------------------------------------------------------

async function openseaKey(cfg, state) {
  if (cfg.opensea && cfg.opensea.apiKey) return cfg.opensea.apiKey;
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  const k = state.openseaKey;
  // Darmowy klucz „bez rejestracji” wygasa po 7 dniach – odnawiamy dzień wcześniej.
  if (k && k.key && Date.parse(k.expires) - Date.now() > 24 * 3600 * 1000) return k.key;
  const d = await fetchJson(api.opensea + '/auth/keys', { method: 'POST' });
  if (!d.api_key) throw new Error('OpenSea nie zwróciło klucza');
  state.openseaKey = { key: d.api_key, expires: d.expires_at || new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString() };
  return d.api_key;
}

async function collectNfts(cfg, state, cache, report) {
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  const cols = new Map();
  let key;
  try {
    key = await openseaKey(cfg, state);
  } catch (e) {
    report('OpenSea – klucz API', false, 0, e.message);
    return [];
  }
  const headers = { 'x-api-key': key };
  const limit = cfg.nftLimit || 15;
  for (const [tf, field, label] of [['one_hour', 'rank1h', 'OpenSea – trendy 1 h'], ['one_day', 'rank1d', 'OpenSea – trendy 24 h']]) {
    try {
      const d = await fetchJson(`${api.opensea}/collections/trending?timeframe=${tf}&limit=${limit}`, { headers });
      (d.collections || []).forEach((c, i) => {
        if (!c || !c.collection || c.is_nsfw || c.is_disabled) return;
        const cur = cols.get(c.collection) || {
          slug: c.collection,
          name: c.name || c.collection,
          image: c.image_url || null,
          url: c.opensea_url || `https://opensea.io/collection/${c.collection}`,
          category: c.category || null,
          twitter: c.twitter_username || null,
          chain: (c.contracts && c.contracts[0] && c.contracts[0].chain) || null,
          verified: c.safelist_status === 'verified',
        };
        cur[field] = i + 1;
        cols.set(c.collection, cur);
      });
      report(label, true, (d.collections || []).length);
    } catch (e) {
      if (e.status === 401 || e.status === 403) delete state.openseaKey; // klucz wygasł – następnym razem weźmiemy nowy
      report(label, false, 0, e.message);
    }
  }
  cache.nftStats = cache.nftStats || new Map();
  let ok = 0, bad = 0;
  for (const c of cols.values()) {
    let st = cache.nftStats.get(c.slug);
    if (!st || Date.now() - st.at > 9 * 60 * 1000) {
      try {
        const d = await fetchJson(`${api.opensea}/collections/${encodeURIComponent(c.slug)}/stats`, { headers });
        st = { at: Date.now(), d };
        cache.nftStats.set(c.slug, st);
        ok++;
        await sleep(120);
      } catch (e) {
        bad++;
        if (e.status === 429) break;
        continue;
      }
    }
    const tot = st.d.total || {};
    const iv = Object.fromEntries((st.d.intervals || []).map((x) => [x.interval, x]));
    c.floor = num(tot.floor_price);
    c.symbol = tot.floor_price_symbol || tot.volume_symbol || '';
    c.owners = tot.num_owners == null ? null : tot.num_owners;
    c.vol1d = num(iv.one_day && iv.one_day.volume) || 0;
    c.sales1d = (iv.one_day && iv.one_day.sales) || 0;
    c.vol7d = num(iv.seven_day && iv.seven_day.volume) || 0;
    c.sales7d = (iv.seven_day && iv.seven_day.sales) || 0;
    c.vol30d = num(iv.thirty_day && iv.thirty_day.volume) || 0;
    c.hasStats = true;
  }
  report('OpenSea – statystyki kolekcji', bad === 0 || ok > 0, ok, bad ? `${bad} nieudanych` : undefined);
  return [...cols.values()].filter((c) => c.hasStats);
}

module.exports = { collectTokens, collectNfts, annotateUniq, candleExtremes, tokenHolders, poolTrades, tradesSummary, rugcheckReport, rugcheckInfo, marketContext, tgMembers, tgName, budgetLeft, setBudget, fetchJson, backoffState, hostBlock, API_DEFAULTS, keyOf, fromDexPair, fromGtPool, sleep, GT_TO_DS };
