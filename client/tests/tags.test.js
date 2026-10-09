import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedTags, uniqueTags } from '../src/lib/tags.js';

test('tags preserve first spelling and deduplicate case and Unicode equivalents', () => {
  assert.deepEqual(uniqueTags([' Vacation, dog ', 'vacation, DOG', 'Café, Cafe\u0301']), ['Vacation', 'dog', 'Café']);
  assert.throws(() => uniqueTags('a'.repeat(65)), /bad tag/);
});

test('suggestions match the current tag and exclude selected tags', () => {
  assert.deepEqual(suggestedTags('Vacation, do', ['Vacation', 'dog', 'cat']), ['dog']);
  assert.deepEqual(suggestedTags('Vacation, dog, va', ['Vacation', 'dog', 'cat']), []);
});
