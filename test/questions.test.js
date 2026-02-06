'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuestionAnswerPairs } = require('../lib/questions');

test('buildQuestionAnswerPairs pairs each user message with the next ai message', () => {
  const pairs = buildQuestionAnswerPairs([
    { role: 'user', text: 'Q1' },
    { role: 'ai', text: 'A1' },
    { role: 'user', text: 'Q2' },
    { role: 'ai', text: 'A2' },
  ]);

  assert.deepEqual(pairs, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ]);
});

test('buildQuestionAnswerPairs leaves answer null if none exists yet', () => {
  const pairs = buildQuestionAnswerPairs([
    { role: 'user', text: 'Q1' },
    { role: 'user', text: 'Q2' },
    { role: 'ai', text: 'A2' },
  ]);

  assert.deepEqual(pairs, [
    { question: 'Q1', answer: null },
    { question: 'Q2', answer: 'A2' },
  ]);
});
