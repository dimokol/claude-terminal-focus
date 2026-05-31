const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readAiTitle } = require('../lib/transcript-title');

function tmpFile(contents) {
  const p = path.join(os.tmpdir(), `transcript-title-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, contents);
  return p;
}

test('readAiTitle returns null for missing path', () => {
  assert.strictEqual(readAiTitle(''), null);
  assert.strictEqual(readAiTitle(null), null);
  assert.strictEqual(readAiTitle(undefined), null);
});

test('readAiTitle returns null when file does not exist', () => {
  assert.strictEqual(readAiTitle('/no/such/transcript.jsonl'), null);
});

test('readAiTitle returns null for empty file', () => {
  const p = tmpFile('');
  try {
    assert.strictEqual(readAiTitle(p), null);
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle returns null when no ai-title records present', () => {
  const p = tmpFile(
    '{"type":"user","message":"hi"}\n' +
    '{"type":"assistant","message":"hello"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), null);
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle returns the single ai-title when one is present', () => {
  const p = tmpFile(
    '{"type":"user","message":"hi"}\n' +
    '{"type":"ai-title","aiTitle":"Fix flaky test","sessionId":"abc"}\n' +
    '{"type":"assistant","message":"ok"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), 'Fix flaky test');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle returns the LAST ai-title when multiple are present', () => {
  const p = tmpFile(
    '{"type":"ai-title","aiTitle":"First guess","sessionId":"abc"}\n' +
    '{"type":"user","message":"actually..."}\n' +
    '{"type":"ai-title","aiTitle":"Revised name","sessionId":"abc"}\n' +
    '{"type":"assistant","message":"got it"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), 'Revised name');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle skips malformed JSON lines and returns the nearest valid title', () => {
  const p = tmpFile(
    '{"type":"ai-title","aiTitle":"Valid older title","sessionId":"abc"}\n' +
    '{"type":"ai-title","aiTitle":"newer but broken\n' +
    '{"type":"assistant","message":"ok"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), 'Valid older title');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle ignores ai-title records with empty or whitespace aiTitle', () => {
  const p = tmpFile(
    '{"type":"ai-title","aiTitle":"Real title","sessionId":"abc"}\n' +
    '{"type":"ai-title","aiTitle":"   ","sessionId":"abc"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), 'Real title');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAiTitle trims surrounding whitespace from the returned title', () => {
  const p = tmpFile(
    '{"type":"ai-title","aiTitle":"  Trim me  ","sessionId":"abc"}\n'
  );
  try {
    assert.strictEqual(readAiTitle(p), 'Trim me');
  } finally {
    fs.unlinkSync(p);
  }
});
