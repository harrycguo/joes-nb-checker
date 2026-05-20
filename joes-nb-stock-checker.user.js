// ==UserScript==
// @name         Joe's New Balance Stock Checker
// @namespace    https://github.com/harrycguo/joes-nb-checker
// @version      1.0.0
// @description  Notification-only stock checker for Joe's New Balance product pages.
// @match        https://www.joesnewbalanceoutlet.com/pd/*
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG_KEY = 'joesNbStockCheckerConfig';
  const LAST_STATUS_KEY = 'joesNbStockCheckerLastStatus';
  const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
  const DEFAULT_TARGET_SIZE = 'Womens 7';

  function log(message, data) {
    if (data === undefined) {
      console.log(`[joes-nb-stock-checker] ${message}`);
      return;
    }
    console.log(`[joes-nb-stock-checker] ${message}`, data);
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

    return [
      `womens ${sizeNumber}`,
      `womens${sizeNumber}`,
      `women ${sizeNumber}`,
      `women${sizeNumber}`,
      `w ${sizeNumber}`,
      `w${sizeNumber}`,
      `size ${sizeNumber}`,
      `us ${sizeNumber}`,
      `us w ${sizeNumber}`,
      `us w${sizeNumber}`,
      `us womens ${sizeNumber}`
    ].some((pattern) => text.includes(pattern));
  }

  function loadConfig() {
    const raw = localStorage.getItem(CONFIG_KEY);
    const existing = JSON.parse(raw || '{}');
    const config = {
      targetSize: existing.targetSize || DEFAULT_TARGET_SIZE,
      intervalMs: Number(existing.intervalMs || DEFAULT_INTERVAL_MS),
      discordWebhookUrl: existing.discordWebhookUrl || ''
    };

    if (!raw) {
      const webhook = window.prompt("Discord webhook URL for Joe's NB stock alerts:");
      if (webhook) config.discordWebhookUrl = webhook.trim();

      const target = window.prompt('Target size:', config.targetSize);
      if (target) config.targetSize = target.trim();
    }

    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    return config;
  }

  function buildVariationUrl() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);

    if (url.hash.startsWith('#')) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      for (const [key, value] of hashParams.entries()) {
        params.set(key, value);
      }
    }

    if (!params.get('pid')) {
      const productId = url.pathname.match(/\/pd\/[^/]+\/([^/?#]+)\.html/)?.[1];
      if (productId) params.set('pid', productId);
    }

    if (!params.get('quantity')) params.set('quantity', '1');
    return `${url.origin}/on/demandware.store/Sites-JNBO-Site/en_US/Product-Variation?${params.toString()}`;
  }

  function extractSizeCandidates(variationJson) {
    const attributes = variationJson?.product?.variationAttributes || [];
    const sizeAttribute = attributes.find((attribute) => attribute.attributeId === 'size' || attribute.id === 'size');

    return (sizeAttribute?.values || []).map((value, index) => ({
      index,
      displayValue: value.displayValue || value.value || value.id || '',
      searchText: [
        value.displayValue,
        value.value,
        value.id,
        value.size,
        value.variantID
      ].filter(Boolean).join(' '),
      selectable: value.selectable,
      fullyOOSInd: value.fullyOOSInd,
      isNonSellable: value.isNonSellable,
      isForcedSoldOut: value.isForcedSoldOut,
      variantID: value.variantID
    }));
  }

  function isAvailable(candidate) {
    return candidate
      && candidate.selectable === true
      && candidate.fullyOOSInd !== true
      && candidate.isNonSellable !== true
      && candidate.isForcedSoldOut !== true;
  }

  async function fetchVariationJson(variationUrl) {
    const response = await fetch(variationUrl, {
      credentials: 'include',
      headers: {
        accept: '*/*',
        'x-requested-with': 'XMLHttpRequest'
      }
    });

    if (!response.ok) {
      throw new Error(`Product-Variation returned HTTP ${response.status}`);
    }

    return response.json();
  }

  function sendDiscord(webhookUrl, message) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: webhookUrl,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ content: message }),
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve();
            return;
          }
          reject(new Error(`Discord returned HTTP ${response.status}: ${response.responseText}`));
        },
        onerror: () => reject(new Error('Discord request failed'))
      });
    });
  }

  async function checkNow(config, forceNotify = false) {
    const variationUrl = buildVariationUrl();
    log(`Checking ${variationUrl}`);

    const variationJson = await fetchVariationJson(variationUrl);
    const candidates = extractSizeCandidates(variationJson);
    const matches = candidates.filter((candidate) => matchesTarget(candidate, config.targetSize));
    const availableMatch = matches.find(isAvailable);
    const available = Boolean(availableMatch);
    const timestamp = new Date().toISOString();

    log(`Found ${candidates.length} size values.`);
    log(`Found ${matches.length} match(es) for ${config.targetSize}.`, matches);
    log(`Conclusion: ${config.targetSize} ${available ? 'may be available' : 'does not appear available'}.`);

    const lastStatus = JSON.parse(localStorage.getItem(LAST_STATUS_KEY) || '{}');
    const statusKey = `${window.location.pathname}|${config.targetSize}`;
    const shouldNotify = available && (forceNotify || lastStatus.key !== statusKey || lastStatus.available !== true);

    localStorage.setItem(LAST_STATUS_KEY, JSON.stringify({
      key: statusKey,
      available,
      checkedAt: timestamp
    }));

    if (!shouldNotify) return;
    if (!config.discordWebhookUrl) {
      log('Available, but no Discord webhook URL is configured.');
      return;
    }

    const message = [
      "Joe's New Balance stock checker: target size may be available.",
      '',
      `Product URL: ${window.location.href}`,
      `Target size: ${config.targetSize}`,
      `Matched size: ${availableMatch.displayValue}`,
      `Variant: ${availableMatch.variantID || 'unknown'}`,
      `Checked at: ${timestamp}`,
      '',
      'Warning: This is a best-effort availability check. Confirm manually before taking action.'
    ].join('\n');

    await sendDiscord(config.discordWebhookUrl, message);
    log('Sent Discord notification.');
  }

  const config = loadConfig();

  window.joesNbStockChecker = {
    checkNow: () => checkNow(config, false),
    testDiscord: () => sendDiscord(
      config.discordWebhookUrl,
      `Joe's New Balance stock checker test at ${new Date().toISOString()}`
    ),
    resetConfig: () => {
      localStorage.removeItem(CONFIG_KEY);
      localStorage.removeItem(LAST_STATUS_KEY);
      window.location.reload();
    }
  };

  checkNow(config).catch((error) => log(error.message));
  window.setInterval(() => {
    checkNow(config).catch((error) => log(error.message));
  }, config.intervalMs);
})();
