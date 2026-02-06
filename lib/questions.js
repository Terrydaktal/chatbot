'use strict';

function singleLine(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function truncateToWidth(s, maxWidth) {
  if (maxWidth <= 0) return '';
  if (s.length <= maxWidth) return s;
  if (maxWidth <= 3) return s.slice(0, maxWidth);
  return s.slice(0, maxWidth - 3) + '...';
}

function questionLabel(question, maxWidth) {
  const line = singleLine(question);
  const max = Math.max(1, maxWidth || 0);
  return truncateToWidth(line || '(empty)', max);
}

// Takes a linear message list (in order) and pairs each user message with the next
// AI message before the next user message.
function buildQuestionAnswerPairs(messages) {
  const pairs = [];
  const items = Array.isArray(messages) ? messages : [];

  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (!cur || cur.role !== 'user') continue;

    const question = cur.text || '';
    let answer = null;

    for (let j = i + 1; j < items.length; j++) {
      const nxt = items[j];
      if (!nxt) continue;
      if (nxt.role === 'ai') { answer = nxt.text || ''; break; }
      if (nxt.role === 'user') break;
    }

    pairs.push({ question, answer });
  }

  return pairs;
}

module.exports = {
  buildQuestionAnswerPairs,
  questionLabel,
};
