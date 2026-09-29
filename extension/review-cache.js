import { defaultReviewPreferences } from './review-preferences.js';

const cacheVersion = 3;
const megabyte = 1024 * 1024;
let database;

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('review-focus', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('reviews', { keyPath: 'key' });
      const metadata = request.result.createObjectStore('metadata', { keyPath: 'key' });
      metadata.createIndex('lookup', 'lookup');
      request.result.createObjectStore('settings');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(new Error('Saved reviews are unavailable in this browser.')); };
  });
  return database;
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, operation, signal) {
  const db = await openDatabase();
  signal?.throwIfAborted();
  const tx = db.transaction(['reviews', 'metadata', 'settings'], mode);
  const abort = () => { try { tx.abort(); } catch {} };
  signal?.addEventListener('abort', abort, { once: true });
  const completion = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The saved-review operation was interrupted.'));
  });
  try {
    const value = await operation(tx.objectStore('reviews'), tx.objectStore('metadata'), tx.objectStore('settings'));
    await completion;
    return value;
  } catch (error) {
    try { tx.abort(); } catch {}
    await completion.catch(() => {});
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function reviewLookup(snapshot, settings) {
  return JSON.stringify([cacheVersion, snapshot.url, snapshot.baseSha, snapshot.headSha, settings.provider, settings.model, settings.effort ?? '', settings.review ?? defaultReviewPreferences()]);
}

export async function reviewCacheKey(snapshot, settings) {
  const lookup = reviewLookup(snapshot, settings);
  const bytes = new TextEncoder().encode(JSON.stringify([lookup, snapshot]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { key, lookup };
}

export function peekReview(lookup) {
  return transaction('readonly', async (_reviews, metadata) => {
    const entries = await result(metadata.index('lookup').getAll(lookup));
    const latest = entries.sort((left, right) => right.savedAt - left.savedAt)[0];
    return latest ? { available: true, savedAt: latest.savedAt, key: latest.key } : { available: false };
  });
}

export function readReview(key) {
  return transaction('readwrite', async (reviews, metadata, settings) => {
    const [entry, meta, clock] = await Promise.all([result(reviews.get(key)), result(metadata.get(key)), result(settings.get('accessClock'))]);
    if (!entry || !meta) return null;
    const lastUsed = Math.max(Date.now(), (clock ?? 0) + 1);
    settings.put(lastUsed, 'accessClock');
    metadata.put({ ...meta, lastUsed });
    return { ...entry.value, savedAt: meta.savedAt };
  });
}

function trimReviews(reviews, metadata, entries, limitBytes) {
  let usedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const ordered = entries.sort((left, right) => left.lastUsed - right.lastUsed || left.savedAt - right.savedAt || left.key.localeCompare(right.key));
  while (usedBytes > limitBytes && ordered.length) {
    const entry = ordered.shift();
    reviews.delete(entry.key);
    metadata.delete(entry.key);
    usedBytes -= entry.bytes;
  }
  return { usedBytes, count: ordered.length };
}

export function saveReview(identity, value, signal) {
  const savedAt = Date.now();
  const record = { key: identity.key, value };
  const meta = { ...identity, savedAt, lastUsed: savedAt, bytes: 0 };
  const bytes = new TextEncoder().encode(JSON.stringify(record) + JSON.stringify(meta)).length + 16;
  meta.bytes = bytes;
  return transaction('readwrite', async (reviews, metadata, settings) => {
    const [entries, configuredLimit, clock] = await Promise.all([result(metadata.getAll()), result(settings.get('limitMB')), result(settings.get('accessClock'))]);
    const limitBytes = (configuredLimit ?? 100) * megabyte;
    if (bytes > limitBytes) return { saved: false, message: 'This review is larger than the cache limit. It remains available in this tab.' };
    meta.lastUsed = Math.max(Date.now(), (clock ?? 0) + 1);
    settings.put(meta.lastUsed, 'accessClock');
    for (const entry of entries.filter(entry => entry.lookup === identity.lookup && entry.key !== identity.key)) {
      reviews.delete(entry.key);
      metadata.delete(entry.key);
    }
    const remaining = entries.filter(entry => entry.lookup !== identity.lookup && entry.key !== identity.key);
    trimReviews(reviews, metadata, remaining, limitBytes - bytes);
    reviews.put(record);
    metadata.put(meta);
    return { saved: true, savedAt };
  }, signal);
}

export function cacheInfo() {
  return transaction('readonly', async (_reviews, metadata, settings) => {
    const [entries, limitMB] = await Promise.all([result(metadata.getAll()), result(settings.get('limitMB'))]);
    return { limitMB: limitMB ?? 100, usedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), count: entries.length };
  });
}

export function setCacheLimit(limitMB) {
  if (!Number.isInteger(limitMB) || limitMB < 1 || limitMB > 1024) throw new Error('Choose a cache size from 1 to 1024 MB.');
  return transaction('readwrite', async (reviews, metadata, settings) => {
    const entries = await result(metadata.getAll());
    settings.put(limitMB, 'limitMB');
    return { limitMB, ...trimReviews(reviews, metadata, entries, limitMB * megabyte) };
  });
}

export function clearCache() {
  return transaction('readwrite', async (reviews, metadata, settings) => {
    const limitMB = await result(settings.get('limitMB'));
    reviews.clear();
    metadata.clear();
    return { limitMB: limitMB ?? 100, usedBytes: 0, count: 0 };
  });
}
