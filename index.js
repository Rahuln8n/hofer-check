/**
 * index.js - Hofer / ALDI multi-country checker (strict PLP collection + safer extraction)
 *
 * - Collects only date-PLPs ("/d.DD-MM-YYYY.html") and the listing root page
 * - Uses prioritized heading-based extraction (h1,h2,.page-title,.page-header,.headline)
 * - Scans only nearby text regions and applies numeric caps to avoid junk numbers
 * - Playwright fallback retained for JS-heavy pages
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// optional Playwright
let playwrightChromium = null;
try {
  playwrightChromium = require('playwright').chromium;
  console.log('Playwright available');
} catch (e) {
  console.log('Playwright not available:', e.message ? e.message.split('\n')[0] : e);
}

// Countries config (root + listing path)
const COUNTRIES = [
  { code: 'AT', base: 'https://www.hofer.at', listingPath: '/de/angebote' },
  { code: 'CH', base: 'https://www.aldi-suisse.ch', listingPath: '/de/aktionen-und-angebote' },
  { code: 'HU', base: 'https://www.aldi.hu', listingPath: '/hu/ajanlatok' },
  { code: 'DE', base: 'https://www.aldi-sued.de', listingPath: '/de/angebote' },
  { code: 'SI', base: 'https://www.hofer.si', listingPath: '/sl/ponudba' },
  { code: 'IT', base: 'https://www.aldi.it', listingPath: '/it/offerte-settimanali' }
];

// localized keywords for nearby-match preference
const KEYWORDS = {
  AT: ['Aktionsartikel', 'Aktionsartikel gefunden', 'Aktionsartikel gefunden', 'Aktionsartikel'],
  CH: ['Aktionsartikel', 'Aktionsartikel gefunden', 'Aktionsartikel'],
  HU: ['ajánlat', 'ajánlatok', 'ajánlat található'],
  DE: ['Angebot', 'Angebote', 'Angebote gefunden'],
  SI: ['ponudba', 'najdenih', 'najdenih izdelkov'],
  IT: ['offerta', 'offerte', 'Prodotto in offerta']
};

// domains to prefer Playwright rendering for
const ALWAYS_RENDER_DOMAINS = ['aldi.hu', 'aldi-sued.de', 'hofer.si'];

/* ---------------- helpers ---------------- */

function normalizeNumberString(numStr) {
  if (!numStr) return null;
  const s = String(numStr).replace(/\u00A0|\u202F/g, ' ').trim();
  // remove thousand separators (., space) when between digits
  const cleaned = s.replace(/(?<=\d)[\.\, ](?=\d{3}\b)/g, '');
  const digitsOnly = cleaned.replace(/[^\d\-]/g, '');
  if (!digitsOnly) return null;
  const val = parseInt(digitsOnly, 10);
  return Number.isFinite(val) ? val : null;
}

async function tryFetchHtml(url, timeout = 20000) {
  if (typeof fetch !== 'function') return null;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'de-DE,de;q=0.9' },
      signal: controller.signal
    });
    clearTimeout(id);
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  }
}

function findDatePlpsOnly(html, base) {
  const set = new Set();
  if (!html) return set;
  const re = /(?:href=["']?)([^"'\s>]*\/d\.\d{2}-\d{2}-\d{4}\.html)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    const abs = href.startsWith('http') ? href : new URL(href, base).toString();
    set.add(abs.split('#')[0].split('?')[0]);
  }
  return set;
}

// prioritize heading selectors and search nearby text (safe)
const HEADING_SELECTORS = ['h1', 'h2', '.page-title', '.headline', '.page-header', '.title', '.headline__title'];

function extractCountFromHeadingText(text, keywords = []) {
  if (!text) return null;
  const cleaned = text.replace(/\u00A0/g, ' ').trim();
  // first try keyword-near-number patterns
  for (const kw of keywords || []) {
    const re1 = new RegExp('(\\d{1,5}[\\d\\.,\\u00A0\\u202F]*)\\s*(?:' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i');
    const m1 = cleaned.match(re1);
    if (m1 && m1[1]) {
      const v = normalizeNumberString(m1[1]);
      if (v !== null) return v;
    }
    const re2 = new RegExp('(?:' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\s*(\\d{1,5}[\\d\\.,\\u00A0\\u202F]*)', 'i');
    const m2 = cleaned.match(re2);
    if (m2 && m2[1]) {
      const v2 = normalizeNumberString(m2[1]);
      if (v2 !== null) return v2;
    }
  }
  // fallback: any small number within heading
  const any = cleaned.match(/(\d{1,4}[\,\.\d\s]*)/);
  if (any && any[1]) {
    const v = normalizeNumberString(any[1]);
    if (v !== null) return v;
  }
  return null;
}

// Playwright helpers
async function renderPageTextWithPlaywright(url, timeoutMs = 60000) {
  if (!playwrightChromium) return null;
  let browser;
  try {
    browser = await playwrightChromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(400);
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
    await page.close();
    await ctx.close();
    await browser.close();
    return bodyText || null;
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    return null;
  }
}

async function extractCountBySelectorsPlaywright(url, keywords = [], timeoutMs = 60000) {
  if (!playwrightChromium) return null;
  let browser;
  try {
    browser = await playwrightChromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(300);
    for (const sel of HEADING_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const txt = await page.evaluate(e => e.innerText || e.textContent || '', el);
        const found = extractCountFromHeadingText(txt, keywords);
        if (found !== null) { await page.close(); await ctx.close(); await browser.close(); return found; }
        // try heading + nextSibling text
        const nextText = await page.evaluate(e => {
          const n = e.nextElementSibling;
          return n ? (n.innerText || n.textContent || '') : '';
        }, el);
        const found2 = extractCountFromHeadingText(nextText, keywords);
        if (found2 !== null) { await page.close(); await ctx.close(); await browser.close(); return found2; }
      } catch (e) {}
    }
    // fallback: body snippet (first 2000 chars)
    const whole = await page.evaluate(() => document.body ? document.body.innerText : '');
    await page.close();
    await ctx.close();
    await browser.close();
    if (whole) {
      const snippet = whole.slice(0, 2000);
      const found = extractCountFromHeadingText(snippet, keywords);
      if (found !== null) return found;
    }
    return null;
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    return null;
  }
}

/* ---------------- core route ---------------- */

app.get('/', (_req, res) => res.send('Hofer checker alive'));

app.get('/check-hofer', async (req, res) => {
  try {
    // optional secret header
    const secret = process.env.SCRAPER_SECRET;
    if (secret) {
      const header = req.get('x-scraper-secret');
      if (!header || header !== secret) return res.status(401).json({ error: 'unauthorized' });
    }

    const result = { timestamp: new Date().toISOString(), countries: {} };

    for (const c of COUNTRIES) {
      const country = { datePlpsFound: 0, plps: [], unknowns: [] };
      const listingUrl = new URL(c.listingPath || '/', c.base).toString();

      // always include listing root
      const pagesSet = new Set([listingUrl]);

      // fetch listing page and extract only date PLPs
      const listingHtml = await tryFetchHtml(listingUrl, 20000);
      if (listingHtml) {
        const dates = findDatePlpsOnly(listingHtml, c.base);
        dates.forEach(p => pagesSet.add(p));
      }

      // ensure unique array
      const pages = Array.from(pagesSet);

      for (const pageUrl of pages) {
        try {
          // extraction strategy:
          // 1) fetch HTML and attempt heading-based extraction
          // 2) if not found and domain is in ALWAYS_RENDER_DOMAINS or playwright present, use Playwright selectors
          // 3) fallback: small snippet scan of beginning of HTML (first ~1500 chars) for keywords
          let count = null;
          let html = await tryFetchHtml(pageUrl, 20000);

          // helper to clamp/sanity-check results
          const sanity = v => {
            if (v === null || v === undefined) return null;
            if (typeof v !== 'number') return null;
            if (!Number.isFinite(v)) return null;
            // cap unrealistic numbers (avoid picking IDs etc)
            if (v < 0) return null;
            if (v > 5000) return null; // safe upper bound
            return v;
          };

          if (html) {
            // try heading-based regex on HTML head/body near top
            // search for headings (<h1...> etc) and analyze their text
            for (const hsel of ['<h1', '<h2', 'class="page-title', 'class="headline', 'class="page-header', 'class="title']) {
              const pos = html.toLowerCase().indexOf(hsel);
              if (pos >= 0) {
                const chunk = html.slice(Math.max(0, pos - 200), pos + 1200); // nearby region
                // remove tags to plain text for extraction
                const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                const found = extractCountFromHeadingText(text, KEYWORDS[c.code] || []);
                const s = sanity(found);
                if (s !== null) { count = s; break; }
              }
            }
          }

          // if not found, consider Playwright (either available or forced)
          const host = new URL(pageUrl).hostname;
          const forceRender = ALWAYS_RENDER_DOMAINS.some(d => host.includes(d));
          if (count === null && (playwrightChromium || forceRender)) {
            const fromPlay = await extractCountBySelectorsPlaywright(pageUrl, KEYWORDS[c.code] || [], 60000);
            const s2 = sanity(fromPlay);
            if (s2 !== null) count = s2;
          }

          // fallback: small snippet of HTML (first 1500 chars)
          if (count === null && html) {
            const snippet = html.slice(0, 1500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const f = extractCountFromHeadingText(snippet, KEYWORDS[c.code] || []);
            const s3 = sanity(f);
            if (s3 !== null) count = s3;
          }

          // final fallback: render body and search small snippet
          if (count === null && (playwrightChromium || forceRender)) {
            const bodyText = await renderPageTextWithPlaywright(pageUrl, 45000);
            if (bodyText) {
              const snippet = bodyText.slice(0, 2000);
              const f = extractCountFromHeadingText(snippet, KEYWORDS[c.code] || []);
              const s4 = sanity(f);
              if (s4 !== null) count = s4;
            }
          }

          // store: 'unknown' if null
          country.plps.push({ url: pageUrl, count: count === null ? 'unknown' : count });

        } catch (perPageErr) {
          country.unknowns.push({ url: pageUrl, reason: String(perPageErr) });
        }
      }

      country.datePlpsFound = country.plps.filter(p => /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url)).length;
      result.countries[c.code] = country;
    }

    // output format handling
    const wantsTxt = (req.query.format && req.query.format.toLowerCase() === 'txt') ||
                     (req.get('accept') && req.get('accept').toLowerCase().includes('text/plain'));

    if (wantsTxt) {
      const lines = [];
      for (const [code, c] of Object.entries(result.countries)) {
        lines.push(code);
        lines.push(`Date plps found - ${c.datePlpsFound}`);
        // list date-PLPs
        const dates = (c.plps || []).filter(p => /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url));
        for (const p of dates) lines.push(`${p.url} - Product found ${p.count}`);
        lines.push('');
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(lines.join('\n'));
    }

    return res.json(result);

  } catch (err) {
    console.error('Fatal error', err && (err.stack || err));
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Hofer checker listening on port ${PORT}`);
});
