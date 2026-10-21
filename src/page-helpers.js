// Code in this file runs INSIDE the browser page (serialized via toString()).
// It must stay self-contained: no imports, no closures over module scope.

/**
 * Installs window.__bgdl with:
 *  step(withBackgrounds) – snapshot all photo candidates + links into accumulators
 *  scroll()              – scroll to the bottom step by step (triggers lazy loading /
 *                          infinite scroll), snapshotting on every step
 *  markLoadMore(src, fl) – marks visible "load more" controls with data-bgdl-lm
 *  dismissConsent()      – clicks an "accept cookies" button if one is visible
 *  takeNew()             – returns everything collected since the last call
 */
export function installPageHelpers(parseSrcset) {
  if (window.__bgdl) return;

  const IMG_RE = /\.(jpe?g|png|webp|avif|gif|heic|heif|tiff?|bmp|jfif)$/i;
  const PROXY_RE = /\/_(next|vercel)\/image\/?$/i;
  const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz)$/i;
  // Attributes that usually hold the full-size version (lightboxes, zoom plugins, download buttons).
  const FULL_ATTRS = [
    'data-full', 'data-full-src', 'data-fullsrc', 'data-full-url', 'data-original', 'data-original-src',
    'data-orig', 'data-large', 'data-large-src', 'data-large_image', 'data-zoom', 'data-zoom-src',
    'data-zoom-image', 'data-hires', 'data-highres', 'data-high-res', 'data-big', 'data-src-full',
    'data-image-full', 'data-download', 'data-download-url', 'data-hd', 'data-pswp-src', 'data-lightbox-src',
    'data-fancybox-href',
  ];
  // On wrapper elements (not on the <img> itself) these point to the lightbox image.
  const WRAPPER_ATTRS = ['data-src', 'data-href', 'data-image', 'data-img', 'data-url'];
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-url', 'data-image', 'data-img', 'data-echo'];
  const SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];

  const pathOf = (u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return '';
    }
  };
  const abs = (u) => {
    if (!u) return null;
    u = String(u).trim();
    if (!u || /^(data|blob|javascript|about|mailto|tel):/i.test(u)) return null;
    try {
      const x = new URL(u, document.baseURI);
      return /^https?:$/.test(x.protocol) ? x.href : null;
    } catch {
      return null;
    }
  };
  const isImg = (u) => {
    const p = pathOf(u);
    return IMG_RE.test(p) || PROXY_RE.test(p);
  };
  const isSvg = (u) => /\.svg$/i.test(pathOf(u));
  const looksLikeUrl = (v) => /^(https?:)?\/|^\.{0,2}\/|\.[a-z]{3,4}(\?|$)/i.test(v.trim()) && !/\s/.test(v.trim());
  const here = () => location.href.split('#')[0];

  const acc = new Map(); // signature -> item
  const newItems = [];
  const links = new Map(); // href -> link info
  const newLinks = [];
  const archives = new Set();

  function bestSrcset(el) {
    let best = null;
    for (const at of SRCSET_ATTRS) {
      const v = el.getAttribute && el.getAttribute(at);
      if (!v) continue;
      for (const c of parseSrcset(v)) {
        const u = abs(c.url);
        if (u && !isSvg(u) && (!best || c.w > best.w)) best = { url: u, w: c.w };
      }
    }
    return best;
  }

  function backgroundUrls(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || bg.indexOf('url(') < 0) return [];
    const out = [];
    for (const m of bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
      const u = abs(m[2]);
      if (u && !isSvg(u)) out.push(u);
    }
    return out;
  }

  /** Candidates for one photo element (an <img> or an element with a background image). */
  function itemFor(el, isImgEl, usedLinks) {
    const cands = [];
    const add = (u, score, via) => {
      u = abs(u);
      if (u && !isSvg(u)) cands.push({ url: u, score, via });
    };
    // The "item container": climb while the ancestor still contains only this photo.
    let container = el;
    for (let p = el.parentElement, i = 0; p && p !== document.body && i < 6; p = p.parentElement, i++) {
      if (p.getElementsByTagName('img').length > (isImgEl ? 1 : 0)) break;
      container = p;
    }
    const link = el.closest('a[href]');
    const top = link && link.contains(container) ? link : container;
    let linkHref = null;
    if (link) {
      const h = abs(link.getAttribute('href'));
      if (h && (link.hasAttribute('download') && !ARCHIVE_RE.test(pathOf(h)))) {
        add(h, 2e9, 'download-link');
        usedLinks.add(link);
      } else if (h && isImg(h)) {
        add(h, 1e9, 'link');
        usedLinks.add(link);
      } else if (h && h.split('#')[0] !== here()) {
        linkHref = h;
      }
    } else if (container !== el) {
      // Card layouts: <div><img><a href="/gallery/x">Fotos ansehen</a></div>
      const navs = [...container.querySelectorAll('a[href]')]
        .map((a) => (a.hasAttribute('download') ? null : abs(a.getAttribute('href'))))
        .filter((h) => h && !isImg(h) && h.split('#')[0] !== here() && new URL(h).origin === location.origin);
      if (navs.length === 1) linkHref = navs[0];
    }
    if (container !== el) {
      for (const a of container.querySelectorAll('a[href]')) {
        if (a === link) continue;
        const h = abs(a.getAttribute('href'));
        if (!h) continue;
        if (a.hasAttribute('download') && !ARCHIVE_RE.test(pathOf(h))) {
          add(h, 2e9, 'download-link');
          usedLinks.add(a);
        } else if (isImg(h)) {
          add(h, 1e9, 'container-link');
          usedLinks.add(a);
        }
      }
    }
    for (let p = el; p; p = p.parentElement) {
      for (const at of FULL_ATTRS) {
        const v = p.getAttribute(at);
        if (v && looksLikeUrl(v)) add(v, 1e8, at);
      }
      if (p !== el) {
        for (const at of WRAPPER_ATTRS) {
          const u = abs(p.getAttribute(at));
          if (u && isImg(u)) add(u, 1e8, 'wrapper:' + at);
        }
      }
      if (p === top || p === document.body) break;
    }
    if (isImgEl) {
      const ss = bestSrcset(el);
      if (ss) add(ss.url, 1e4 + Math.min(ss.w, 8e4), 'srcset');
      const pic = el.parentElement;
      if (pic && pic.tagName === 'PICTURE') {
        for (const s of pic.getElementsByTagName('source')) {
          const b = bestSrcset(s);
          if (b) add(b.url, 1e4 + Math.min(b.w, 8e4), 'picture');
        }
      }
      for (const at of LAZY_ATTRS) add(el.getAttribute(at), 5000, at);
      add(el.currentSrc, 3000, 'currentSrc');
      add(el.getAttribute('src'), 2000, 'src');
    } else {
      for (const at of LAZY_ATTRS) {
        const u = abs(el.getAttribute(at));
        if (u && isImg(u)) add(u, 5000, at);
      }
      for (const u of backgroundUrls(el)) add(u, 4000, 'background');
    }
    return cands.length ? { cands, linkHref } : null;
  }

  function rawItems(withBackgrounds) {
    const out = [];
    const usedLinks = new Set();
    for (const img of document.images) {
      const it = itemFor(img, true, usedLinks);
      if (it) out.push(it);
    }
    if (withBackgrounds) {
      for (const el of document.body.getElementsByTagName('*')) {
        if (el.tagName === 'IMG' || !backgroundUrls(el).length) continue;
        const it = itemFor(el, false, usedLinks);
        if (it) out.push(it);
      }
    }
    for (const a of document.querySelectorAll('a[href]')) {
      if (usedLinks.has(a)) continue;
      const h = abs(a.getAttribute('href'));
      if (!h) continue;
      if (ARCHIVE_RE.test(pathOf(h))) {
        archives.add(h);
        continue;
      }
      if (a.getElementsByTagName('img').length) continue;
      if (isImg(h) && !isSvg(h)) out.push({ cands: [{ url: h, score: 1e9, via: 'standalone-link' }], linkHref: null });
      else if (a.hasAttribute('download')) out.push({ cands: [{ url: h, score: 2e9, via: 'standalone-download' }], linkHref: null });
    }
    return out;
  }

  function hasImage(a) {
    if (a.querySelector('img, picture, [style*="background"]')) return true;
    return backgroundUrls(a).length > 0;
  }

  function step(withBackgrounds) {
    const items = rawItems(!!withBackgrounds);
    // URLs used by several elements at the same time are placeholders/spinners, not photos –
    // unless it is the best candidate of both (grid image + preloaded lightbox copy of the same photo).
    const freq = new Map();
    for (const it of items) for (const u of new Set(it.cands.map((c) => c.url))) freq.set(u, (freq.get(u) || 0) + 1);
    for (const it of items) {
      const top = Math.max(...it.cands.map((c) => c.score));
      const cands = it.cands.filter((c) => {
        const f = freq.get(c.url);
        return f < 3 && (f < 2 || c.score === top);
      });
      if (!cands.length) continue;
      const sig = cands.map((c) => c.url + '|' + c.score).sort().join(' ') + '#' + (it.linkHref || '');
      if (acc.has(sig)) continue;
      const item = { cands, linkHref: it.linkHref };
      acc.set(sig, item);
      newItems.push(item);
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const h = abs(a.getAttribute('href'));
      if (!h) continue;
      const href = h.split('#')[0];
      const text = (a.innerText || a.textContent || '').trim().slice(0, 300);
      const title = a.getAttribute('title') || a.getAttribute('aria-label') || '';
      const img = hasImage(a);
      const prev = links.get(href);
      if (!prev) {
        const l = { href, text, title, hasImage: img, rel: a.getAttribute('rel') || '' };
        links.set(href, l);
        newLinks.push(l);
      } else if ((!prev.text && text) || (!prev.hasImage && img)) {
        prev.text ||= text;
        prev.hasImage ||= img;
        newLinks.push(prev);
      }
    }
    return { items: acc.size, links: links.size };
  }

  async function scroll(maxSteps = 400) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let lastH = -1;
    let sameAtBottom = 0;
    for (let i = 0; i < maxSteps; i++) {
      const se = document.scrollingElement || document.documentElement;
      window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.85)));
      await sleep(120);
      step(false);
      if (window.scrollY + window.innerHeight >= se.scrollHeight - 4) {
        if (se.scrollHeight === lastH) {
          if (++sameAtBottom >= 2) break;
        } else sameAtBottom = 0;
        lastH = se.scrollHeight;
        await sleep(400);
      }
    }
    return step(false);
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function labelOf(el) {
    return [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function markLoadMore(src, flags) {
    const re = new RegExp(src, flags);
    document.querySelectorAll('[data-bgdl-lm]').forEach((e) => e.removeAttribute('data-bgdl-lm'));
    const sel =
      'button, a, [role=button], input[type=button], input[type=submit], ' +
      '[class*="load-more" i], [class*="loadmore" i], [class*="load_more" i], [id*="load-more" i], [id*="loadmore" i]';
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const isControl = /^(BUTTON|A|INPUT)$/.test(el.tagName) || el.getAttribute('role') === 'button';
      if (!isControl && el.querySelector('button, a, [role=button]')) continue; // wrapper of a real control
      const text = labelOf(el);
      const meta = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
      const hit = (text && text.length <= 60 && re.test(text)) || /load[-_ ]?more|show[-_ ]?more/i.test(meta);
      if (!hit || el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
      if (el.tagName === 'A') {
        // Real links to another URL are pagination – handled by the crawler, not clicked.
        const raw = el.getAttribute('href');
        if (raw && !raw.startsWith('#') && !/^javascript:/i.test(raw) && el.href.split('#')[0] !== here()) continue;
      }
      if (el.form && (el.type === 'submit' || el.tagName === 'BUTTON') && el.form.getAttribute('action')) continue;
      el.setAttribute('data-bgdl-lm', String(++n));
      if (n >= 5) break;
    }
    return n;
  }

  const FILTER_BOX_RE = /filter|tabs?\b|tablist|categor|location|ubicaci|standort|lugar|sede|venue|segment/i;
  const metaOf = (el) => `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''} ${el.getAttribute('role') || ''}`;
  const navigates = (a) => {
    const raw = a.getAttribute('href');
    return !!raw && !raw.startsWith('#') && !/^javascript:/i.test(raw) && a.href.split('#')[0] !== here();
  };

  /**
   * Filter controls of an overview page (tabs, filter buttons, radio labels): returns their labels.
   * With `markLabel`, marks the control with that label as data-bgdl-f="1".
   */
  function filters(src, flags, loadMoreSrc, markLabel) {
    const re = new RegExp(src, flags);
    const lm = new RegExp(loadMoreSrc, flags);
    document.querySelectorAll('[data-bgdl-f]').forEach((e) => e.removeAttribute('data-bgdl-f'));
    const out = [];
    const sel =
      '[role=tab], [role=radio], button, a, [role=button], label, li, ' +
      '[data-filter], [data-category], [data-location], [data-venue], [data-club], [data-tab]';
    for (const el of document.querySelectorAll(sel)) {
      const text = labelOf(el);
      if (!text || text.length > 40 || lm.test(text) || !visible(el)) continue;
      if (el.tagName === 'A' && navigates(el)) continue; // real links: handled as URL variants
      if (el.tagName !== 'A' && [...el.querySelectorAll('a[href]')].some(navigates)) continue;
      if (el.closest('header nav, footer, #cookie, [class*="cookie" i], [id*="cookie" i], [class*="consent" i]')) continue;
      const dataTab = ['data-filter', 'data-category', 'data-location', 'data-venue', 'data-club', 'data-tab'].some((a) => el.hasAttribute(a));
      const isTab = ['tab', 'radio'].includes(el.getAttribute('role')) || dataTab;
      let inBox = false;
      for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        if (FILTER_BOX_RE.test(metaOf(p))) {
          inBox = true;
          break;
        }
      }
      if (el.tagName === 'LI' && !isTab && !inBox) continue;
      if (!(isTab || inBox || re.test(text))) continue;
      if (out.includes(text)) continue;
      if (markLabel != null) {
        if (text === markLabel) {
          el.setAttribute('data-bgdl-f', '1');
          return [text];
        }
        continue;
      }
      out.push(text);
      if (out.length >= 25) break;
    }
    return markLabel != null ? [] : out;
  }

  /** <select> dropdowns that filter the overview (location/category), with all their values. */
  function filterSelects(src, flags) {
    const re = new RegExp(src, flags);
    const out = [];
    for (const s of document.querySelectorAll('select')) {
      if (s.options.length < 2 || s.options.length > 30) continue;
      let boxHit = false;
      for (let p = s, i = 0; p && i < 4; p = p.parentElement, i++) if (FILTER_BOX_RE.test(metaOf(p) + ' ' + (p.getAttribute('name') || ''))) boxHit = true;
      const optHit = [...s.options].some((o) => re.test(o.text));
      if (!boxHit && !optHit) continue;
      s.setAttribute('data-bgdl-sel', String(out.length + 1));
      out.push({ i: out.length + 1, values: [...s.options].map((o) => o.value).filter((v) => v !== s.value) });
    }
    return out;
  }

  function dismissConsent() {
    const re = /^(alle akzeptieren|alles akzeptieren|akzeptieren|zustimmen|alle zulassen|einverstanden|accept all|accept all cookies|accept|i accept|agree|i agree|allow all|allow cookies|got it|ok|aceptar|aceptar todo|aceptar todas|acepto|acceptar|accepta|tout accepter|accepter|accetta|accetta tutto)$/i;
    for (const el of document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')) {
      const t = labelOf(el);
      if (t && t.length < 40 && re.test(t) && visible(el)) {
        el.click();
        return t;
      }
    }
    return null;
  }

  function takeNew() {
    const h1 = document.querySelector('h1');
    const out = {
      items: newItems.splice(0),
      links: newLinks.splice(0),
      archives: [...archives],
      title: ((h1 && h1.innerText) || document.title || '').trim().slice(0, 200),
      url: location.href,
    };
    return out;
  }

  window.__bgdl = { step, scroll, markLoadMore, filters, filterSelects, dismissConsent, takeNew };
}
