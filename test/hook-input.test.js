const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyHookInput, extractQuestionText, MAX_QUESTION_LEN } = require('../lib/hook-input');

// --- classifyHookInput ---

test('Stop maps to completed with its own dedup name', () => {
  const c = classifyHookInput({ hook_event_name: 'Stop' });
  assert.deepEqual(c, { skip: false, event: 'completed', hookEventName: 'Stop', dedupEventName: 'Stop' });
});

test('PermissionRequest and PreToolUse map to waiting primaries', () => {
  for (const name of ['PermissionRequest', 'PreToolUse']) {
    const c = classifyHookInput({ hook_event_name: name });
    assert.equal(c.skip, false);
    assert.equal(c.event, 'waiting');
    assert.equal(c.dedupEventName, name);
  }
});

test('bare Notification stays a trailer (dedup name Notification)', () => {
  for (const nType of [undefined, '', 'permission_prompt', 'idle_prompt', 'some_future_type']) {
    const c = classifyHookInput({ hook_event_name: 'Notification', notification_type: nType });
    assert.equal(c.skip, false, `type=${nType}`);
    assert.equal(c.event, 'waiting');
    assert.equal(c.dedupEventName, 'Notification', `type=${nType} must keep trailer semantics`);
  }
});

test('status-only notification types are skipped entirely', () => {
  for (const nType of ['auth_success', 'elicitation_complete', 'elicitation_response']) {
    const c = classifyHookInput({ hook_event_name: 'Notification', notification_type: nType });
    assert.deepEqual(c, { skip: true }, `type=${nType} must be skipped`);
  }
});

test('agent_needs_input is a waiting PRIMARY (escapes trailer suppression)', () => {
  const c = classifyHookInput({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  assert.equal(c.skip, false);
  assert.equal(c.event, 'waiting');
  assert.notEqual(c.dedupEventName, 'Notification',
    'must not carry the trailer name or stage-dedup would suppress it forever');
});

test('agent_completed maps to completed and is a primary', () => {
  const c = classifyHookInput({ hook_event_name: 'Notification', notification_type: 'agent_completed' });
  assert.equal(c.event, 'completed');
  assert.notEqual(c.dedupEventName, 'Notification');
});

test('elicitation_dialog is a waiting primary (has no PR/Stop of its own)', () => {
  const c = classifyHookInput({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' });
  assert.equal(c.event, 'waiting');
  assert.notEqual(c.dedupEventName, 'Notification');
});

test('unknown/missing hook_event_name defaults to a waiting primary', () => {
  const c1 = classifyHookInput({});
  assert.equal(c1.skip, false);
  assert.equal(c1.event, 'waiting');
  const c2 = classifyHookInput({ hook_event_name: 'SomeFutureEvent' });
  assert.equal(c2.event, 'waiting');
  assert.equal(c2.dedupEventName, 'SomeFutureEvent');
});

test('case-insensitive event name matching (stop/notification)', () => {
  assert.equal(classifyHookInput({ hook_event_name: 'stop' }).event, 'completed');
  assert.equal(classifyHookInput({ hook_event_name: 'NOTIFICATION' }).dedupEventName, 'NOTIFICATION');
});

// --- extractQuestionText ---

test('extracts the first question from AskUserQuestion tool_input', () => {
  const q = extractQuestionText('AskUserQuestion', {
    questions: [{ question: 'Which auth method should we use?', header: 'Auth', options: [] }]
  });
  assert.equal(q, 'Which auth method should we use?');
});

test('returns empty for other tools or malformed input', () => {
  assert.equal(extractQuestionText('Bash', { command: 'ls' }), '');
  assert.equal(extractQuestionText('AskUserQuestion', null), '');
  assert.equal(extractQuestionText('AskUserQuestion', {}), '');
  assert.equal(extractQuestionText('AskUserQuestion', { questions: [] }), '');
  assert.equal(extractQuestionText('AskUserQuestion', { questions: [{ question: '   ' }] }), '');
  assert.equal(extractQuestionText('AskUserQuestion', { questions: 'nope' }), '');
});

test('skips empty questions and finds the first non-empty one', () => {
  const q = extractQuestionText('AskUserQuestion', {
    questions: [{ question: '' }, { question: 'Deploy to staging first?' }]
  });
  assert.equal(q, 'Deploy to staging first?');
});

test('collapses whitespace and truncates long questions with an ellipsis', () => {
  const long = 'Should   we \n keep ' + 'x'.repeat(300) + ' going?';
  const q = extractQuestionText('AskUserQuestion', { questions: [{ question: long }] });
  assert.ok(q.length <= MAX_QUESTION_LEN, `length ${q.length} > ${MAX_QUESTION_LEN}`);
  assert.ok(q.endsWith('…'));
  assert.ok(q.startsWith('Should we keep'), `whitespace should collapse, got: ${q.slice(0, 20)}`);
});
