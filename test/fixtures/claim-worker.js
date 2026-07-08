
const { claimHandled } = require('../../lib/signals');
process.send({ ok: claimHandled(process.argv[2]) });
