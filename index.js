// replace your existing app.get('/check-hofer', ...) handler with this block
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

  // helper: try a simple HTTP fetch first (faster & less likely to be blocked)
  async function tryFetch(url) {
    try {
      if (!global.fetch) {
        // node <18 fallback: use undici if available (Playwright image usually has node >=18)
        const { fetch } = await import('node-fetch').catch(()=>({}));
        if (fetch) return await fetch(url).then(r => r.text());
        return null;
      }
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'de-DE,de;q=0.9'
        },
        // small timeout handled by Playwright environment, but fetch may hang so we keep it simple
      });
      if (!response || !response.ok) return null;
      return await response.text();
    } catch (err) {
      console.log('fetch error', String(err));
      return null;
    }
  }

  // helper: parse anchors from HTML string
  function extractAnchorsFromHtml(html) {
    try {
      // quick regex-based extract to avoid heavy HTML libs
      const hrefs = [];
      const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        hrefs.push({ href: m[2], text: (m[3] || '').replace(/<[^>]*>/g, '').trim() });
      }
      return hrefs;
    } catch (e) {
      return [];
    }
  }

  // try fetch on homepage
  let homepageHtml = await tryFetch(base);
  if (homepageHtml) {
    console.log('fetch homepage ok, length=', homepageHtml.length);
  } else {
    console.log('fetch homepage failed or returned non-ok');
  }

  // collect links from homepage fetch (fallback to Playwright discovery if empty)
  let anchors = [];
  if (homepageHtml) {
    anchors = extractAnchorsFromHtml(homepageHtml);
  }

  // If fetch didn't produce useful anchors, we will fallback to using Playwright to open homepage
  // and collect anchors. We'll implement a retry with larger timeouts for Playwright navigation.
  let pagesToCheck = new Set();

  // function to normalize and keep internal Angebote links
  function normalizeAndCollect(aHref) {
    if (!aHref) return;
    if (aHref.startsWith('javascript:')) return;
    const isInternal = aHref.startsWith('/') || aHref.includes('hofer.at');
    const looksLikeAngebote = aHref.toLowerCase().includes('/angebote') || /\/d\.\d{2}-\d{2}-\d{4}\.html/i.test(aHref);
    if (isInternal && looksLikeAngebote) {
      const abs = aHref.startsWith('http') ? aHref : new URL(aHref, base).toString();
      pagesToCheck.add(abs.split('#')[0].split('?')[0]);
    }
  }

  for (const a of anchors) normalizeAndCollect(a.href);

  // If no anchors found via fetch, fallback to Playwright to discover anchors (with retry)
  let browser;
  try {
    if (pagesToCheck.size === 0) {
      console.log('no anchors from fetch, starting Playwright discovery');

      // retry loop for Playwright navigation with increasing timeouts
      let discoveryHtml = null;
      const maxDiscoveryAttempts = 3;
      for (let attempt = 1; attempt <= maxDiscoveryAttempts; attempt++) {
        try {
          console.log(`discovery attempt ${attempt}`);
          browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            locale: 'de-DE'
          });
          const page = await context.newPage();

          // extra headers to look more like a real browser
          await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });

          // longer timeout for slow networks / cold start
          const navTimeout = 60000 * attempt; // 60s, 120s, 180s
          console.log('going to homepage with timeout', navTimeout);
          await page.goto(base, { waitUntil: 'domcontentloaded', timeout: navTimeout });
          await page.waitForTimeout(1200);
          discoveryHtml = await page.content();
          await page.close();
          await context.close();
          await browser.close();
          browser = null;
          console.log('discovery succeeded on attempt', attempt, 'length', discoveryHtml?.length || 0);
          break;
        } catch (err) {
          console.log('discovery attempt error', attempt, String(err).slice(0,200));
          if (browser) {
            try { await browser.close(); } catch(e) {}
            browser = null;
          }
          // short delay before retry
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      } // end attempts

      if (discoveryHtml) {
        const anchors2 = extractAnchorsFromHtml(discoveryHtml);
        for (const a of anchors2) normalizeAndCollect(a.href);
      }
    } // end discovery
  } catch (err) {
    console.log('unexpected discovery error', String(err));
    if (browser) { try { await browser.close(); } catch(e){} }
  }

  // final pagesToCheck list (always include main listing)
  if (!pagesToCheck.has(`${base}/de/angebote`)) pagesToCheck.add(`${base}/de/angebote`);
  const pagesArray = Array.from(pagesToCheck);

  console.log('pages to check count=', pagesArray.length);

  // Now check pages. Strategy:
  // - try fetching the page HTML first (fast)
  // - if fetch is missing the Aktionsartikel text, fall back to Playwright (with retry)
  for (const url of pagesArray) {
    console.log('processing', url);
    try {
      // try fetch first
      let bodyText = await tryFetch(url);
      if (bodyText && /Aktionsartikel/i.test(bodyText)) {
        console.log('found Aktionsartikel via fetch for', url);
        // parse the number
        let count = null;
        const m = bodyText.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
        if (m && m[1]) count = parseInt(m[1], 10);
        if (count === null) {
          const m2 = bodyText.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
          if (m2 && m2[1]) count = parseInt(m2[1], 10);
        }
        results.push({ url, count, snippet: (bodyText.match(/.{0,80}Aktionsartikel.{0,80}/i) || [''])[0] });
        continue;
      }

      // fallback to Playwright for this single page. We'll try up to 2 attempts with longer timeout
      let pageResult = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`playwright open ${url} attempt ${attempt}`);
          browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            locale: 'de-DE'
          });
          await context.setDefaultNavigationTimeout(120000); // 120s
          const p = await context.newPage();
          await p.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });

          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
          await p.waitForTimeout(900);
          const bt = await p.evaluate(() => document.body.innerText || '');
          // parse
          let count = null;
          const m = bt.match(/(\d{1,6})\s+Aktionsartikel\s+gefunden/i);
          if (m && m[1]) count = parseInt(m[1], 10);
          if (count === null) {
            const m2 = bt.match(/(\d{1,6})[^0-9\n\r]{0,20}Aktionsartikel/i);
            if (m2 && m2[1]) count = parseInt(m2[1], 10);
          }
          pageResult = { url, count, snippet: (bt.match(/.{0,80}Aktionsartikel.{0,80}/i) || [''])[0] };
          await p.close();
          await context.close();
          await browser.close();
          browser = null;
          break;
        } catch (err) {
          console.log(`playwright error for ${url} attempt ${attempt}:`, String(err).slice(0,300));
          if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      } // attempts

      if (pageResult) results.push(pageResult);
      else results.push({ url, error: 'failed to fetch or render page' });

    } catch (errOuter) {
      console.log('outer error for', url, String(errOuter).slice(0,200));
      results.push({ url, error: String(errOuter) });
      if (browser) { try { await browser.close(); } catch(e){}; browser = null; }
    }
  } // end for pagesArray

  // ensure browser closed
  if (browser) {
    try { await browser.close(); } catch(e) {}
  }

  const zeroPages = results.filter(r => r.count === 0);
  const unknownPages = results.filter(r => r.count === null && !r.error);

  return res.json({
    timestamp: new Date().toISOString(),
    totalChecked: results.length,
    zeroPages,
    unknownPages,
    all: results
  });
});
