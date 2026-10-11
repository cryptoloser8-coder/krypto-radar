'use strict';
// Wysyłanie danych na GitHuba: plik data.json na osobnej gałęzi (domyślnie „data”).
// Każda publikacja to jeden commit bez historii wypychany z --force, więc repozytorium nie puchnie.
// Strona na GitHub Pages czyta ten plik i pokazuje go w przeglądarce.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, opts), (err, stdout, stderr) => {
      if (err) {
        // Komunikat bez ścieżek do klucza i bez adresu z danymi logowania.
        const msg = String(stderr || err.message).split('\n').filter((l) => l && !/Warning: Permanently added/.test(l)).slice(-3).join(' ');
        return reject(new Error(msg.replace(/https:\/\/[^@\s]+@/g, 'https://***@') || 'git zakończył się błędem'));
      }
      resolve(String(stdout));
    });
  });
}

// Kopiuje pliki z src do dst (tylko zmienione) i usuwa z dst te, których nie ma już w src.
function mirror(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let names = [];
  try {
    names = fs.readdirSync(src).filter((f) => f.endsWith('.json'));
  } catch (e) {}
  const keep = new Set(names);
  for (const f of names) {
    const a = path.join(src, f), b = path.join(dst, f);
    const sa = fs.statSync(a);
    let sb = null;
    try {
      sb = fs.statSync(b);
    } catch (e) {}
    if (!sb || sb.size !== sa.size || sb.mtimeMs < sa.mtimeMs) fs.copyFileSync(a, b);
  }
  for (const f of fs.readdirSync(dst)) if (!keep.has(f)) fs.unlinkSync(path.join(dst, f));
}

class Publisher {
  // dir – katalog roboczy (tworzony sam), key – klucz SSH (klucz „deploy” repozytorium)
  constructor({ dir, remote, branch = 'data', key = '' }) {
    Object.assign(this, { dir, remote, branch, key, count: 0, ready: false });
  }

  env() {
    const env = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'Krypto Radar',
      GIT_AUTHOR_EMAIL: 'radar@localhost',
      GIT_COMMITTER_NAME: 'Krypto Radar',
      GIT_COMMITTER_EMAIL: 'radar@localhost',
      GIT_TERMINAL_PROMPT: '0',
    });
    if (this.key) {
      const kh = path.join(path.dirname(this.key), 'known_hosts');
      env.GIT_SSH_COMMAND = `ssh -i '${this.key}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${kh}'`;
    }
    return env;
  }

  git(args) {
    return run('git', args, { cwd: this.dir, env: this.env() });
  }

  async init() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(this.dir, '.git'))) await this.git(['init', '-q']);
    const remotes = (await this.git(['remote'])).split('\n');
    if (remotes.includes('origin')) await this.git(['remote', 'set-url', 'origin', this.remote]);
    else await this.git(['remote', 'add', 'origin', this.remote]);
    this.ready = true;
  }

  // extra – dodatkowe pliki { 'nazwa.json': obiekt }; dirs – katalogi kopiowane 1:1 { 'details': '/ścieżka' }.
  // Plik bez zmian git wysyła tylko raz, więc szczegóły starych alertów nie obciążają kolejnych publikacji.
  async publish(payload, extra = {}, dirs = {}) {
    if (!this.ready) await this.init();
    const body = JSON.stringify(payload);
    fs.writeFileSync(path.join(this.dir, 'data.json'), body);
    for (const [name, obj] of Object.entries(extra)) fs.writeFileSync(path.join(this.dir, name), JSON.stringify(obj));
    for (const [name, src] of Object.entries(dirs)) mirror(src, path.join(this.dir, name));
    await this.git(['add', '-A']);
    const tree = (await this.git(['write-tree'])).trim();
    const commit = (await this.git(['commit-tree', tree, '-m', 'Dane ' + new Date(payload.publishedAt || Date.now()).toISOString()])).trim();
    await this.git(['push', '--force', '--quiet', 'origin', `${commit}:refs/heads/${this.branch}`]);
    // Stare commity zostają lokalnie jako śmieci – co 30 publikacji je sprzątamy.
    if (++this.count % 30 === 0) await this.git(['gc', '--prune=now', '--quiet']).catch(() => {});
    return { bytes: Buffer.byteLength(body), commit };
  }
}

module.exports = { Publisher };
