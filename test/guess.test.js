import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCorrectSongGuess } from '../server.js';

test('song guesses accept normal formatting differences and small typos', () => {
  assert.equal(isCorrectSongGuess('the mr. brightside', 'Mr. Brightside'), true);
  assert.equal(isCorrectSongGuess('bohemian rapsody', 'Bohemian Rhapsody'), true);
  assert.equal(isCorrectSongGuess('Dancing Queen - Remastered 2011', 'Dancing Queen'), true);
  assert.equal(isCorrectSongGuess('Beyonce', 'Beyoncé'), true);
});

test('song guesses reject different or deceptively similar titles', () => {
  assert.equal(isCorrectSongGuess('Help', 'Hello'), false);
  assert.equal(isCorrectSongGuess('Hey Jude', 'Hey Ya!'), false);
  assert.equal(isCorrectSongGuess('Taylor Swift', 'Shake It Off'), false);
});
