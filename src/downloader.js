import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { upgradeCandidates, fileNameFor, shortHash } from './urls.js';

const STATE_FILE = '.download-state.json';

/** Detects real image bytes (so HTML error pages served with 200 are never saved as photos). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/avi[fs]/.test(brand)) return 'image/avif';
    if (/hei[cx]|mif1|msf1|heim|heis/.test(brand)) return 'image/heic';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 0x2a)) return 'image/tiff';
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Downloader extends EventEmitter {
  /**
   * @param request Playwright APIRequestContext (shares cookies/UA with the crawler's browser)
   */
  constructor(request, { outDir, concurrency = 8, retries = 3, timeout = 90000 } = {}) {
    super();
    this.request = request;
    this.outDir = outDir;
    this.concurrency = concurrency;
    this.retries = retries;
    this.timeout = timeout;
    this.queue = [];
    this.active = 0;
    this.waiters = [];
    this.byUrl = new Map(); // url -> result (global de-duplication)
    this.byHash = new Map(); // sha1 -> relative file
    this.names = new Map(); // folder -> Set(file names)
    this.state = { files: {} }; // url -> { file, sha1, bytes }
    this.stats = { queued: 0, done: 0, downloaded: 0, skipped: 0, duplicates: 0, failed: 0, bytes: 0 };
  }

  async init() {
    await mkdir(this.outDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(path.join(this.outDir, STATE_FILE), 'utf8'));
      for (const s of Object.values(this.state.files || {})) {
        if (s.sha1) this.byHash.set(s.sha1, s.file);
        const dir = path.dirname(s.file);
        if (!this.names.has(dir)) this.names.set(dir, new Set());
        this.names.get(dir).add(path.basename(s.file));
      }
    } catch {
      this.state = { files: {} };
    }
    return this;
  }

  async saveState() {
    const tmp = path.join(this.outDir, STATE_FILE + '.tmp');
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, path.join(this.outDir, STATE_FILE));
  }

  /** job: { folder (relative), referer, url, alts } – resolves with the result object. */
  add(job) {
    const existing = this.byUrl.get(job.url);
    if (existing) return existing.then((r) => ({ ...r, status: r.status === 'failed' ? 'failed' : 'duplicate-url', duplicateOf: r.file }));
    this.stats.queued++;
    const p = new Promise((resolve) => this.queue.push({ job, resolve }));
    this.byUrl.set(job.url, p);
    this.pump();
    return p;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const { job, resolve } = this.queue.shift();
      this.active++;
      this.run(job)
        .catch((e) => ({ url: job.url, status: 'failed', error: e.message }))
        .then((r) => {
          this.active--;
          this.stats.done++;
          if (r.status === 'downloaded') this.stats.downloaded++;
          else if (r.status === 'skipped') this.stats.skipped++;
          else if (r.status === 'duplicate') this.stats.duplicates++;
          else this.stats.failed++;
          this.emit('progress', this.stats, r);
          if (r.status === 'downloaded' && this.stats.downloaded % 50 === 0) this.saveState().catch(() => {});
          resolve(r);
          this.pump();
          if (!this.active && !this.queue.length) this.waiters.splice(0).forEach((w) => w());
        });
    }
  }

  drain() {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  uniqueName(folder, name, url) {
    if (!this.names.has(folder)) this.names.set(folder, new Set());
    const used = this.names.get(folder);
    let n = name;
    if (used.has(n)) {
      const ext = path.extname(name);
      n = `${name.slice(0, name.length - ext.length)}-${shortHash(url, 6)}${ext}`;
    }
    used.add(n);
    return n;
  }

  async run(job) {
    const prev = this.state.files[job.url];
    if (prev) {
      const st = await stat(path.join(this.outDir, prev.file)).catch(() => null);
      if (st && st.size > 0) return { url: job.url, status: 'skipped', file: prev.file, bytes: st.size };
    }
    const candidates = [...new Set([job.url, ...(job.alts || [])].flatMap(upgradeCandidates))];
    let lastError = 'keine Kandidaten';
    for (const cand of candidates) {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        let resp;
        try {
          resp = await this.request.get(cand, {
            headers: { Referer: job.referer, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
            timeout: this.timeout,
            failOnStatusCode: false,
            maxRedirects: 10,
          });
        } catch (e) {
          lastError = e.message.split('\n')[0];
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const status = resp.status();
        if (status === 429 || status >= 500) {
          lastError = `HTTP ${status}`;
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (status >= 400) {
          lastError = `HTTP ${status}`;
          break; // try next candidate
        }
        const body = await resp.body();
        const headers = resp.headers();
        const sniffed = sniffImage(body);
        if (!sniffed) {
          lastError = `kein Bild (${headers['content-type'] || 'unbekannter Typ'})`;
          break;
        }
        const sha1 = createHash('sha1').update(body).digest('hex');
        const dupOf = this.byHash.get(sha1);
        if (dupOf) {
          this.state.files[job.url] = { file: dupOf, sha1, bytes: body.length };
          return { url: job.url, from: cand, status: 'duplicate', file: dupOf, bytes: body.length };
        }
        const name = this.uniqueName(job.folder, fileNameFor(cand, sniffed, headers['content-disposition']), cand);
        const rel = path.join(job.folder, name);
        const abs = path.join(this.outDir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs + '.part', body);
        await rename(abs + '.part', abs);
        this.byHash.set(sha1, rel);
        this.state.files[job.url] = { file: rel, sha1, bytes: body.length };
        this.stats.bytes += body.length;
        return { url: job.url, from: cand, status: 'downloaded', file: rel, bytes: body.length };
      }
    }
    return { url: job.url, status: 'failed', error: lastError };
  }
}
