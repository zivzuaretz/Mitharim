'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsHealthDeniedContent,
  bucketsContainHealthDeniedContent,
  compareSnapshots,
  extractDocumentLinks,
  summarizePdfChangeHebrew,
} = require('../src/index');

test('list-directory additions stay whole instead of splitting Hebrew words', () => {
  const oldText = [
    'מחירונים > בקשת הטבה בדמי ניהול > עלוני מידע ומוצרים',
    'מדיניות השקעות מוצהרת 2026 > אישורי ניהול חשבון בנק',
    'יובהר כי המענה הינו לבחירת הלקוח > קפסולת הפנסיה שלך',
  ].join(' > ');
  const newText = oldText.replace(
    'אישורי ניהול חשבון בנק >',
    'אישורי ניהול חשבון בנק > מודל גילאים בפנסיה מקיפה ומשלימה >',
  );

  const comparison = compareSnapshots(oldText, newText);
  assert.deepEqual(comparison.buckets.added, ['מודל גילאים בפנסיה מקיפה ומשלימה']);
  assert.deepEqual(comparison.buckets.removed, []);
  assert.deepEqual(comparison.buckets.updated, []);
});

test('health deny filter covers Hebrew and English medical/insurance terms', () => {
  for (const text of [
    'עדכון בנושא מחלות', 'שירותי בריאות', 'ביטוחים חדשים', 'כיסוי סיעודי',
    'מסמך רפואי', 'ניתוח חדש', 'medical update', 'health plan',
    'insurance policy', 'disease and cancer', 'surgery', 'nursing care',
  ]) assert.equal(containsHealthDeniedContent(text), true, text);
});

test('deny filter does not reject relevant pension and investment content by site identity', () => {
  assert.equal(containsHealthDeniedContent('עדכון מסלולי פנסיה וגמל', 'מדיניות השקעה 2026'), false);
  const links = extractDocumentLinks(
    '<a href="https://insurer.example/pension.pdf">מדיניות השקעה לפנסיה</a>',
    'https://insurer.example/',
  );
  assert.equal(links.length, 1);
});

test('document discovery excludes medical files using title or link text', () => {
  const html = [
    '<a href="/pension.pdf">מדיניות השקעה</a>',
    '<a href="/health.pdf">מסמך בריאות</a>',
    '<a href="/other.pdf" title="medical insurance form">קובץ</a>',
  ].join('');
  assert.deepEqual(
    extractDocumentLinks(html, 'https://example.test/').map((x) => x.filename),
    ['pension.pdf'],
  );
});

test('page bucket filter detects denied content on either side of update', () => {
  assert.equal(bucketsContainHealthDeniedContent({ updated: [{ from: 'מידע ישן', to: 'מידע רפואי חדש' }] }), true);
  assert.equal(bucketsContainHealthDeniedContent({ added: ['מסלול השקעה חדש'] }), false);
});

test('PDF essence summary prefers numeric changes in plain Hebrew', () => {
  const summary = summarizePdfChangeHebrew(
    { type: 'updated', filename: 'policy.pdf' },
    [{ oldValue: '20%', newValue: '25%', field: 'חשיפה למניות', product: 'מסלול 50' }],
  );
  assert.match(summary, /^עיקר השינוי:/);
  assert.match(summary, /20% ← 25%/);
});

test('PDF essence summary uses extracted text and safe no-text fallback', () => {
  assert.match(
    summarizePdfChangeHebrew({ type: 'added', filename: 'policy.pdf', newText: 'מדיניות השקעה מעודכנת למסלול' }),
    /מדיניות השקעה מעודכנת/,
  );
  const fallback = summarizePdfChangeHebrew({ type: 'added', filename: 'scan.pdf', newText: '' });
  assert.equal(fallback, 'עיקר המסמך: קובץ PDF בשם scan.pdf; לא ניתן היה לחלץ ממנו טקסט.');
  assert.doesNotMatch(fallback, /בינארי/);
});
