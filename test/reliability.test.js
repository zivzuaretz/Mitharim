'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeHash,
  buildFileAlertKey,
  validateDocument,
  validatePageContent,
  confirmPendingChange,
  clearPendingChange,
} = require('../src/index');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

test('temporary filenames and URLs deduplicate by normalized content hash', () => {
  const bytes = fixture('valid-minimal.pdf');
  const hash = computeHash(bytes);
  const item = { id: 'yl_policy' };
  const first = buildFileAlertKey(item, { type: 'added', filename: '1769679827.3439.pdf', url: 'https://x/1769679827.3439.pdf', hash });
  const second = buildFileAlertKey(item, { type: 'added', filename: '1777526646.5005.pdf', url: 'https://x/1777526646.5005.pdf', hash });
  assert.equal(first, second);
});

test('duplicate content has one logical identity regardless of filename', () => {
  const hash = computeHash(Buffer.from('same document bytes'));
  assert.equal(
    buildFileAlertKey({ id: 'x' }, { type: 'updated', filename: 'a.pdf', hash, prevHash: 'old' }),
    buildFileAlertKey({ id: 'x' }, { type: 'updated', filename: 'b.pdf', hash, prevHash: 'old' }),
  );
});

test('document validation rejects HTML PDF stubs and implausibly tiny PDFs', () => {
  assert.equal(validateDocument(fixture('pdf-stub.html'), 'temporary.pdf', 'text/html').valid, false);
  assert.equal(validateDocument(Buffer.from('%PDF-1.4\n%%EOF'), 'tiny.pdf', 'application/pdf').valid, false);
  assert.equal(validateDocument(fixture('valid-minimal.pdf'), 'ok.pdf', 'application/pdf').valid, true);
});

test('error/challenge and very short pages are never valid page content', () => {
  const challenge = fixture('challenge.html');
  assert.equal(validatePageContent({ buffer: challenge, isPdf: false, cleanedText: challenge.toString(), contentType: 'text/html' }).valid, false);
  assert.equal(validatePageContent({ buffer: Buffer.alloc(300, 65), isPdf: false, cleanedText: 'short', contentType: 'text/html' }).valid, false);
});

test('same logical page change requires two consecutive successful runs', async () => {
  const id = `test-confirm-${process.pid}-${Date.now()}`;
  try {
    assert.equal(await confirmPendingChange(id, 'candidate-a'), false);
    assert.equal(await confirmPendingChange(id, 'candidate-b'), false, 'different candidate resets confirmation');
    assert.equal(await confirmPendingChange(id, 'candidate-b'), true);
  } finally {
    await clearPendingChange(id);
  }
});
