require('dotenv/config');

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const PRODUCT_URL = process.env.PRODUCT_URL;
const TARGET_SIZE = process.env.TARGET_SIZE || 'Womens 7';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;
const DEBUG = /^true$/i.test(process.env.DEBUG_STOCK_CHECKER || '');
const STATUS_FILE = path.join(process.cwd(), '.last-status.json');

function log(message) {
  console.log(`[stock-checker] ${message}`);
}

function debug(message, data) {
  if (!DEBUG) return;
  if (data === undefined) {
    log(`DEBUG ${message}`);
    return;
  }
  log(`DEBUG ${message}: ${JSON.stringify(data, null, 2)}`);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/women's/g, 'womens')
    .replace(/woman's/g, 'womens')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function targetNumber(targetSize) {
  const match = normalizeText(targetSize).match(/\b\d+(?:\.\d+)?\b/);
  return match ? match[0] : '';
}

function matchesTarget(candidate, targetSize) {
  const text = normalizeText(candidate.searchText);
  const target = normalizeText(targetSize);
  const sizeNumber = targetNumber(targetSize);

  if (!text || !sizeNumber) return false;
  if (text === target) return true;

  const explicitPatterns = [
    `womens ${sizeNumber}`,
    `women ${sizeNumber}`,
    `w ${sizeNumber}`,
    `size ${sizeNumber}`,
    `us ${sizeNumber}`,
    `us w ${sizeNumber}`,
    `us womens ${sizeNumber}`
  ];

  if (explicitPatterns.some((pattern) => text.includes(pattern))) return true;
  if (text === sizeNumber) return true;

  return false;
}

function hasUnavailableSignal(candidate) {
  const haystack = normalizeText([
    candidate.text,
    candidate.ariaLabel,
    candidate.title,
    candidate.className,
    candidate.disabledReason,
    JSON.stringify(candidate.attributes || {})
  ].join(' '));

  const unavailableWords = [
    'disabled',
    'aria disabled true',
    'unavailable',
    'sold out',
    'out of stock',
    'outofstock',
    'not available',
    'inactive',
    'oos'
  ];

  if (candidate.disabled) return { unavailable: true, reason: 'native disabled attribute is set' };
  if (candidate.ariaDisabled === 'true') return { unavailable: true, reason: 'aria-disabled=true' };
  if (candidate.dataDisabled === 'true') return { unavailable: true, reason: 'data-disabled=true' };
  if (candidate.dataAvailable === 'false') return { unavailable: true, reason: 'data-available=false' };
  if (candidate.dataInStock === 'false') return { unavailable: true, reason: 'data-in-stock=false' };

  const word = unavailableWords.find((signal) => haystack.includes(signal));
  if (word) return { unavailable: true, reason: `matched unavailable signal "${word}"` };

  return { unavailable: false, reason: 'no disabled, sold out, or unavailable signals found' };
}

function inferAvailability(match) {
  const unavailable = hasUnavailableSignal(match);
  if (unavailable.unavailable) {
    return {
      available: false,
      reason: unavailable.reason
    };
  }

  const positiveSignals = normalizeText([
    match.dataAvailable,
    match.dataInStock,
    match.attributes?.['data-status'],
    match.attributes?.['data-stock'],
    match.attributes?.['data-available']
  ].join(' '));

  if (positiveSignals.includes('true') || positiveSignals.includes('available') || positiveSignals.includes('in stock')) {
    return {
      available: true,
      reason: 'matched size has positive availability attributes and no unavailable signals'
    };
  }

  return {
    available: true,
    reason: 'matched size control appears enabled and has no unavailable signals'
  };
}

async function extractSizeCandidates(page) {
  return page.evaluate(() => {
    const selector = [
      'button',
      '[role="button"]',
      '[role="option"]',
      'option',
      'label',
      'input[type="radio"]',
      'input[type="checkbox"]',
      '[aria-label]',
      '[data-size]',
      '[data-value]',
      '[data-option-value]',
      '[data-testid*="size" i]',
      '[class*="size" i]'
    ].join(',');

    function visibleEnough(element) {
      if (element.tagName === 'OPTION') return true;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    }

    function ownText(element) {
      if (element.tagName === 'INPUT') {
        const labels = Array.from(element.labels || []).map((label) => label.innerText).join(' ');
        const adjacentLabel = element.id
          ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText || ''
          : '';
        return [labels, adjacentLabel, element.value].filter(Boolean).join(' ');
      }
      return [element.innerText, element.textContent, element.value].filter(Boolean).join(' ');
    }

    function attrs(element) {
      const names = [
        'aria-label',
        'aria-disabled',
        'title',
        'class',
        'disabled',
        'data-disabled',
        'data-available',
        'data-in-stock',
        'data-size',
        'data-value',
        'data-option-value',
        'data-status',
        'data-stock',
        'value',
        'name',
        'id',
        'role'
      ];
      return Object.fromEntries(names
        .map((name) => [name, element.getAttribute(name)])
        .filter(([, value]) => value !== null && value !== ''));
    }

    function contextText(element) {
      const parent = element.closest('fieldset, [class*="size" i], [id*="size" i], [data-testid*="size" i], form, section, div');
      return parent ? parent.innerText.slice(0, 300) : '';
    }

    const seen = new Set();
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => {
        if (!visibleEnough(element)) return false;
        const key = `${element.tagName}:${element.innerText}:${element.getAttribute('aria-label')}:${element.getAttribute('value')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((element, index) => {
        const attributes = attrs(element);
        const text = ownText(element).trim();
        const className = element.className ? String(element.className) : '';
        const ariaLabel = element.getAttribute('aria-label') || '';
        const title = element.getAttribute('title') || '';
        const disabled = Boolean(element.disabled || element.hasAttribute('disabled'));
        const closestDisabled = Boolean(element.closest('[disabled], [aria-disabled="true"], .disabled, .unavailable, .sold-out, .out-of-stock, .inactive'));
        const searchText = [
          text,
          ariaLabel,
          title,
          attributes['data-size'],
          attributes['data-value'],
          attributes['data-option-value'],
          attributes.value,
          contextText(element)
        ].filter(Boolean).join(' ');

        return {
          index,
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          text,
          ariaLabel,
          title,
          className,
          attributes,
          disabled,
          ariaDisabled: element.getAttribute('aria-disabled') || '',
          dataDisabled: element.getAttribute('data-disabled') || '',
          dataAvailable: element.getAttribute('data-available') || '',
          dataInStock: element.getAttribute('data-in-stock') || '',
          disabledReason: closestDisabled ? 'closest disabled/unavailable ancestor or class matched' : '',
          searchText
        };
      });
  });
}

async function sendDiscordNotification(message) {
  if (!DISCORD_WEBHOOK_URL) return false;

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message })
  });

  if (!response.ok) {
    throw new Error(`Discord notification failed with HTTP ${response.status}: ${await response.text()}`);
  }

  log('Sent Discord notification.');
  return true;
}

async function sendEmailNotification(subject, message) {
  if (!RESEND_API_KEY || !EMAIL_TO || !EMAIL_FROM) return false;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject,
      text: message
    })
  });

  if (!response.ok) {
    throw new Error(`Resend notification failed with HTTP ${response.status}: ${await response.text()}`);
  }

  log('Sent Resend email notification.');
  return true;
}

async function readLastStatus() {
  if (process.env.CI) return null;
  try {
    return JSON.parse(await fs.readFile(STATUS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeLastStatus(status) {
  if (process.env.CI) return;
  await fs.writeFile(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`);
}

async function notifyIfNeeded(result) {
  const timestamp = new Date().toISOString();
  const lastStatus = await readLastStatus();
  const status = {
    productUrl: PRODUCT_URL,
    targetSize: TARGET_SIZE,
    available: result.available,
    checkedAt: timestamp
  };

  if (!result.available) {
    await writeLastStatus(status);
    return;
  }

  if (
    lastStatus
    && lastStatus.productUrl === PRODUCT_URL
    && lastStatus.targetSize === TARGET_SIZE
    && lastStatus.available === true
  ) {
    log('Skipping notification because local .last-status.json already recorded this size as available.');
    await writeLastStatus(status);
    return;
  }

  const message = [
    'Joe\'s New Balance stock checker: target size may be available.',
    '',
    `Product URL: ${PRODUCT_URL}`,
    `Target size: ${TARGET_SIZE}`,
    `Checked at: ${timestamp}`,
    '',
    'Warning: This is a best-effort availability check. Confirm manually before taking action.'
  ].join('\n');

  let sent = false;
  sent = (await sendDiscordNotification(message)) || sent;
  sent = (await sendEmailNotification(`Stock alert: ${TARGET_SIZE} may be available`, message)) || sent;

  if (!sent) {
    log('No notification provider configured. Set DISCORD_WEBHOOK_URL or Resend email variables to receive alerts.');
  }

  await writeLastStatus(status);
}

async function main() {
  if (!PRODUCT_URL) {
    throw new Error('PRODUCT_URL is required.');
  }

  log(`Checking ${PRODUCT_URL}`);
  log(`Target size: ${TARGET_SIZE}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (compatible; joes-nb-stock-checker/1.0; availability notification only)'
  });

  try {
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      log('Network did not become idle within 30 seconds; continuing with loaded DOM.');
    });

    const candidates = await extractSizeCandidates(page);
    const matches = candidates.filter((candidate) => matchesTarget(candidate, TARGET_SIZE));

    log(`Found ${candidates.length} possible option/control elements.`);
    log(`Found ${matches.length} candidate match(es) for "${TARGET_SIZE}".`);
    debug('all candidates', candidates.map((candidate) => ({
      index: candidate.index,
      tagName: candidate.tagName,
      text: candidate.text,
      ariaLabel: candidate.ariaLabel,
      attributes: candidate.attributes,
      className: candidate.className
    })));

    if (matches.length > 0) {
      log('Matching size options:');
      for (const match of matches) {
        const availability = inferAvailability(match);
        log(`- [${match.index}] <${match.tagName}> text="${match.text || '(none)'}" aria-label="${match.ariaLabel || '(none)'}" -> ${availability.available ? 'available' : 'unavailable'} (${availability.reason})`);
      }
    }

    const availableMatch = matches.find((match) => inferAvailability(match).available);
    const result = availableMatch
      ? {
          available: true,
          reason: inferAvailability(availableMatch).reason,
          match: availableMatch
        }
      : {
          available: false,
          reason: matches.length === 0
            ? `No size option matched "${TARGET_SIZE}".`
            : 'All matching size options appeared disabled, sold out, or unavailable.'
        };

    log(`Conclusion: ${TARGET_SIZE} ${result.available ? 'may be available' : 'does not appear available'} (${result.reason})`);
    await notifyIfNeeded(result);
  } catch (error) {
    await page.screenshot({ path: 'debug-page.png', fullPage: true }).catch(() => {});
    log('Saved debug-page.png after failure, if the page was available.');
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[stock-checker] ERROR ${error.stack || error.message}`);
  process.exitCode = 1;
});
