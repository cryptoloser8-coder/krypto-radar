'use strict';
// Atrapa zewnętrznych API do testów bez internetu. Kształt odpowiedzi odwzorowuje
// prawdziwe odpowiedzi DexScreener, GeckoTerminal, CoinGecko, pump.fun, OpenSea,
// RugCheck, GoPlus i Telegrama (sprawdzone 6.10.2026).
const http = require('http');

const NOW = Date.now();
const H = 3.6e6;

function pair(o) {
  return {
    chainId: o.chain, dexId: o.dex || 'raydium', url: `https://dexscreener.com/${o.chain}/${o.pair || 'pair' + o.sym}`.toLowerCase(),
    pairAddress: o.pair || 'pair' + o.sym, baseToken: { address: o.addr, name: o.name || o.sym + ' Token', symbol: o.sym },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
    priceUsd: String(o.price || 0.0000123),
    txns: { m5: { buys: o.b5 || 0, sells: o.s5 || 0 }, h1: { buys: o.b1, sells: o.s1 }, h6: { buys: o.b1 * 3, sells: o.s1 * 3 }, h24: { buys: o.b24 || o.b1 * 6, sells: o.s24 || o.s1 * 6 } },
    volume: { m5: o.v5 || 0, h1: o.v1, h6: o.v6, h24: o.v24 },
    priceChange: { h1: o.c1, h6: o.c6, h24: o.c24 },
    ...(o.liq == null ? {} : { liquidity: { usd: o.liq, base: 1, quote: 1 } }),
    fdv: o.fdv, marketCap: o.fdv, pairCreatedAt: NOW - o.ageH * H,
    ...(o.social ? { info: { imageUrl: 'https://example.com/i.png', websites: [{ url: 'https://example.com', label: 'Website' }], socials: [{ url: 'https://x.com/' + o.sym, type: 'twitter' }, { url: o.tg || 'https://t.me/' + o.sym.toLowerCase() + '_portal', type: 'telegram' }] } } : {}),
    ...(o.boost ? { boosts: { active: o.boost } } : {}),
  };
}

const GOOD = 'GoodMint1111111111111111111111111111111pump';
const NEWRH = '0x7777000000000000000000000000000000007777'; // nowy token na Robinhood (15 min, płynność 50 tys. $)
const CURVE = 'CurveMint111111111111111111111111111111pump';
const RUG = '0x1111111111111111111111111111111111111111';
const HONEY = '0x2222222222222222222222222222222222222222';
const DUMP = 'DumpMint11111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EARLY = '0x3333333333333333333333333333333333333333';

const PAIRS = {
  solana: [
    pair({ chain: 'solana', dex: 'pumpswap', sym: 'GOOD', addr: GOOD, b1: 650, s1: 350, v5: 20000, v1: 150000, v6: 300000, v24: 500000, c1: 24, c6: 45, c24: 80, liq: 120000, fdv: 2000000, ageH: 10, social: true, boost: 50 }),
    // druga, słabsza para tego samego tokena – nie powinna wygrać
    pair({ chain: 'solana', dex: 'meteora', sym: 'GOOD', addr: GOOD, pair: 'pairGOOD2', b1: 5, s1: 5, v1: 900, v6: 2000, v24: 4000, c1: 1, c6: 1, c24: 1, liq: 9000, fdv: 2000000, ageH: 9 }),
    pair({ chain: 'solana', dex: 'pumpfun', sym: 'CURVE', addr: CURVE, b1: 300, s1: 200, v5: 3000, v1: 40000, v6: 40000, v24: 40000, c1: 60, c6: 60, c24: 60, liq: null, fdv: 45000, ageH: 0.5 }),
    pair({ chain: 'solana', sym: 'DUMP', addr: DUMP, b1: 100, s1: 400, v1: 90000, v6: 200000, v24: 400000, c1: -62, c6: -70, c24: -40, liq: 60000, fdv: 500000, ageH: 30, social: true, tg: 'https://t.me/+AbCdEf123456' }),
    pair({ chain: 'solana', sym: 'USDC', addr: USDC, b1: 900, s1: 900, v1: 9e6, v6: 5e7, v24: 2e8, c1: 0, c6: 0, c24: 0, liq: 5e7, fdv: 5e10, ageH: 9000, social: true }),
  ],
  ethereum: [pair({ chain: 'ethereum', dex: 'uniswap', sym: 'RUG', addr: RUG, b1: 80, s1: 40, v1: 30000, v6: 60000, v24: 90000, c1: 40, c6: 90, c24: 300, liq: 3000, fdv: 900000, ageH: 5 })],
  base: [
    // Wczesny sygnał: wolumen 3,3× średniej, cena prawie stoi, mała wycena, sensowna płynność.
    pair({ chain: 'base', dex: 'aerodrome', sym: 'EARLY', addr: EARLY, pair: '0xPoolEarly', b1: 90, s1: 50, v5: 1500, v1: 12000, v6: 18000, v24: 18000, c1: 4, c6: 10, c24: 12, liq: 60000, fdv: 400000, ageH: 5, social: true }),
    pair({ chain: 'base', dex: 'aerodrome', sym: 'HONEY', addr: HONEY, b1: 700, s1: 100, v5: 30000, v1: 200000, v6: 350000, v24: 600000, c1: 35, c6: 70, c24: 150, liq: 200000, fdv: 3000000, ageH: 20, social: true, tg: 'https://t.me/honey_nope' }),
  ],
};

const sent = [];
// Obcy pisze do bota pierwszy, a kod parowania przychodzi też z grupy – obie wiadomości mają być pominięte.
const updates = [
  { update_id: 1, message: { chat: { id: 999, type: 'private', first_name: 'Obcy' }, text: '/start' } },
  { update_id: 2, message: { chat: { id: 424242, type: 'private', first_name: 'Kuba' }, text: '123 456' } },
  { update_id: 3, message: { chat: { id: -100777, type: 'group', title: 'Grupa' }, text: '123456' } },
  { update_id: 4, message: { chat: { id: 999, type: 'private', first_name: 'Obcy' }, text: 'halo' } },
];
let failSends = 0;
let tgCalls = 0;
let gt429 = 0; // tyle następnych zapytań o trendy GeckoTerminal dostaje 429
// Liczba posiadaczy rośnie z każdym zapytaniem – żeby test widział przyrost przed alertem.
const holderAsks = new Map();
const holderCount = (addr) => {
  holderAsks.set(addr, (holderAsks.get(addr) || 0) + 1);
  return 1000 + holderAsks.get(addr) * 25;
};
const docs = []; // pliki wysłane przez sendDocument (surowe ciało multipart) // ile kolejnych wiadomości Telegram ma „nie dojść”
let osKeys = 0;

const routes = [
  [/^\/ds\/token-boosts\/top\/v1$/, () => [{ url: 'x', chainId: 'solana', tokenAddress: GOOD, totalAmount: 500 }, { url: 'x', chainId: 'ethereum', tokenAddress: RUG, totalAmount: 100 }]],
  [/^\/ds\/token-boosts\/latest\/v1$/, () => [{ url: 'x', chainId: 'base', tokenAddress: HONEY, amount: 10, totalAmount: 10 }]],
  [/^\/ds\/token-profiles\/latest\/v1$/, () => [{ url: 'x', chainId: 'solana', tokenAddress: DUMP }, { url: 'x', chainId: 'solana', tokenAddress: USDC }]],
  [/^\/ds\/community-takeovers\/latest\/v1$/, () => []],
  [/^\/ds\/metas\/trending\/v1$/, () => [{ description: 'Furry friends', icon: { type: 'emoji', value: '🐶' }, name: 'Dog', slug: 'dog', marketCap: 1.2e9, liquidity: 8e7, volume: 3.2e7, tokenCount: 77, marketCapChange: { m5: 0.1, h1: 1.5, h6: 4.2, h24: -2.9 }, marketCapDelta: {} },
    { description: 'pspsps', icon: { type: 'emoji', value: '🐈' }, name: 'Cat', slug: 'cat', marketCap: 7e8, liquidity: 6e7, volume: 1.7e7, tokenCount: 101, marketCapChange: { m5: 0, h1: -0.6, h6: -2.1, h24: -0.7 }, marketCapDelta: {} }]],
  [/^\/ds\/metas\/meta\/v1\/dog$/, () => ({ name: 'Dog', slug: 'dog', pairs: [PAIRS.base.find((p) => p.baseToken.symbol === 'HONEY')] })],
  [/^\/ds\/metas\/meta\/v1\/cat$/, () => ({ name: 'Cat', slug: 'cat', pairs: [] })],
  [/^\/ds\/tokens\/v1\/([^/]+)\/(.+)$/, (m) => {
    const chain = decodeURIComponent(m[1]);
    if (!PAIRS[chain]) return { __status: 404, error: 'unknown chain' };
    const want = new Set(decodeURIComponent(m[2]).split(',').map((x) => x.toLowerCase()));
    return PAIRS[chain].filter((p) => want.has(p.baseToken.address.toLowerCase()));
  }],
  [/^\/gt\/networks\/trending_pools$/, (m, q) => (gt429 > 0 && gt429-- ? { __status: 429, status: { error_code: 429, error_message: "You've exceeded the Rate Limit." } } : q.get('duration') === '5m' ? {
    data: [{ id: 'base_0xpoolearly', type: 'pool', attributes: { address: '0xpoolearly', name: 'EARLY / WETH', base_token_price_usd: '0.0000123', fdv_usd: '400000', market_cap_usd: '400000', reserve_in_usd: '60000', pool_created_at: new Date(NOW - 5 * H).toISOString(), price_change_percentage: { m5: '1', h1: '4', h6: '10', h24: '12' }, transactions: { m5: { buys: 8, sells: 4 }, h1: { buys: 90, sells: 50, buyers: 70, sellers: 30 }, h6: { buys: 270, sells: 150 }, h24: { buys: 540, sells: 300 } }, volume_usd: { m5: '1500', h1: '12000', h6: '18000', h24: '18000' } },
      relationships: { base_token: { data: { id: 'base_' + EARLY, type: 'token' } }, network: { data: { id: 'base', type: 'network' } }, dex: { data: { id: 'aerodrome', type: 'dex' } } } }],
    included: [{ id: 'base_' + EARLY, type: 'token', attributes: { address: EARLY, name: 'EARLY Token', symbol: 'EARLY', coingecko_coin_id: null, image_url: null } }],
  } : q.get('page') !== '1' ? { data: [] } : {
    data: [
      { id: 'solana_pairGOOD', type: 'pool', attributes: { address: 'pairGOOD', name: 'GOOD / SOL', base_token_price_usd: '0.0000123', fdv_usd: '2000000', market_cap_usd: null, reserve_in_usd: '119000', pool_created_at: new Date(NOW - 10 * H).toISOString(), price_change_percentage: { m5: '1', m15: '2', m30: '3', h1: '24', h6: '45', h24: '80' }, transactions: { m5: { buys: 60, sells: 30 }, h1: { buys: 650, sells: 350, buyers: 400, sellers: 200 }, h6: { buys: 1950, sells: 1050 }, h24: { buys: 3900, sells: 2100 } }, volume_usd: { m5: '20000', h1: '150000', h6: '300000', h24: '500000' } },
        relationships: { base_token: { data: { id: 'solana_' + GOOD, type: 'token' } }, network: { data: { id: 'solana', type: 'network' } }, dex: { data: { id: 'pumpswap', type: 'dex' } } } },
      { id: 'robinhood_0xpool', type: 'pool', attributes: { address: '0xpool', name: 'ROO / WETH', base_token_price_usd: '0.000133', fdv_usd: '134329.79', market_cap_usd: '134329.79', reserve_in_usd: '23029.54', pool_created_at: new Date(NOW - 300 * H).toISOString(), price_change_percentage: { m5: '-1.4', h1: '-12.2', h6: '-7.1', h24: '-17.8' }, transactions: { m5: { buys: 37, sells: 37 }, h1: { buys: 498, sells: 513 }, h6: { buys: 2259, sells: 2136 }, h24: { buys: 9982, sells: 9415 } }, volume_usd: { m5: '1444.4', h1: '20516.8', h6: '97193.1', h24: '494884.4' } },
        relationships: { base_token: { data: { id: 'robinhood_0x3458e003f6ed93df0f537b8acac6fbe08e41247f', type: 'token' } }, network: { data: { id: 'robinhood', type: 'network' } }, dex: { data: { id: 'uniswap-v4-robinhood', type: 'dex' } } } },
      { id: 'robinhood_0xpoolnew', type: 'pool', attributes: { address: '0xpoolnew', name: 'NEWRH / WETH', base_token_price_usd: '0.0021', fdv_usd: '210000', market_cap_usd: '210000', reserve_in_usd: '50000', pool_created_at: new Date(NOW - 15 * 60e3).toISOString(), price_change_percentage: { m5: '12', h1: '140', h6: '140', h24: '140' }, transactions: { m5: { buys: 60, sells: 30 }, h1: { buys: 300, sells: 140 }, h6: { buys: 300, sells: 140 }, h24: { buys: 300, sells: 140 } }, volume_usd: { m5: '9000', h1: '60000', h6: '60000', h24: '60000' } },
        relationships: { base_token: { data: { id: 'robinhood_' + NEWRH, type: 'token' } }, network: { data: { id: 'robinhood', type: 'network' } }, dex: { data: { id: 'uniswap-v4-robinhood', type: 'dex' } } } },
    ],
    included: [
      { id: 'solana_' + GOOD, type: 'token', attributes: { address: GOOD, name: 'GOOD Token', symbol: 'GOOD', coingecko_coin_id: null, image_url: 'https://example.com/g.png' } },
      { id: 'robinhood_0x3458e003f6ed93df0f537b8acac6fbe08e41247f', type: 'token', attributes: { address: '0x3458e003f6ed93df0f537b8acac6fbe08e41247f', name: 'Roo', symbol: 'ROO', coingecko_coin_id: 'roo', image_url: 'https://example.com/r.png' } },
      { id: 'robinhood_' + NEWRH, type: 'token', attributes: { address: NEWRH, name: 'New Robin', symbol: 'NEWRH', coingecko_coin_id: null, image_url: null } },
    ],
  })],
  // Unikalni kupujący: dane tylko dla puli EARLY; dla pozostałych pusta lista.
  // Świece godzinowe dla pomiaru 72 h (alert sprzed 72 h 5 min): szczyt 0,0000246, dołek 0,000003;
  // ostatnia świeca jest już po końcu okna i nie może się liczyć.
  [/^\/gt\/networks\/solana\/pools\/POOLOLD\/ohlcv\/hour$/, () => {
    const n = Date.now() / 1000;
    return { data: { attributes: { ohlcv_list: [[n - 60, 1, 0.009, 0.0000001, 1, 1], [n - 40 * 3600, 1, 0.0000246, 0.000005, 1, 1], [n - 70 * 3600, 1, 0.00001, 0.000003, 1, 1]] } } };
  }],
  [/^\/gt\/networks\/([^/]+)\/pools\/multi\/(.+)$/, (m) => ({
    data: m[1] === 'base' && decodeURIComponent(m[2]).toLowerCase().split(',').includes('0xpoolearly')
      ? [{ id: 'base_0xpoolearly', type: 'pool', attributes: { address: '0xpoolearly', locked_liquidity_percentage: '100.0', transactions: { m5: { buys: 8, sells: 4, buyers: 7, sellers: 3 }, h1: { buys: 90, sells: 50, buyers: 70, sellers: 30 } } }, relationships: {} }]
      : [],
  })],
  // Kontekst rynku.
  [/^\/cg\/coins\/markets$/, () => [
    { id: 'bitcoin', current_price: 60000, price_change_percentage_1h_in_currency: 0.4, price_change_percentage_24h_in_currency: -1.2 },
    { id: 'ethereum', current_price: 2500, price_change_percentage_1h_in_currency: 0.1, price_change_percentage_24h_in_currency: 2.5 },
    { id: 'solana', current_price: 150, price_change_percentage_1h_in_currency: 1.25, price_change_percentage_24h_in_currency: 5.04 },
    { id: 'binancecoin', current_price: 600, price_change_percentage_1h_in_currency: -0.2, price_change_percentage_24h_in_currency: 0 },
  ]],
  // Pełny raport RugCheck (Solana): posiadacze, insiderzy, twórca, płynność.
  [/^\/rc\/v1\/tokens\/([^/]+)\/report$/, () => ({
    totalHolders: 1234, graphInsidersDetected: 7, rugged: false, score_normalised: 12,
    token: { supply: 1000000000 }, creatorBalance: 25000000,
    topHolders: [{ pct: 10, insider: true }, { pct: 5 }, { pct: 4, insider: true }],
    insiderNetworks: [{ size: 4 }, { size: 3 }],
    markets: [{ lp: { lpLockedPct: 99.5 } }],
  })],
  // Posiadacze z GeckoTerminal (beta) i ostatnie transakcje puli.
  [/^\/gt\/networks\/([^/]+)\/tokens\/([^/]+)\/info$/, (m) => ({ data: { attributes: { holders: { count: holderCount(m[2]), distribution_percentage: { top_10: '31.5', '11_30': '12', '31_50': '5', rest: '51.5' }, last_updated: '2026-10-11T12:00:00Z' } } } })],
  [/^\/gt\/networks\/([^/]+)\/pools\/([^/]+)\/trades$/, () => ({ data: [
    ...[20, 60, 120, 900, 6000, 30, 45].map((v, i) => ({ attributes: { kind: 'buy', volume_in_usd: String(v), tx_from_address: i < 3 ? 'w1' : 'w' + i, block_timestamp: new Date(Date.now() - i * 60e3).toISOString() } })),
    ...[100, 300].map((v, i) => ({ attributes: { kind: 'sell', volume_in_usd: String(v), tx_from_address: 's' + i, block_timestamp: new Date(Date.now() - (10 + i) * 60e3).toISOString() } })),
  ] })],
  // Członkowie publicznego kanału Telegram.
  [/^\/tg\/bot([^/]+)\/getChat$/, (m, q) => {
    const id = q.get('chat_id');
    if (!/_portal$/.test(id)) return { __status: 400, ok: false, error_code: 400, description: 'Bad Request: chat not found' };
    return { ok: true, result: { id: -1001, type: 'channel', title: id.slice(1).replace('_portal', '').toUpperCase() + ' Portal', username: id.slice(1) } };
  }],
  [/^\/tg\/bot([^/]+)\/getChatMemberCount$/, (m, q) => ({ ok: true, result: 500 + (++tgCalls) * 10 })],
  [/^\/cg\/search\/trending$/, () => ({
    coins: [{ item: { id: 'roo', coin_id: 1, name: 'Roo', symbol: 'ROO', market_cap_rank: 900, thumb: 'https://example.com/r.png', data: { price_change_percentage_24h: { usd: -17.8 }, total_volume: '$1' } } }],
    nfts: [{ id: 'moonbirds', name: 'Moonbirds', symbol: 'MOONBIRD', floor_price_24h_percentage_change: 5.36, thumb: 'https://example.com/m.png', data: { floor_price: '0.42 ETH', h24_volume: '6.05 ETH' } }],
    categories: [{ name: 'Memes', data: { market_cap_change_percentage_24h: { usd: 3.1 } } }],
  })],
  [/^\/pf\/coins\/currently-live$/, () => [{ mint: CURVE, name: 'Curve Coin', symbol: 'CURVE', image_uri: 'https://example.com/c.png', created_timestamp: NOW - 0.5 * H, complete: false, market_cap: 380, usd_market_cap: 45000, ath_market_cap: 52000, reply_count: 800, is_currently_live: true, num_participants: 120, nsfw: false, is_banned: false, security_verdict: { verdict: 'allow' }, twitter: 'https://x.com/curve' }]],
  [/^\/pf\/coins$/, (m, q) => (q.get('sort') === 'last_reply' ? [{ mint: CURVE, name: 'Curve Coin', symbol: 'CURVE', complete: false, market_cap: 380, usd_market_cap: 45000, ath_market_cap: 52000, reply_count: 800, is_currently_live: true, num_participants: 120, security_verdict: { verdict: 'allow' }, twitter: 'https://x.com/curve' }] : [{ mint: GOOD, name: 'GOOD Token', symbol: 'GOOD', complete: true, market_cap: 16000, usd_market_cap: 2000000, ath_market_cap: 2500000, reply_count: 40, is_currently_live: false, security_verdict: { verdict: 'allow' } }])],
  [/^\/os\/auth\/keys$/, () => ({ __status: 201, api_key: 'test-key-' + ++osKeys, name: 'auto', expires_at: new Date(NOW + 7 * 24 * H).toISOString(), rate_limits: { read: '600/h' } })],
  [/^\/os\/collections\/trending$/, (m, q, req) => (req.headers['x-api-key'] ? {
    collections: q.get('timeframe') === 'one_hour'
      ? [{ collection: 'hot-apes', name: 'Hot Apes', image_url: 'https://example.com/a.png', safelist_status: 'verified', category: 'PFPS', is_disabled: false, is_nsfw: false, opensea_url: 'https://opensea.io/collection/hot-apes', twitter_username: 'hotapes', contracts: [{ address: '0xabc', chain: 'ethereum' }] }]
      : [{ collection: 'thin-cats', name: 'Thin Cats', image_url: null, safelist_status: 'verified', category: 'ART', is_disabled: false, is_nsfw: false, opensea_url: 'https://opensea.io/collection/thin-cats', contracts: [{ address: '0xdef', chain: 'base' }] },
         { collection: 'hot-apes', name: 'Hot Apes', image_url: 'https://example.com/a.png', safelist_status: 'verified', category: 'PFPS', opensea_url: 'https://opensea.io/collection/hot-apes', contracts: [{ address: '0xabc', chain: 'ethereum' }] }],
    next: 'abc',
  } : { __status: 401, errors: ['Missing an API Key'] })],
  [/^\/os\/collections\/hot-apes\/stats$/, () => ({ total: { volume: 5000, volume_symbol: 'ETH', sales: 20000, num_owners: 4000, floor_price: 0.5, floor_price_symbol: 'ETH' }, intervals: [{ interval: 'one_day', volume: 90, volume_symbol: 'ETH', sales: 300 }, { interval: 'seven_day', volume: 210, volume_symbol: 'ETH', sales: 800 }, { interval: 'thirty_day', volume: 600, volume_symbol: 'ETH', sales: 2500 }] })],
  [/^\/os\/collections\/thin-cats\/stats$/, () => ({ total: { volume: 3, volume_symbol: 'ETH', sales: 40, num_owners: 90, floor_price: 0.01, floor_price_symbol: 'ETH' }, intervals: [{ interval: 'one_day', volume: 1.3, volume_symbol: 'ETH', sales: 9 }, { interval: 'seven_day', volume: 1.4, volume_symbol: 'ETH', sales: 11 }, { interval: 'thirty_day', volume: 2.8, volume_symbol: 'ETH', sales: 30 }] })],
  [/^\/rc\/v1\/tokens\/([^/]+)\/report\/summary$/, (m) => (m[1] === CURVE
    ? { tokenProgram: 'x', risks: [{ name: 'Low Liquidity', value: '$995.63', description: 'x', score: 2004, level: 'danger' }, { name: 'Top 10 holders high ownership', value: '', description: 'x', score: 900, level: 'warn' }], score: 2905, score_normalised: 35, lpLockedPct: 0 }
    : { tokenProgram: 'x', risks: [], score: 1, score_normalised: 1, lpLockedPct: 100 })],
  [/^\/gp\/api\/v1\/token_security\/(\d+)$/, (m, q) => {
    const a = q.get('contract_addresses').toLowerCase();
    const base = { buy_tax: '0', sell_tax: '0', is_open_source: '1', is_mintable: '0', is_honeypot: '0', holder_count: '5000', holders: [{ address: '0xa', percent: '0.05', is_locked: 0, is_contract: 0 }] };
    return { code: 1, message: 'OK', result: { [a]: a === HONEY ? Object.assign({}, base, { is_honeypot: '1', sell_tax: '0.99' }) : base } };
  }],
  [/^\/tg\/bot([^/]+)\/getMe$/, () => ({ ok: true, result: { username: 'kryptoradar_test_bot' } })],
  [/^\/tg\/bot([^/]+)\/getUpdates$/, async (m, q) => {
    const off = +q.get('offset') || 0;
    const pick = () => updates.filter((u) => u.update_id >= off);
    // Długie odpytywanie: bez nowych wiadomości odpowiadamy po chwili (prawdziwy Telegram czeka do `timeout` s).
    if (!pick().length && +q.get('timeout') > 0) await new Promise((r) => setTimeout(r, 300));
    return { ok: true, result: pick() };
  }],
  [/^\/tg\/bot([^/]+)\/setMyCommands$/, () => ({ ok: true, result: true })],
  [/^\/__tgpush$/, (m, q) => {
    const type = q.get('type') || 'private';
    const msg = { date: Math.floor(Date.now() / 1000) - (+q.get('age') || 0), chat: type === 'private' ? { id: +q.get('chat'), type, first_name: 'x' } : { id: +q.get('chat'), type, title: q.get('title') || 'Grupa' }, from: { id: +(q.get('from') || q.get('chat')) }, text: q.get('text') };
    if (q.get('thread')) Object.assign(msg, { message_thread_id: +q.get('thread'), is_topic_message: true });
    updates.push({ update_id: updates.length + 1, message: msg });
    return { ok: true };
  }],
  [/^\/tg\/bot([^/]+)\/sendMessage$/, (m, q, req, body) => {
    if (failSends > 0) {
      failSends--;
      return { __status: 502, ok: false, description: 'Bad Gateway' };
    }
    const b = JSON.parse(body);
    // Grupa, z której bota wyrzucono, i zwykła grupa zmieniona w supergrupę (nowy numer).
    if (String(b.chat_id) === '-100999') return { __status: 403, ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' };
    if (String(b.chat_id) === '-555') return { __status: 400, ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100555 } };
    sent.push(b);
    return { ok: true, result: { message_id: sent.length } };
  }],
  [/^\/tg\/bot([^/]+)\/sendDocument$/, (m, q, req, body) => {
    docs.push(body);
    return { ok: true, result: { message_id: 1 } };
  }],
  [/^\/__sent$/, () => sent],
  [/^\/__docs$/, () => docs],
  [/^\/__gt429$/, (m, q) => ((gt429 = +q.get('n') || 0), { ok: true })],
  [/^\/__failsends$/, (m, q) => ((failSends = +q.get('n') || 0), { ok: true })],
];

function start(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      for (const [re, fn] of routes) {
        const m = u.pathname.match(re);
        if (!m) continue;
        const out = await fn(m, u.searchParams, req, body);
        const code = (out && out.__status) || 200;
        if (out && out.__status) delete out.__status;
        res.writeHead(code, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 404, path: u.pathname }));
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

module.exports = { start, GOOD, CURVE, RUG, HONEY, DUMP, EARLY, NEWRH };
if (require.main === module) start(+process.argv[2] || 9911).then(() => console.log('mock on', +process.argv[2] || 9911));
