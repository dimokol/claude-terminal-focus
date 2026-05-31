// lib/transcript-title.js — extract the latest aiTitle from a Claude Code
// transcript JSONL. Claude Code emits records like
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}
// updated as the session evolves. We want the most recent one.

const fs = require('fs');

function readAiTitle(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    return null;
  }
  if (!content) return null;

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('"ai-title"') === -1) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim() !== '') {
        return obj.aiTitle.trim();
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { readAiTitle };
