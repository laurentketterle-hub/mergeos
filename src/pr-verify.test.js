/**
 * Tests for PR Verification Tool — MergeOS #64
 * Run: node src/pr-verify.test.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(condition, name) { if (condition) { passed++; } else { console.log('FAIL: ' + name); failed++; } }
function test(name, fn) { try { fn(); console.log('  PASS: ' + name); } catch(e) { console.log('  FAIL: ' + name + ' — ' + e.message); failed++; } }

console.log('\n=== PR Verify Tool Tests ===\n');

// Test evidence detection
console.log('Evidence Detection:');
assert(require('./pr-verify.js').checkEvidence ? true : false, 'checkEvidence function exists');

// Test with real data
const sampleBody = 'Fixes #24\n\n## Changes\n- Added dark theme\n\n![screenshot](img.png)\n```\n$ npm test\n8 passed\n```';
const ev = require('./pr-verify.js').checkEvidence(sampleBody);
assert(ev.screenshots === true, 'detects screenshot in markdown image');
assert(ev.logs === true, 'detects code block as log evidence');
assert(ev.video === false, 'no video in sample');

const emptyBody = '';
const ev2 = require('./pr-verify.js').checkEvidence(emptyBody);
assert(ev2.screenshots === false, 'empty body: no screenshots');
assert(ev2.video === false, 'empty body: no video');
assert(ev2.logs === false, 'empty body: no logs');

// Test CLI
console.log('\nCLI Tests:');
const GHT = process.env.GH_TOKEN || '';
test('--pr flag required', () => {
  try { execSync('node src/pr-verify.js', { timeout: 3000, stdio: 'pipe' }); } catch(e) { return; }
  throw new Error('should have exited with error');
});

test('--dry-run mode', () => {
  const out = execSync('node src/pr-verify.js --pr https://github.com/mergeos-bounties/BloggerEasy/pull/151 --dry-run --token ' + GHT, 
    { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
  assert(out.includes('DRY RUN'), 'dry-run output contains DRY RUN marker');
  assert(out.includes('Verdict'), 'dry-run output contains verdict');
});

test('invalid PR URL rejected', () => {
  try { execSync('node src/pr-verify.js --pr not-a-url', { timeout: 3000, stdio: 'pipe' }); } catch(e) { return; }
  throw new Error('should reject invalid URL');
});

console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
console.log('All tests passed! ✅');
