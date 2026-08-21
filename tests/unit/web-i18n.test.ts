import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WEB_LOCALE,
  WEB_LOCALE_LABELS,
  WEB_LOCALES,
  WEB_MESSAGES,
  normalizeWebLocale,
  resolveWebLocale,
} from '../../src/web/i18n.js';
import { WEB_HTML } from '../../src/web/ui.js';

test('Web UI exposes the four documented locales with English as the fallback', () => {
  assert.deepEqual(WEB_LOCALES, ['en', 'ja', 'zh-CN', 'ko']);
  assert.equal(DEFAULT_WEB_LOCALE, 'en');
  assert.deepEqual(WEB_LOCALE_LABELS, {
    en: 'English',
    ja: '日本語',
    'zh-CN': '简体中文',
    ko: '한국어',
  });
});

test('every Web UI locale has the complete non-empty message catalog and matching placeholders', () => {
  const englishKeys = Object.keys(WEB_MESSAGES.en).sort();
  assert.ok(englishKeys.length >= 50);

  const placeholders = (message: string) => [...message.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
  for (const locale of WEB_LOCALES) {
    assert.deepEqual(Object.keys(WEB_MESSAGES[locale]).sort(), englishKeys, `${locale} message keys`);
    for (const key of englishKeys) {
      const message = WEB_MESSAGES[locale][key as keyof typeof WEB_MESSAGES.en];
      assert.equal(message.trim(), message, `${locale}.${key} surrounding whitespace`);
      assert.notEqual(message, '', `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(message), placeholders(WEB_MESSAGES.en[key as keyof typeof WEB_MESSAGES.en]), `${locale}.${key} placeholders`);
    }
  }
});

test('Web locale normalization accepts supported regional variants without mislabeling Traditional Chinese', () => {
  assert.equal(normalizeWebLocale('en-GB'), 'en');
  assert.equal(normalizeWebLocale('ja-JP'), 'ja');
  assert.equal(normalizeWebLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(normalizeWebLocale('ko-KR'), 'ko');
  assert.equal(normalizeWebLocale('zh-TW'), null);
  assert.equal(normalizeWebLocale('fr-FR'), null);
  assert.equal(normalizeWebLocale(null), null);
});

test('Web locale resolution uses the first supported candidate and falls back deterministically', () => {
  assert.equal(resolveWebLocale(['fr-FR', 'ko-KR', 'en-US']), 'ko');
  assert.equal(resolveWebLocale(['zh-TW', 'ja-JP']), 'ja');
  assert.equal(resolveWebLocale(['fr-FR']), DEFAULT_WEB_LOCALE);
  assert.equal(resolveWebLocale([]), DEFAULT_WEB_LOCALE);
});

test('generated Web UI exposes locale detection, persistence, selection, and translated accessibility hooks', () => {
  assert.match(WEB_HTML, /<html lang="en">/);
  assert.match(WEB_HTML, /<select id="locale"[^>]+data-i18n-aria-label="languageLabel"/);
  assert.match(WEB_HTML, /navigator\.languages/);
  assert.match(WEB_HTML, /localStorage\.getItem\(localeStorageKey\)/);
  assert.match(WEB_HTML, /localStorage\.setItem\(localeStorageKey, state\.locale\)/);
  assert.match(WEB_HTML, /document\.documentElement\.lang = state\.locale/);
  assert.match(WEB_HTML, /data-i18n-placeholder="searchPlaceholder"/);
  for (const label of Object.values(WEB_LOCALE_LABELS)) assert.match(WEB_HTML, new RegExp(label));
});
