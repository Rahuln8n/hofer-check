/**
 * Hofer-checker service (updated)
 * - Express server
 * - GET / -> health
 * - GET /check-hofer -> scraper (fetch-first then Playwright fallback)
 * - Improved discovery: explicitly finds date-specific PLP links like /d.08-12-2025.html
 *
 * Notes:
 * - Protect endpoint by setting SCRAPER_SECRET env var in Render and sending header
 *   x-scraper-secret: <secret>
 * - The handler may take up to ~60-120s on free Render instances.
 */

const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Health
app.get('/', (_req, res) => {
  res.send('Hofer checker alive');
});

/**
 * Helper: try to fetch HTML using global fetch (Node 18+). If no global fetch or fetch fails, return null.
 */
async function tryFetchHtml(url) {
  try {
    if (typeof fetch === 'function') {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'de-DE,de;q=0.9'
        }
      });
      if (!r || !r.ok) return null;
      return await r.text();
    }
  } catch (e) {
    console.log('fetch failed:', String(e).slice(0,300));
    return null;
  }
  return null;
}

/** Extract anchors quickly from HTML string (simple regex; good enough for discovery) */
function extractAnchorsFromHtml(html) {
  const hrefs = [];
  if (!html) return hrefs;
  try {
    const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      hrefs.push({ href: m[2], text: (m[3] || '').replace(/<[^>]*>/g, '').trim() });
    }
  } catch (e) {
    // ignore parse errors
  }
  return hrefs;
}

/** Normalize and collect only internal Angebote links */
function normalizeAndCollect(href, base, set) {
  if (!href) return;
  if (href.startsWith('javascript:')) return;
  const isInternal = href.startsWith('/') || href.includes('hofer.at');
  const looksLikeAngebote = href.toLowerCase().includes('/angebote') || /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(href);
  if (isInternal && looksLikeAngebote) {
    const abs = href.startsWith('http') ? href : new URL(href, base).toString();
    set.add(abs.split('#')[0].split('?')[0]);
  }
}

/** Find date-PLP links directly in raw HTML (in case anchors are not fully parsed) */
function extractDatePlpLinksFromHtml(html, base) {
  const set = new Set();
  if (!html) return set;
  try {
    const re = /(?:href=)?["']?([^"'\s>]*\/d\.\d{2}-\d{2}-\d{4}\.html)["']?/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (!href) continue;
      // normalize relative -> absolute
      const abs = href.startsWith('http') ? href : new URL(href, base).toString();
      set.add(abs.split('#')[0].split('?')[0]);
    }
  } catch (e) {
    // ignore
  }
  return set;
}

/** Main handler */
app.get('/check-hofer', async (req, res) => {
  const secret = process.env.SCRAPER_SECRET;
  if (secret) {
    const header = req.get('x-scraper-secret');
    if (!header || header !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const base = 'https://hofer.at';
  const results = [];
  const pagesToCheck = new Set();

  try {
    // 1) Try fetch-based discovery first (fast)
    console.log('Starting fetch-based discovery for', base);
    const homepageHtml = await tryFetchHtml(base + '/de/angebote');
    if (homepageHtml) {
      console.log('Homepage fetch succeeded, length=', homepageHtml.length);
      // anchors from HTML
      const anchors = extractAnchorsFromHtml(homepageHtml);
      for (const a of anchors) normalizeAndCollect(a.href, base, pagesToCheck);
      // also search raw HTML for explicit date-PLP links like /d.08-12-2025.html
      const plpSet = extractDatePlpLinksFromHtml(homepageHtml, base);
      for (const p of plpSet) pagesToCheck.add(p);
      console.log('Discovered via fetch: anchors=', anchors.length, 'plpLinks=', plpSet.size);
    } else {
      console.log('Homepage fetch not usable; will attempt Playwright discovery');
    }

    // Always include main listing page as fallback
    pagesToCheck.add(`${base}/de/angebote`);

    // 2) If no anchors from fetch, do Playwright discovery with retries
    if (pagesToCheck.size <= 1) { // only main listing present
      console.log('No anchors found by fetch, running Playwright discovery');
      let browser = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log('Discovery attempt', attempt);
          browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            locale: 'de-DE'
          });
          const page = await context.newPage();
          await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
          const navTimeout = 60000 * attempt; // 60s, 120s, 180s
          console.log('Playwright navigating to homepage with timeout', navTimeout);
          await page.goto(base + '/de/angebote', { waitUntil: 'domcontentloaded', timeout: navTimeout });
          await page.waitForTimeout(1200);
          const discoveryHtml = await page.content();
          await page.close();
          await context.close();
          await browser.close();
          browser = null;
          // anchors and explicit PLP links
          const anchors2 = extractAnchorsFromHtml(discoveryHtml || '');
          for (const a of anchors2) normalizeAndCollect(a.href, base, pagesToCheck);
          const plpSet2 = extractDatePlpLinksFromHtml(discoveryHtml || '', base);
          for (const p of plpSet2) pagesToCheck.add(p);
          if (pagesToCheck.size > 1) { // discovered something besides main listing
            console.log('Discovery found anchors, count=', pagesToCheck.size);
            break;
          }
        } catch (err) {
          console.log('Discovery attempt error:', String(err).slice(0,300));
          if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
          // small backoff
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    const pagesArray = Array.from(pagesToCheck);
    console.log('Final pages to check count=', pagesArray.length);

    // 3) For each page: try fetch first; if not sufficient, fallback to Playwright with improved waits
    for (const url of pagesArray) {
      console.log('Processing', url);
      try {
        // Fetch-first
        let bodyText = await tryFetchHtml(url);
        if (bodyText && /Aktionsartikel/i.test(bodyText)) {
          console.log('Found Aktionsartikel via fetch for', url);
          // parse number
          let count = null;
          const m = bodyText.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
          if (m && m[1]) count = parseInt(m[1], 10);
          if (count === null) {
            const m2 = bodyText.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
            if (m2 && m2[1]) count = parseInt(m2[1], 10);
          }
          results.push({ url, count, snippet: (bodyText.match(/.{0,120}Aktionsartikel.{0,120}/i) || [''])[0] });
          continue;
        }

        // Playwright fallback (2 attempts)
        let pageResult = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          let browser = null;
          try {
            console.log(`Playwright rendering ${url} (attempt ${attempt})`);
            browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await browser.newContext({
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
              viewport: { width: 1280, height: 900 },
              locale: 'de-DE'
            });
            const p = await context.newPage();
            await p.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });
            // Wait until network idle so client JS can render; generous timeout
            await p.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
            // Wait briefly for dynamic rendering
            try {
              await p.waitForFunction(() => /Aktionsartikel/i.test(document.body.innerText), { timeout: 8000 });
              console.log('Aktionsartikel text appeared in DOM for', url);
            } catch (e) {
              console.log('Aktionsartikel not detected within 8s on', url);
            }
            await p.waitForTimeout(700);
            const bt = await p.evaluate(() => document.body.innerText || '');

            // Try exact patterns
            let count = null;
            const m = bt.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
            if (m && m[1]) count = parseInt(m[1], 10);

            if (count === null) {
              const m2 = bt.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
              if (m2 && m2[1]) count = parseInt(m2[1], 10);
            }

            // fallback: look for lines near 'Aktionsartikel' for digits
            if (count === null) {
              const lines = bt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              for (let i = 0; i < lines.length; i++) {
                if (/Aktionsartikel/i.test(lines[i])) {
                  // same line
                  const mm = lines[i].match(/(\d{1,6})/);
                  if (mm && mm[1]) { count = parseInt(mm[1], 10); break; }
                  // prev line
                  if (i > 0) { const mm2 = lines[i-1].match(/(\d{1,6})/); if (mm2 && mm2[1]) { count = parseInt(mm2[1],10); break; } }
                  // next line
                  if (i+1 < lines.length) { const mm3 = lines[i+1].match(/(\d{1,6})/); if (mm3 && mm3[1]) { count = parseInt(mm3[1],10); break; } }
                }
              }
            }

            pageResult = { url, count, snippet: (bt.match(/.{0,120}Aktionsartikel.{0,120}/i) || [''])[0] };
            await p.close();
            await context.close();
            await browser.close();
            browser = null;
            break;
          } catch (innerErr) {
            console.log('Playwright page error:', String(innerErr).slice(0,400));
            if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        } // attempts

        if (pageResult) {
          results.push(pageResult);
        } else {
          results.push({ url, error: 'failed to fetch or render page' });
        }

      } catch (pageOuterErr) {
        console.log('outer error for url', url, String(pageOuterErr).slice(0,300));
        results.push({ url, error: String(pageOuterErr) });
      }
    } // for each page

    // Finalize
    const zeroPages = results.filter(r => r.count === 0);
    const unknownPages = results.filter(r => r.count === null && !r.error);

    return res.json({
      timestamp: new Date().toISOString(),
      totalChecked: results.length,
      zeroPages,
      unknownPages,
      all: results
    });

  } catch (err) {
    console.log('Top-level handler error:', String(err).slice(0,400));
    return res.status(500).json({ error: String(err) });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Hofer-checker listening on port ${PORT}`);
});
