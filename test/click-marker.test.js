const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseClickMarker,
  buildClickMarkerPayload,
  CLICK_MARKER_STALE_MS
} = require('../lib/click-marker');

test('parseClickMarker returns legacy:true for empty marker (pre-v3.3.1 touch style)', () => {
  assert.deepStrictEqual(parseClickMarker(''), { legacy: true });
  assert.deepStrictEqual(parseClickMarker('   \n'), { legacy: true });
});

test('parseClickMarker returns legacy:true for non-JSON content (partial write race)', () => {
  assert.deepStrictEqual(parseClickMarker('not json'), { legacy: true });
  assert.deepStrictEqual(parseClickMarker('{"unterminated'), { legacy: true });
});

test('parseClickMarker returns parsed payload for a valid marker', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'abc12345',
    pids: [1234, 5678, 9012],
    event: 'waiting',
    project: 'ridebly'
  });
  const parsed = parseClickMarker(payload);
  assert.strictEqual(parsed.sessionId, 'abc12345');
  assert.deepStrictEqual(parsed.pids, [1234, 5678, 9012]);
  assert.strictEqual(parsed.event, 'waiting');
  assert.strictEqual(parsed.project, 'ridebly');
  assert.ok(typeof parsed.timestamp === 'number');
});

test('parseClickMarker normalizes unknown event to "waiting"', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'x', pids: [1], event: 'something-unexpected', project: 'p'
  });
  assert.strictEqual(parseClickMarker(payload).event, 'waiting');
});

test('parseClickMarker preserves "completed" event', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'x', pids: [1], event: 'completed', project: 'p'
  });
  assert.strictEqual(parseClickMarker(payload).event, 'completed');
});

test('parseClickMarker filters non-integer / non-positive pids', () => {
  const raw = JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'p',
    pids: [1234, 'oops', -7, 0, 5678, null],
    timestamp: Date.now()
  });
  assert.deepStrictEqual(parseClickMarker(raw).pids, [1234, 5678]);
});

test('parseClickMarker returns stale:true when timestamp is too old', () => {
  const raw = JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'p', pids: [1],
    timestamp: Date.now() - CLICK_MARKER_STALE_MS - 1000
  });
  assert.deepStrictEqual(parseClickMarker(raw), { stale: true });
});

test('parseClickMarker tolerates missing optional fields', () => {
  const raw = JSON.stringify({ pids: [1] });
  const parsed = parseClickMarker(raw);
  assert.strictEqual(parsed.sessionId, '');
  assert.strictEqual(parsed.project, 'Unknown');
  assert.strictEqual(parsed.event, 'waiting');
  assert.deepStrictEqual(parsed.pids, [1]);
});

test('buildClickMarkerPayload survives a JSON round-trip', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'sess-1', pids: [1, 2, 3], event: 'completed', project: 'demo'
  });
  // Must be valid JSON the shell will write verbatim into the marker file.
  const reparsed = JSON.parse(payload);
  assert.strictEqual(reparsed.sessionId, 'sess-1');
  assert.strictEqual(reparsed.event, 'completed');
  assert.deepStrictEqual(reparsed.pids, [1, 2, 3]);
});

test('buildClickMarkerPayload includes aiTitle when provided', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'abc',
    pids: [123],
    event: 'completed',
    project: 'demo',
    aiTitle: 'Implement caching'
  });
  const parsed = JSON.parse(payload);
  assert.strictEqual(parsed.aiTitle, 'Implement caching');
});

test('buildClickMarkerPayload sets aiTitle="" when omitted', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'abc',
    pids: [123],
    event: 'completed',
    project: 'demo'
  });
  const parsed = JSON.parse(payload);
  assert.strictEqual(parsed.aiTitle, '');
});

test('parseClickMarker returns aiTitle when present in JSON', () => {
  const json = JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'demo',
    pids: [1], aiTitle: 'Build feature X', timestamp: Date.now()
  });
  const parsed = parseClickMarker(json);
  assert.strictEqual(parsed.aiTitle, 'Build feature X');
});

test('parseClickMarker returns aiTitle="" when missing or non-string', () => {
  const a = parseClickMarker(JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'demo', pids: [1], timestamp: Date.now()
  }));
  assert.strictEqual(a.aiTitle, '');

  const b = parseClickMarker(JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'demo', pids: [1], aiTitle: 99, timestamp: Date.now()
  }));
  assert.strictEqual(b.aiTitle, '');
});

test('buildClickMarkerPayload includes shellPid, workspaceRoot, projectDir when provided', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'abc', pids: [1, 2, 3], shellPid: 18832,
    workspaceRoot: 'd:\\proj', projectDir: 'd:\\proj',
    event: 'completed', project: 'proj'
  });
  const parsed = JSON.parse(payload);
  assert.strictEqual(parsed.shellPid, 18832);
  assert.strictEqual(parsed.workspaceRoot, 'd:\\proj');
  assert.strictEqual(parsed.projectDir, 'd:\\proj');
});

test('parseClickMarker round-trips shellPid / workspaceRoot / projectDir', () => {
  const payload = buildClickMarkerPayload({
    sessionId: 'abc', pids: [1], shellPid: 18832,
    workspaceRoot: '/home/u/proj', projectDir: '/home/u/proj',
    event: 'waiting', project: 'proj'
  });
  const parsed = parseClickMarker(payload);
  assert.strictEqual(parsed.shellPid, 18832);
  assert.strictEqual(parsed.workspaceRoot, '/home/u/proj');
  assert.strictEqual(parsed.projectDir, '/home/u/proj');
});

test('parseClickMarker defaults new fields when missing', () => {
  const raw = JSON.stringify({
    sessionId: 's', event: 'waiting', project: 'demo', pids: [1], timestamp: Date.now()
  });
  const parsed = parseClickMarker(raw);
  assert.strictEqual(parsed.shellPid, 0);
  assert.strictEqual(parsed.workspaceRoot, '');
  assert.strictEqual(parsed.projectDir, '');
});
