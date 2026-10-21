import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { installPageHelpers } from './page-helpers.js';
import {
  parseSrcset,
  pickAlbumLinks,
  pickChildLinks,
  mergeItems,
  isPaginationOf,
  isListingVariant,
  pageKey,
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

// Location/category filters on the overview (the gallery covers Alcúdia, Cala Rajada & co).
export const DEFAULT_FILTER =
  "^\\s*(alle|all|todos|todas|tots|tot|everything|show all|alle anzeigen|ver todo|ver todos|" +
  "alc[uú]dia|port d'alc[uú]dia|cala\\s*ra[tj]+a?da|cala\\s*ratjada|cala\\s*rajada|" +
  "palma|magaluf|santany[ií]|cala d'or|mallorca)\\s*$";

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
      filter: DEFAULT_FILTER,
      albumPattern: null,
      proxy: null,
      ...opts,
    };
    this.loadMoreRe = new RegExp(this.opts.loadMore, 'i');
    this.filterRe = new RegExp(this.opts.filter, 'i');
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
        return resp;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(1500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /** Clicks like a user; falls back to a DOM click if an overlay covers the element. */
  async clickSelector(page, sel) {
    const loc = page.locator(sel).first();
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.click({ timeout: 4000 });
      return true;
    } catch {
      return page
        .evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, sel)
        .catch(() => false);
    }
  }

  /** False once a real navigation replaced the document (our helpers are gone). */
  async alive(page) {
    return page.evaluate(() => !!window.__bgdl).catch(() => false);
  }

  /**
   * Scrolls and clicks "load more" until nothing new appears anymore.
   * `sink` receives everything the page collected (incrementally).
   */
  async expand(page, net, sink) {
    let best = -1;
    let stable = 0;
    let clicks = 0;
    try {
      for (let round = 0; round < this.opts.maxRounds; round++) {
        await page.evaluate(() => window.__bgdl.scroll());
        await net.idle(page);
        sink(await page.evaluate(() => window.__bgdl.takeNew()));
        const n = await page.evaluate(([s, f]) => window.__bgdl.markLoadMore(s, f), [this.loadMoreRe.source, 'i']);
        let clicked = 0;
        for (let i = 1; i <= n; i++) if (await this.clickSelector(page, `[data-bgdl-lm="${i}"]`)) clicked++;
        if (clicked) {
          clicks += clicked;
          await page.waitForTimeout(250);
          await net.idle(page);
          // A "load more" link that really navigated: the new URL is another page of this listing.
          if (!(await this.alive(page))) return { clicks, navigatedTo: page.url() };
        }
        const c = await page.evaluate(() => window.__bgdl.step(false));
        const total = c.items + c.links;
        if (total > best) {
          best = total;
          stable = 0;
        } else if (++stable >= (clicked ? 4 : 2)) break;
      }
      await page.evaluate(() => window.__bgdl.step(true));
      sink(await page.evaluate(() => window.__bgdl.takeNew()));
    } catch (e) {
      if (!(await this.alive(page))) return { clicks, navigatedTo: page.url() };
      throw e;
    }
    return { clicks, navigatedTo: null };
  }

  /**
   * Overview pages: click every location/category filter (tabs like "Alle | Alcúdia | Cala Rajada",
   * filter buttons, dropdowns) and expand each one completely.
   */
  async expandFilters(page, net, sink, enqueue) {
    const args = [this.filterRe.source, 'i', this.loadMoreRe.source];
    let used = 0;
    const labels = await page.evaluate(([s, f, lm]) => window.__bgdl.filters(s, f, lm, null), args);
    for (const label of labels) {
      const found = await page.evaluate(([s, f, lm, l]) => window.__bgdl.filters(s, f, lm, l).length, [...args, label]).catch(() => 0);
      if (!found || !(await this.clickSelector(page, '[data-bgdl-f="1"]'))) continue;
      used++;
      this.log(`  Filter "${label}" geöffnet`);
      await page.waitForTimeout(250);
      await net.idle(page);
      if (!(await this.alive(page))) {
        enqueue(page.url());
        return used;
      }
      const r = await this.expand(page, net, sink);
      if (r.navigatedTo) {
        enqueue(r.navigatedTo);
        return used;
      }
    }
    const selects = await page.evaluate(([s, f]) => window.__bgdl.filterSelects(s, f), args).catch(() => []);
    for (const sel of selects) {
      for (const value of sel.values) {
        try {
          await page.selectOption(`[data-bgdl-sel="${sel.i}"]`, value, { timeout: 4000 });
        } catch {
          continue;
        }
        used++;
        this.log(`  Auswahl "${value}" geöffnet`);
        await page.waitForTimeout(250);
        await net.idle(page);
        if (!(await this.alive(page))) {
          enqueue(page.url());
          return used;
        }
        const r = await this.expand(page, net, sink);
        if (r.navigatedTo) {
          enqueue(r.navigatedTo);
          return used;
        }
      }
    }
    return used;
  }

  /**
   * Opens a page, expands it completely and follows its pagination (?page=N, /page/N).
   * Overview pages (`listing`) additionally get every filter clicked and every
   * query variant of the page (?location=…, ?page=…) visited.
   * Returns everything found on all pages of this listing.
   */
  async visit(url, { listing = false } = {}) {
    const page = await this.context.newPage();
    const net = new NetTracker(page);
    const res = { url, title: '', items: [], links: new Map(), archives: new Set(), pages: 0, clicks: 0, filters: 0, status: 0 };
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
    const belongs = (href) => (listing ? isListingVariant(href, url) : isPaginationOf(href, url));
    try {
      while (queue.length && res.pages < this.opts.maxPagesPerListing) {
        const u = queue.shift();
        const resp = await this.goto(page, u);
        const status = resp ? resp.status() : 200;
        if (!res.status) res.status = status;
        if (status >= 400) {
          this.log(`  ⚠ ${u} antwortet mit HTTP ${status} – übersprungen`);
          continue;
        }
        await net.idle(page, { timeout: 15000 });
        await page.evaluate(HELPERS_SRC);
        const consent = await page.evaluate(() => window.__bgdl.dismissConsent());
        if (consent) await net.idle(page, { timeout: 5000 });
        res.pages++;
        const r = await this.expand(page, net, sink);
        res.clicks += r.clicks;
        if (r.navigatedTo) enqueue(r.navigatedTo);
        else if (listing) res.filters += await this.expandFilters(page, net, sink, enqueue);
        for (const l of res.links.values()) if (belongs(l.href)) enqueue(l.href);
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
      const g = await this.visit(gu, { listing: true });
      if (g.status >= 400 || !g.pages) {
        this.emit('gallery', { url: gu, albums: 0, pages: 0, clicks: 0, filters: 0, skipped: true });
        continue;
      }
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
      this.emit('gallery', { url: gu, albums: added, pages: g.pages, clicks: g.clicks, filters: g.filters });
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
