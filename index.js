/**
 * index.js - Hofer / ALDI multi-country checker (improved)
 *
 * - Fetch-first, Playwright fallback for dynamic pages
 * - Per-country keyword map tuned for AT/CH/HU/DE/SI/IT
 * - Normalizes numbers with dots/commas/spaces
 * - Supports ?format=txt or Accept: text/plain
 * - Optional SCRAPER_SECRET header check
 *
 * Requirements:
 * - Node 18+ recommended (global fetch available)
 * - Playwright optional: if installed and available, the script will use it for rendering
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// attempt to require playwright (optional)
let playwrightChromium = null;
try {
  playwrightChromium = require('playwright').chromium;
  console.log('Playwright available.');
} catch (e) {
  console.log('Playwright not available:', e.message ? e.message.split('\n')[0] : e);
}

// Countries config
const COUNTRIES = [
  { code: 'AT', base: 'https://www.hofer.at', listingPath: '/de/angebote' },
  { code: 'CH', base: 'https://www.aldi-suisse.ch', listingPath: '/de/aktionen-und-angebote' },
  { code: 'HU', base: 'https://www.aldi.hu', listingPath: '/hu/ajanlatok' },
  { code: 'DE', base: 'https://www.aldi-sued.de', listingPath: '/de/angebote' },
  { code: 'SI', base: 'https://www.hofer.si', listingPath: '/sl/ponudba' },
  { code: 'IT', base: 'https://www.aldi.it', listingPath: '/it/offerte-settimanali' }
];

// per-country keywords (expanded / localized)
const KEYWORD_MAP = {
  AT: ['Aktionsartikel', 'Aktionsartikel gefunden', 'Aktionsartikel gefunden', 'Aktionsartikel'],
  CH: ['Aktionsartikel', 'Aktionsartikel gefunden', 'Aktionsartikel'],
  HU: ['ajánlat', 'ajánlatok', 'ajánlat található', 'ajánlatok találhatók', 'ajánlatok talál'],
  DE: ['Angebot', 'Angebote', 'Angebote gefunden', 'Angebot gefunden', 'Angebote gefunden'],
  SI: ['ponudba', 'najdenih', 'najdenih izdelkov', 'izdelkov', 'najdenih izdelkov posebne ponudbe'],
  IT: ['offerta', 'offerte', 'Prodotto in offerta', 'offerte trovate']
};

// domains we should always attempt Playwright rendering for (problematic / JS-heavy)
const ALWAYS_RENDER_DOMAINS = ['aldi.hu', 'aldi-sued.de', 'hofer.si'];

/* ---------- helpers ---------- */

function escapeRegex(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// normalize numbers such as "1.234", "1,234", "1 234", "1 234"
function normalizeNumberString(numStr) {
  if (!numStr) return null;
  // replace non-breaking spaces with normal space
  const cleanedSpaces = numStr.replace(/\u00A0|\u202F/g, ' ');
  // remove thousand separators: dot, comma or space when followed by three digits
  const removedThousands = cleanedSpaces.replace(/(?<=\d)[\.\, ](?=\d{3}\b)/g, '');
  // remove other non-digit characters except leading minus
  const digitsOnly = removedThousands.replace(/[^\d\-]/g, '');
  if (!digitsOnly) return null;
  const v = parseInt(digitsOnly, 10);
  return Number.isFinite(v) ? v : null;
}

// Try to fetch HTML with global fetch (Node 18+). Returns text or null.
async function tryFetchHtml(url, timeout = 20000) {
  if (typeof fetch !== 'function') return null;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'de-DE,de;q=0.9'
      },
      signal: controller.signal
    });
    clearTimeout(id);
    if (!resp.ok) return null;
    const text = await resp.text();
    return text;
  } catch (e) {
    // console.log('fetch error', url, e && e.message ? e.message : e);
    return null;
  }
}

// extract anchors (href+text) from HTML
function extractAnchorsFromHtml(html) {
  const hrefs = [];
  if (!html) return hrefs;
  const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gsi;
  let m;
  while ((m = re.exec(html)) !== null) {
    hrefs.push({ href: m[2], text: (m[3] || '').replace(/<[^>]*>/g, '').trim() });
  }
  return hrefs;
}

// extract explicit date-PLP patterns like /d.08-12-2025.html
function extractDatePlpLinksFromHtml(html, base) {
  const set = new Set();
  if (!html) return set;
  const re = /(?:href=)?["']?([^"'\s>]*\/d\.\d{2}-\d{2}-\d{4}\.html)["']?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    const abs = href.startsWith('http') ? href : new URL(href, base).toString();
    set.add(abs.split('#')[0].split('?')[0]);
  }
  return set;
}

// normalize and collect likely PLP URLs (date pages or listing-like)
function normalizeAndCollect(href, base, set, listingPath = '') {
  if (!href) return;
  if (href.startsWith('javascript:')) return;
  // skip mailto
  if (href.startsWith('mailto:')) return;
  const isInternal = href.startsWith('/') || href.includes(new URL(base).hostname);
  if (!isInternal) return;
  const looksLikePlp = /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(href) || href.toLowerCase().includes('/d.');
  const containsListing = listingPath && href.toLowerCase().includes(listingPath.toLowerCase());
  if (looksLikePlp || containsListing || href.toLowerCase().includes('/angebote') || href.toLowerCase().includes('/offerte') || href.toLowerCase().includes('/anj')) {
    const abs = href.startsWith('http') ? href : new URL(href, base).toString();
    set.add(abs.split('#')[0].split('?')[0]);
  }
}

// improved extraction from text using keywords + normalization
function extractCountFromTextImproved(text, keywords = []) {
  if (!text) return null;
  const normalized = text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  // try patterns number <-> keyword
  for (const kw of (keywords || [])) {
    if (!kw) continue;
    const re1 = new RegExp('(\\d{1,6}[\\d\\.,\\u00A0\\u202F]*)[^\\d\\n\\r]{0,40}' + escapeRegex(kw), 'i');
    const m1 = normalized.match(re1);
    if (m1 && m1[1]) {
      const val = normalizeNumberString(m1[1]);
      if (val !== null) return val;
    }
    const re2 = new RegExp(escapeRegex(kw) + '[^\\d\\n\\r]{0,40}(\\d{1,6}[\\d\\.,\\u00A0\\u202F]*)', 'i');
    const m2 = normalized.match(re2);
    if (m2 && m2[1]) {
      const val = normalizeNumberString(m2[1]);
      if (val !== null) return val;
    }
  }

  // lines scanning
  const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const kw of (keywords || [])) {
      if (lines[i].toLowerCase().includes((kw || '').toLowerCase())) {
        // number same line
        const mm = lines[i].match(/(\d{1,6}[\d\.,\u00A0\u202F]*)/);
        if (mm && mm[1]) {
          const val = normalizeNumberString(mm[1]);
          if (val !== null) return val;
        }
        // prev line
        if (i > 0) {
          const mm2 = lines[i-1].match(/(\d{1,6}[\d\.,\u00A0\u202F]*)/);
          if (mm2 && mm2[1]) {
            const v = normalizeNumberString(mm2[1]);
            if (v !== null) return v;
          }
        }
        // next line
        if (i + 1 < lines.length) {
          const mm3 = lines[i+1].match(/(\d{1,6}[\d\.,\u00A0\u202F]*)/);
          if (mm3 && mm3[1]) {
            const v2 = normalizeNumberString(mm3[1]);
            if (v2 !== null) return v2;
          }
        }
      }
    }
  }

  // last resort: pick largest numeric-looking token if > 1
  const all = Array.from(normalized.matchAll(/(\d{1,6}[\d\.,\u00A0\u202F]*)/g)).map(m => normalizeNumberString(m[1])).filter(x => x !== null);
  if (all.length) {
    const max = Math.max(...all);
    if (max > 1) return max;
  }
  return null;
}

// Playwright render: returns textual content of page (body.innerText) or null
async function renderPageTextWithPlaywright(url, timeoutMs = 90000) {
  if (!playwrightChromium) return null;
  let browser = null;
  try {
    browser = await playwrightChromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(e => { /* ignore goto timeout */ });
    // give some time for JS to settle
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    await page.close();
    await context.close();
    await browser.close();
    return text;
  } catch (e) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    console.log('Playwright render error for', url, e && e.message ? e.message.split('\n')[0] : e);
    return null;
  }
}

// Use playwright page to try some selectors (returns first numeric found or null)
async function extractCountUsingPlaywrightSelectors(url, timeoutMs = 90000, keywords = []) {
  if (!playwrightChromium) return null;
  let browser = null;
  try {
    browser = await playwrightChromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(300);
    // candidate selectors - common header/title elements
    const selectors = ['.page-title', 'h1', 'h2', '.results-count', '.product-count', '.headline__count', '.page-header', '.breadcrumbs'];
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const txt = await page.evaluate(e => e.innerText || e.textContent || '', el);
        const c = extractCountFromTextImproved(txt, keywords);
        if (c !== null) {
          await page.close();
          await context.close();
          await browser.close();
          return c;
        }
      } catch (e) { /* ignore and continue */ }
    }
    // fallback: whole-body text
    const whole = await page.evaluate(() => document.body ? document.body.innerText : '');
    const c2 = extractCountFromTextImproved(whole, keywords);
    await page.close();
    await context.close();
    await browser.close();
    return c2;
  } catch (e) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    console.log('Playwright selector extraction error for', url, e && e.message ? e.message.split('\n')[0] : e);
    return null;
  }
}

/* ---------- Routes ---------- */

app.get('/', (_req, res) => res.send('Hofer checker alive'));

// main check endpoint
app.get('/check-hofer', async (req, res) => {
  try {
    // optional secret
    const secret = process.env.SCRAPER_SECRET;
    if (secret) {
      const header = req.get('x-scraper-secret');
      if (!header || header !== secret) return res.status(401).json({ error: 'unauthorized' });
    }

    const overall = { timestamp: new Date().toISOString(), countries: {} };

    for (const c of COUNTRIES) {
      const countryResult = { datePlpsFound: 0, plps: [], unknowns: [] };
      const listingUrl = new URL(c.listingPath || '/', c.base).toString();
      try {
        const listingHtml = await tryFetchHtml(listingUrl, 25000);
        const pagesSet = new Set();

        if (listingHtml) {
          // anchors
          const anchors = extractAnchorsFromHtml(listingHtml);
          anchors.forEach(a => normalizeAndCollect(a.href, c.base, pagesSet, c.listingPath));
          // explicit date PLPs
          const datePlps = extractDatePlpLinksFromHtml(listingHtml, c.base);
          datePlps.forEach(p => pagesSet.add(p));
        } else {
          pagesSet.add(listingUrl);
        }

        // always include listing page
        pagesSet.add(listingUrl);

        // probe each unique page
        const pagesArray = Array.from(pagesSet);

        for (const pageUrl of pagesArray) {
          try {
            const host = new URL(pageUrl).hostname;
            const forceRender = ALWAYS_RENDER_DOMAINS.some(d => host.includes(d));
            // fetch-first
            let htmlText = await tryFetchHtml(pageUrl, 20000);
            let count = null;
            // attempt text extraction if we have html
            if (htmlText) {
              count = extractCountFromTextImproved(htmlText, KEYWORD_MAP[c.code] || []);
            }
            // if not found or forced, try Playwright selectors/render
            if (count === null && (playwrightChromium || forceRender)) {
              // prefer selector extraction if playwright available
              const cFromSelectors = await extractCountUsingPlaywrightSelectors(pageUrl, 90000, KEYWORD_MAP[c.code] || []);
              if (cFromSelectors !== null) {
                count = cFromSelectors;
              } else {
                // fallback: render body text & try improved extractor
                const rendered = await renderPageTextWithPlaywright(pageUrl, 90000);
                if (rendered) {
                  const c2 = extractCountFromTextImproved(rendered, KEYWORD_MAP[c.code] || []);
                  if (c2 !== null) count = c2;
                }
              }
            }

            // normalization - if count is exactly 0/nan etc, keep null to mark unknown
            if (typeof count === 'number' && !Number.isFinite(count)) count = null;

            // push result
            countryResult.plps.push({ url: pageUrl, count: count === null ? 'unknown' : count });

          } catch (inner) {
            countryResult.unknowns.push({ url: pageUrl, reason: String(inner) });
          }
        }

        // count datePLPs (pattern /d.XX-XX-XXXX.html)
        countryResult.datePlpsFound = countryResult.plps.filter(p => /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url)).length;

      } catch (errCountry) {
        countryResult.error = String(errCountry);
      }

      overall.countries[c.code] = countryResult;
    }

    // prepare minimal plain text if requested
    const wantText = (req.query.format && req.query.format.toLowerCase() === 'txt') ||
                     (req.get('accept') && req.get('accept').toLowerCase().includes('text/plain'));

    // minimal summary structure for both outputs
    if (wantText) {
      const lines = [];
      for (const [code, cs] of Object.entries(overall.countries)) {
        lines.push(code);
        lines.push(`Date PLPs found - ${cs.datePlpsFound || 0}`);
        // list date PLPs first
        const datePlps = (cs.plps || []).filter(p => /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url));
        for (const p of datePlps) lines.push(`${p.url} - Product found ${p.count}`);
        // then others (optional)
        const otherPlps = (cs.plps || []).filter(p => !/\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(p.url));
        for (const p of otherPlps) lines.push(`${p.url} - Product found ${p.count}`);
        lines.push('');
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(lines.join('\n'));
    }

    // default JSON response
    return res.json(overall);

  } catch (e) {
    console.error('Fatal /check-hofer error:', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`Hofer multi-checker listening on port ${PORT}`));
