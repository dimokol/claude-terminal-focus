
const { claimHandled } = require('C:/WebDev/claude-notifications/lib/signals');
process.send({ ok: claimHandled(process.argv[2]) });
