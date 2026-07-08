
const { shouldNotify, advanceOnPrompt } = require('../../lib/stage-dedup');
const [workspaceRoot, sessionId, event, mode] = process.argv.slice(2);
if (mode === 'prompt') {
  advanceOnPrompt(workspaceRoot, sessionId);
  process.send({ notify: null });
} else {
  const result = shouldNotify(workspaceRoot, sessionId, event);
  process.send(result);
}
