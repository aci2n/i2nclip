import assert from 'node:assert/strict';
import test from 'node:test';
import { completeTag, suggestedTags, uniqueTags } from '../src/lib/tags.js';

test('tags preserve first spelling and deduplicate case and Unicode equivalents', () => {
  assert.deepEqual(uniqueTags([' Vacation, dog ', 'vacation, DOG', 'Café, Cafe\u0301']), ['Vacation', 'dog', 'Café']);
  assert.throws(() => uniqueTags('a'.repeat(65)), /bad tag/);
});

test('suggestions complete the current tag without adding an existing tag twice', () => {
  assert.deepEqual(suggestedTags('Vacation, do', ['Vacation', 'dog', 'cat']), ['dog']);
  assert.equal(completeTag('Vacation, do', 'dog'), 'Vacation, dog, ');
  assert.equal(completeTag('Vacation, dog, va', 'vacation'), 'Vacation, dog, ');
});
