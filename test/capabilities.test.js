import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSupport, supportFromCapabilities, supportFromModelId } from '../src/agent/capabilities.js';

const yes = { supported: true };
const no = { supported: false };
// The shape of ModelInfo.capabilities from the Models API (only the parts we read).
const sonnet46 = {
  thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
  effort: { supported: true, low: yes, medium: yes, high: yes, max: yes, xhigh: null },
};
const sonnet45 = {
  thinking: { supported: true, types: { adaptive: no, enabled: yes } },
  effort: { supported: false, low: no, medium: no, high: no, max: no, xhigh: null },
};

test('reads adaptive thinking and effort levels from the Models API capabilities', () => {
  assert.deepEqual(supportFromCapabilities(sonnet46), { adaptiveThinking: true, effortLevels: ['low', 'medium', 'high'] });
  assert.deepEqual(supportFromCapabilities(sonnet45), { adaptiveThinking: false, effortLevels: [] });
  assert.deepEqual(supportFromCapabilities(null), { adaptiveThinking: false, effortLevels: [] });
});

test('the built-in list knows the gateway models', () => {
  assert.equal(supportFromModelId('claude-sonnet-4-6').adaptiveThinking, true);
  assert.equal(supportFromModelId('claude-sonnet-4-5').adaptiveThinking, false);
  assert.deepEqual(supportFromModelId('claude-haiku-4-5').effortLevels, []);
});

test('asks the Models API first and falls back to the built-in list', async () => {
  const api = { models: { retrieve: async () => ({ id: 'x', capabilities: sonnet45 }) } };
  assert.deepEqual(await modelSupport(api, 'claude-sonnet-4-6'), { adaptiveThinking: false, effortLevels: [], source: 'Models API' });

  const down = { models: { retrieve: async () => { throw new Error('404'); } } };
  assert.equal((await modelSupport(down, 'claude-sonnet-4-6')).source, 'built-in list');
  assert.equal((await modelSupport(down, 'claude-sonnet-4-6')).adaptiveThinking, true);

  const noCaps = { models: { retrieve: async () => ({ id: 'x', capabilities: null }) } };
  assert.equal((await modelSupport(noCaps, 'claude-sonnet-4-5')).source, 'built-in list');
});
