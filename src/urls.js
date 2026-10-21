// Pure helpers (no browser, no I/O) – unit tested in test/urls.test.js.

import { createHash } from 'node:crypto';

export const IMAGE_EXT_RE = /\.(jpe?g|png|webp|avif|gif|heic|heif|tiff?|bmp|jfif)$/i;
const IMAGE_PROXY_RE = /\/_(next|vercel)\/image\/?$/i;
const ARCHIVE_EXT_RE = /\.(zip|rar|7z|tar|gz)$/i;
const PAGINATION_PARAM_RE = /^(page|p|pg|paged|seite|pagina|página|offset|start|skip)$/i;
const LOCALE_PREFIX_RE = /^\/[a-z]{2}(?:[-_][a-z]{2})?(?=\/|$)/i;

export function tryUrl(href, base) {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/** Parses a srcset attribute into [{url, w}] (w = width, or density*1000). */
export function parseSrcset(srcset) {
  const out = [];
  const s = String(srcset || '');
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      while (i < n && s[i] !== ',') i++;
      desc = s.slice(start, i).trim();
      i++;
    }
    if (!url) continue;
    let w = 1;
    const m = /^([\d.]+)([wxh])$/i.exec(desc);
    if (m) w = m[2].toLowerCase() === 'x' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    out.push({ url, w });
  }
  return out;
}

export function isImageUrl(href) {
  const u = tryUrl(href);
  if (!u) return false;
  return IMAGE_EXT_RE.test(u.pathname) || IMAGE_PROXY_RE.test(u.pathname);
}

export function isArchiveUrl(href) {
  const u = tryUrl(href);
  return !!u && ARCHIVE_EXT_RE.test(u.pathname);
}

export function isSvgOrInline(href) {
  if (!href) return true;
  if (/^(data|blob|javascript):/i.test(href)) return true;
  const u = tryUrl(href);
  return !u || /\.svg$/i.test(u.pathname);
}

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

export function sameSite(a, b) {
  const ua = typeof a === 'string' ? tryUrl(a) : a;
  const ub = typeof b === 'string' ? tryUrl(b) : b;
  return !!ua && !!ub && bareHost(ua.hostname) === bareHost(ub.hostname);
}

export const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** "/es/gallery/x" -> "/gallery/x" (language prefixes only). */
export function stripLocale(pathname) {
  const p = trimSlash(pathname);
  const stripped = p.replace(LOCALE_PREFIX_RE, '');
  return stripped === '' ? '/' : stripped;
}

/** Key that identifies a page regardless of www/locale prefix/hash/trailing slash. */
export function pageKey(href) {
  const u = tryUrl(href);
  if (!u) return href;
  return `${bareHost(u.hostname)}${stripLocale(u.pathname)}${u.search}`;
}

export function withoutHash(href) {
  const u = tryUrl(href);
  if (!u) return href;
  u.hash = '';
  return u.href;
}

/** True if the URL only differs from `base` by a pagination parameter or a /page/N suffix. */
export function isPaginationOf(href, base) {
  const u = tryUrl(href);
  const b = tryUrl(base);
  if (!u || !b || !sameSite(u, b)) return false;
  const up = trimSlash(u.pathname);
  const bp = trimSlash(b.pathname);
  const pageSuffix = /\/page\/\d+$/i;
  const upBase = up.replace(pageSuffix, '');
  const bpBase = bp.replace(pageSuffix, '');
  if (stripLocale(upBase) !== stripLocale(bpBase)) return false;
  if (pageSuffix.test(up) && up !== bp) return true;
  for (const [k] of u.searchParams) if (PAGINATION_PARAM_RE.test(k)) return u.search !== b.search;
  return false;
}

/** Same overview page with another query (?page=2, ?location=cala-rajada, …) or a /page/N suffix. */
export function isListingVariant(href, base) {
  if (isPaginationOf(href, base)) return true;
  const u = tryUrl(href);
  const b = tryUrl(base);
  if (!u || !b || !sameSite(u, b)) return false;
  return stripLocale(u.pathname) === stripLocale(b.pathname) && u.search !== '' && u.search !== b.search;
}

function pathUnder(pathname, prefix) {
  const p = stripLocale(pathname);
  const pre = stripLocale(prefix);
  return pre === '/' ? p !== '/' : p.startsWith(pre + '/');
}

const GENERIC_ALBUM_RE = /(galler(y|ie|ia)|galer[ií]a|album|fotos?|photos?|bilder|events?|eventos?)/i;

/**
 * Picks the album (sub-event) links from all links found on a gallery page.
 * Default rule: same site, below the gallery path (e.g. /gallery/<album>).
 * Fallback if nothing matches: any same-site page whose path looks gallery-ish.
 */
export function pickAlbumLinks(links, galleryUrl, { albumPattern } = {}) {
  const g = tryUrl(galleryUrl);
  const found = new Map();
  const consider = (l, test) => {
    const u = tryUrl(l.href);
    if (!u || !/^https?:$/.test(u.protocol) || !sameSite(u, g)) return;
    if (isImageUrl(u.href) || isArchiveUrl(u.href)) return;
    u.hash = '';
    if (stripLocale(u.pathname) === stripLocale(g.pathname)) return; // gallery itself (any language)
    if (isPaginationOf(u.href, g.href)) return;
    if (!test(u)) return;
    const key = pageKey(u.href);
    const prev = found.get(key);
    const title = cleanTitle(l.text || l.title || '');
    if (!prev) found.set(key, { url: u.href, title, hasImage: !!l.hasImage });
    else {
      if (!prev.title && title) prev.title = title;
      prev.hasImage ||= !!l.hasImage;
    }
  };
  if (albumPattern) {
    for (const l of links) consider(l, (u) => albumPattern.test(u.href));
  } else {
    for (const l of links) consider(l, (u) => pathUnder(u.pathname, g.pathname));
    if (found.size === 0) {
      for (const l of links) consider(l, (u) => GENERIC_ALBUM_RE.test(stripLocale(u.pathname)) && !!l.hasImage);
    }
  }
  return [...found.values()];
}

/** Links on an album page that lead to deeper sub-albums (below the album path). */
export function pickChildLinks(links, albumUrl) {
  const a = tryUrl(albumUrl);
  const found = new Map();
  for (const l of links) {
    const u = tryUrl(l.href);
    if (!u || !sameSite(u, a) || isImageUrl(u.href) || isArchiveUrl(u.href)) continue;
    u.hash = '';
    if (!pathUnder(u.pathname, a.pathname) || isPaginationOf(u.href, a.href)) continue;
    if (!l.hasImage) continue; // sub-albums are shown as image cards
    const key = pageKey(u.href);
    if (!found.has(key)) found.set(key, { url: u.href, title: cleanTitle(l.text || l.title || '') });
  }
  return [...found.values()];
}

export function cleanTitle(s) {
  return String(s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .slice(0, 150);
}

/**
 * Candidate URLs for the original/full-size version of an image URL, best first.
 * - Next.js/Vercel image optimizer: /_next/image?url=<original>&w=..  -> <original>
 * - WordPress style thumbnails: foo-300x200.jpg -> foo.jpg
 * The URL itself is always the last candidate.
 */
export function upgradeCandidates(href) {
  const out = [];
  const u = tryUrl(href);
  if (!u) return [href];
  if (IMAGE_PROXY_RE.test(u.pathname) && u.searchParams.get('url')) {
    const inner = tryUrl(u.searchParams.get('url'), u.origin);
    if (inner) out.push(...upgradeCandidates(inner.href));
  }
  const wp = /^(.*)-\d{2,5}x\d{2,5}(\.[a-z0-9]+)$/i.exec(u.pathname);
  if (wp) {
    const o = new URL(u.href);
    o.pathname = wp[1] + wp[2];
    out.push(o.href);
  }
  out.push(u.href);
  return [...new Set(out)];
}

/**
 * Merges image items collected at different moments (lazy loading changes
 * src/srcset over time). Items sharing any candidate URL are the same photo.
 * Each item: { cands: [{url, score, via}], linkHref }.
 * Returns [{ url, via, alts, linkHref }] with url = highest scoring candidate.
 */
export function mergeItems(items) {
  const parent = [];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byUrl = new Map();
  items.forEach((it, i) => {
    parent[i] = i;
    for (const c of it.cands) {
      if (byUrl.has(c.url)) parent[find(i)] = find(byUrl.get(c.url));
      else byUrl.set(c.url, i);
    }
  });
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { order: i, cands: new Map(), linkHref: null });
    const g = groups.get(r);
    for (const c of it.cands) {
      const prev = g.cands.get(c.url);
      if (!prev || c.score > prev.score) g.cands.set(c.url, c);
    }
    g.linkHref ||= it.linkHref || null;
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => {
      const sorted = [...g.cands.values()].sort((a, b) => b.score - a.score);
      return { url: sorted[0].url, via: sorted[0].via, alts: sorted.slice(1).map((c) => c.url), linkHref: g.linkHref };
    });
}

const CT_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tif',
  'image/bmp': '.bmp',
};

export function extFromContentType(ct) {
  return CT_EXT[String(ct || '').split(';')[0].trim().toLowerCase()] || '';
}

export function sanitizeName(s, max = 120) {
  const clean = String(s || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return clean.slice(0, max).trim() || 'unbenannt';
}

export const shortHash = (s, n = 8) => createHash('sha1').update(String(s)).digest('hex').slice(0, n);

/** File name (without directory) for an image URL; extension fixed up from content-type. */
export function fileNameFor(href, contentType, contentDisposition) {
  const fromCd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition || '');
  let base = '';
  if (fromCd) base = safeDecode(fromCd[1]);
  if (!base) {
    const u = tryUrl(href);
    base = u ? safeDecode(u.pathname.split('/').filter(Boolean).pop() || '') : '';
  }
  base = sanitizeName(base || 'bild', 100);
  const ctExt = extFromContentType(contentType);
  const m = /\.([a-z0-9]{2,5})$/i.exec(base);
  if (!m || !IMAGE_EXT_RE.test(base)) base += ctExt || '.jpg';
  else if (ctExt && extFromContentType(`image/${m[1].toLowerCase()}`) !== ctExt) base = base.slice(0, -m[0].length) + ctExt;
  return base;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Last meaningful path segment(s) of a page URL, used to keep album folder names unique. */
export function slugFor(href) {
  const u = tryUrl(href);
  if (!u) return shortHash(href);
  const segs = stripLocale(u.pathname).split('/').filter(Boolean);
  let slug = segs.pop() || 'start';
  if (u.search) slug += '-' + shortHash(u.search, 6);
  return sanitizeName(safeDecode(slug), 80);
}
