import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { installPageHelpers } from './page-helpers.js';
import {
  parseSrcset,
  pickAlbumLinks,
  pickChildLinks,
  mergeItems,
  isPaginationOf,
  pageKey,
  withoutHash,
  sameSite,
  stripLocale,
  tryUrl,
  cleanTitle,
} from './urls.js';

// "Load more" in the languages the site uses (DE/EN/ES/CA) plus a few more.
export const DEFAULT_LOAD_MORE =
  '(load|show|view|see|display)\\s+more|more\\s+(photos|pictures|images|albums|events|galleries)|' +
  'mehr\\s+(laden|anzeigen|zeigen|fotos|bilder|alben|events)|weitere\\s+(laden|anzeigen|fotos|bilder|alben|events)|' +
  'cargar\\s+m[aá]s|ver\\s+m[aá]s|mostrar\\s+m[aá]s|m[aá]s\\s+(fotos|im[aá]genes|[aá]lbumes|eventos)|' +
  'carregar\\s+m[eé]s|veure\\s+m[eé]s|mostra\\s+m[eé]s|charger\\s+plus|voir\\s+plus|afficher\\s+plus|' +
  'carica\\s+altr[ie]|mostra\\s+altr[ie]|meer\\s+laden|toon\\s+meer|^\\s*(more|mehr|m[aá]s|plus|\\+)\\s*$';

const HELPERS_SRC = `void (${installPageHelpers.toString()})(${parseSrcset.toString()})`;

/** Tracks in-flight requests of a page so we can wait until AJAX "load more" calls have finished. */
class NetTracker {
  constructor(page) {
    this.inflight = new Set();
    this.last = Date.now();
    page.on('request', (r) => {
      if (r.redirectedFrom()) this.inflight.delete(r.redirectedFrom());
      if (['websocket', 'eventsource', 'media'].includes(r.resourceType())) return;
      this.inflight.add(r);
      this.last = Date.now();
    });
    const done = (r) => {
      this.inflight.delete(r);
      this.last = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  async idle(page, { idleMs = 600, timeout = 20000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.inflight.size === 0 && Date.now() - this.last >= idleMs) return true;
      await page.waitForTimeout(100);
    }
    return false;
  }
}

export class GalleryCrawler extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      headless: true,
      pageConcurrency: 3,
      maxRounds: 400,
      maxPagesPerListing: 200,
      maxDepth: 2,
      maxAlbums: Infinity,
      navTimeout: 60000,
      loadMore: DEFAULT_LOAD_MORE,
      albumPattern: null,
      proxy: null,
      ...opts,
    };
    this.loadMoreRe = new RegExp(this.opts.loadMore, 'i');
  }

  log(msg) {
    this.emit('log', msg);
  }

  async start() {
    const launch = { headless: this.opts.headless };
    if (this.opts.proxy) launch.proxy = { server: this.opts.proxy };
    if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
    this.browser = await chromium.launch(launch);
    const ver = this.browser.version().split('.')[0];
    this.context = await this.browser.newContext({
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`,
      viewport: { width: 1440, height: 1000 },
      locale: 'de-DE',
      bypassCSP: true,
      acceptDownloads: true,
    });
    // Skip heavy resources we never need while crawling (images are still requested, so lazy loaders fire).
    await this.context.route('**/*', (route) => {
      const t = route.request().resourceType();
      return t === 'media' || t === 'font' ? route.abort() : route.continue();
    });
    return this;
  }

  get request() {
    return this.context.request;
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  async goto(page, url) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeout });
        if (resp && resp.status() >= 500) throw new Error(`HTTP ${resp.status()}`);
        if (resp && resp.status() >= 400) this.log(`  ⚠ ${url} antwortet mit HTTP ${resp.status()}`);
        return resp;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(1500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  async clickMarked(page, n) {
    let clicked = 0;
    for (let i = 1; i <= n; i++) {
      const loc = page.locator(`[data-bgdl-lm="${i}"]`).first();
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
        await loc.click({ timeout: 4000 });
        clicked++;
      } catch {
        // Covered by an overlay or detached – fall back to a DOM click.
        const ok = await page
          .evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.click();
            return true;
          }, `[data-bgdl-lm="${i}"]`)
          .catch(() => false);
        if (ok) clicked++;
      }
    }
    return clicked;
  }

  /**
   * Scrolls and clicks "load more" until nothing new appears anymore.
   * `sink` receives everything the page collected (incrementally).
   */
  async expand(page, net, sink) {
    let best = -1;
    let stable = 0;
    let clicks = 0;
    const startUrl = withoutHash(page.url());
    for (let round = 0; round < this.opts.maxRounds; round++) {
      await page.evaluate(() => window.__bgdl.scroll()).catch(() => {});
      await net.idle(page);
      sink(await page.evaluate(() => window.__bgdl.takeNew()));
      const n = await page.evaluate(([s, f]) => window.__bgdl.markLoadMore(s, f), [this.loadMoreRe.source, 'i']);
      let clicked = 0;
      if (n) {
        clicked = await this.clickMarked(page, n);
        clicks += clicked;
        await page.waitForTimeout(250);
        await net.idle(page);
      }
      if (withoutHash(page.url()) !== startUrl) {
        // A "load more" control navigated away – treat the new URL as another page of this listing.
        return { clicks, navigatedTo: page.url() };
      }
      const c = await page.evaluate(() => window.__bgdl.step(false));
      const total = c.items + c.links;
      if (total > best) {
        best = total;
        stable = 0;
      } else if (++stable >= (clicked ? 4 : 2)) break;
    }
    await page.evaluate(() => window.__bgdl.step(true)).catch(() => {});
    sink(await page.evaluate(() => window.__bgdl.takeNew()));
    return { clicks, navigatedTo: null };
  }

  /**
   * Opens a page, expands it completely and follows its pagination (?page=N, /page/N).
   * Returns everything found on all pages of this listing.
   */
  async visit(url) {
    const page = await this.context.newPage();
    const net = new NetTracker(page);
    const res = { url, title: '', items: [], links: new Map(), archives: new Set(), pages: 0, clicks: 0 };
    const sink = (d) => {
      res.items.push(...d.items);
      for (const l of d.links) {
        const prev = res.links.get(l.href);
        if (!prev) res.links.set(l.href, { ...l });
        else {
          prev.text ||= l.text;
          prev.hasImage ||= l.hasImage;
        }
      }
      d.archives.forEach((a) => res.archives.add(a));
      if (!res.title && d.title) res.title = d.title;
    };
    const queue = [url];
    const seen = new Set([pageKey(url)]);
    const enqueue = (href) => {
      const k = pageKey(href);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(href);
      }
    };
    try {
      while (queue.length && res.pages < this.opts.maxPagesPerListing) {
        const u = queue.shift();
        await this.goto(page, u);
        await net.idle(page, { timeout: 15000 });
        await page.evaluate(HELPERS_SRC);
        const consent = await page.evaluate(() => window.__bgdl.dismissConsent());
        if (consent) await net.idle(page, { timeout: 5000 });
        res.pages++;
        const r = await this.expand(page, net, sink);
        res.clicks += r.clicks;
        if (r.navigatedTo) enqueue(r.navigatedTo);
        for (const l of res.links.values()) if (isPaginationOf(l.href, url)) enqueue(l.href);
      }
    } finally {
      await page.close().catch(() => {});
    }
    return res;
  }

  /**
   * Full crawl: gallery listing(s) -> all albums (sub-events) -> optional sub-albums.
   * Emits 'album' for every crawled album as soon as it is done.
   */
  async crawl(galleryUrls) {
    const albums = [];
    const known = new Set();
    const chrome = new Set(); // site chrome (logo, icons, banners) – never downloaded
    const queue = [];

    for (const gu of galleryUrls) {
      this.log(`Galerie öffnen: ${gu}`);
      const g = await this.visit(gu);
      const found = pickAlbumLinks([...g.links.values()], gu, { albumPattern: this.opts.albumPattern });
      const albumKeys = new Set(found.map((a) => pageKey(a.url)));
      for (const it of g.items) {
        if (!it.linkHref || !albumKeys.has(pageKey(it.linkHref))) it.cands.forEach((c) => chrome.add(c.url));
      }
      let added = 0;
      for (const a of found) {
        const k = pageKey(a.url);
        if (known.has(k)) continue;
        known.add(k);
        queue.push({ ...a, gallery: gu, depth: 1, parent: null });
        added++;
      }
      this.emit('gallery', { url: gu, albums: added, pages: g.pages, clicks: g.clicks });
    }

    let started = 0;
    let finished = 0;
    // Workers pick up jobs that other workers add while running.
    const running = new Set();
    const spawn = () => {
      while (running.size < this.opts.pageConcurrency && queue.length) {
        const p = worker().finally(() => running.delete(p));
        running.add(p);
      }
    };
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        if (job.depth === 1 && started >= this.opts.maxAlbums) continue;
        if (job.depth === 1) started++;
        let v;
        try {
          v = await this.visit(job.url);
        } catch (e) {
          this.log(`  ✗ Album nicht ladbar: ${job.url} (${e.message.split('\n')[0]})`);
          albums.push({ ...job, title: job.title || job.url, images: [], archives: [], error: e.message });
          continue;
        }
        const links = [...v.links.values()].filter((l) => !isPaginationOf(l.href, job.url));
        const childLinks = job.depth < this.opts.maxDepth ? pickChildLinks(links, job.url) : [];
        const childKeys = new Set(childLinks.map((c) => pageKey(c.url)));
        // Albums linked from album pages (e.g. "more events", numbered gallery pages) are discovered too.
        for (const a of pickAlbumLinks(links, job.gallery, { albumPattern: this.opts.albumPattern })) {
          const k = pageKey(a.url);
          if (known.has(k) || childKeys.has(k)) continue;
          known.add(k);
          queue.push({ ...a, gallery: job.gallery, depth: 1, parent: null });
        }
        const albumPath = stripLocale(tryUrl(job.url).pathname).replace(/\/+$/, '');
        const images = mergeItems(v.items).filter((img) => {
          if ([img.url, ...img.alts].some((u) => chrome.has(u))) return false;
          if (!img.linkHref) return true;
          const lk = pageKey(img.linkHref);
          if (childKeys.has(lk)) return false; // cover of a sub-album – crawled separately
          if (lk === pageKey(job.url)) return true;
          const lu = tryUrl(img.linkHref);
          // Photos may link to their own detail page below the album; anything else is navigation/teaser.
          return !!lu && sameSite(lu, job.url) && stripLocale(lu.pathname).startsWith(albumPath + '/');
        });
        const album = {
          url: job.url,
          title: cleanTitle(job.title) || cleanTitle(v.title) || job.url,
          pageTitle: cleanTitle(v.title),
          depth: job.depth,
          parent: job.parent,
          pages: v.pages,
          clicks: v.clicks,
          images,
          archives: [...v.archives],
        };
        albums.push(album);
        finished++;
        this.emit('album', album, { finished, pending: queue.length });
        for (const c of childLinks) {
          const k = pageKey(c.url);
          if (known.has(k)) continue;
          known.add(k);
          queue.unshift({ ...c, gallery: job.gallery, depth: job.depth + 1, parent: album });
        }
        spawn();
      }
    };
    spawn();
    while (running.size) {
      await Promise.race(running);
      spawn();
    }
    return albums;
  }
}
