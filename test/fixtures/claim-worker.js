
const { claimHandled } = require('/Users/dimokol/Documents/WebDev/claude-terminal-focus/lib/signals');
process.send({ ok: claimHandled(process.argv[2]) });
