'use strict';
// Logowanie hasłem. Bez zewnętrznych bibliotek: scrypt do hasła, HMAC do ciasteczka sesji.

const crypto = require('crypto');

const COOKIE = 'kr_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const [N, r, q] = p.slice(1, 4).map(Number);
  const salt = Buffer.from(p[4], 'base64');
  const want = Buffer.from(p[5], 'base64');
  let got;
  try {
    got = crypto.scryptSync(String(pw), salt, want.length, { N, r, p: q, maxmem: 64 * 1024 * 1024 });
  } catch (e) {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const newSecret = () => crypto.randomBytes(32).toString('hex');
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function makeSession(secret, now = Date.now()) {
  const exp = now + SESSION_DAYS * 864e5;
  const data = `${exp}.${crypto.randomBytes(12).toString('base64url')}`;
  return `${data}.${sign(secret, data)}`;
}

function checkSession(secret, value, now = Date.now()) {
  if (!secret || !value) return false;
  const i = value.lastIndexOf('.');
  if (i < 0) return false;
  const data = value.slice(0, i);
  const a = Buffer.from(value.slice(i + 1));
  const b = Buffer.from(sign(secret, data));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(data.split('.')[0]) > now;
}

function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const j = part.indexOf('=');
    if (j > 0 && part.slice(0, j).trim() === name) return decodeURIComponent(part.slice(j + 1).trim());
  }
  return null;
}

function cookieHeader(value, opts = {}) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${value ? SESSION_DAYS * 86400 : 0}`];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Blokada zgadywania: 5 błędnych prób z jednego adresu w 15 minut blokuje ten adres na 15 minut,
// a 20 błędnych prób łącznie (z dowolnych adresów) blokuje logowanie wszystkim na 15 minut.
class Throttle {
  constructor({ perIp = 5, global = 20, windowMs = 15 * 60e3 } = {}) {
    Object.assign(this, { perIp, global, windowMs, ips: new Map(), all: [] });
  }
  _prune(now) {
    this.all = this.all.filter((t) => now - t < this.windowMs);
    for (const [ip, list] of this.ips) {
      const keep = list.filter((t) => now - t < this.windowMs);
      if (keep.length) this.ips.set(ip, keep);
      else this.ips.delete(ip);
    }
  }
  blockedFor(ip, now = Date.now()) {
    this._prune(now);
    const mine = this.ips.get(ip) || [];
    const wait = (list, max) => (list.length >= max ? list[list.length - max] + this.windowMs - now : 0);
    return Math.max(wait(mine, this.perIp), wait(this.all, this.global));
  }
  fail(ip, now = Date.now()) {
    this.all.push(now);
    this.ips.set(ip, (this.ips.get(ip) || []).concat(now));
  }
  ok(ip) {
    this.ips.delete(ip);
  }
}

module.exports = { hashPassword, verifyPassword, newSecret, makeSession, checkSession, readCookie, cookieHeader, Throttle, COOKIE, MIN_PASSWORD };
