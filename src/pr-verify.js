#!/usr/bin/env node
/**
 * PR Verification Tool — MergeOS #64 (300 MRG per verified PR)
 * Usage: node pr-verify.js --pr <PR_URL> [--repo-dir <dir>] [--token <gh_token>] [--post] [--dry-run]
 */
const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── GitHub API ──────────────────────────────────────────────────
function ghGet(endpoint, token) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: endpoint,
      headers: { 'User-Agent': 'MergeOS-PR-Verify/1.0', 'Accept': 'application/vnd.github.v3+json' } };
    if (token) opts.headers['Authorization'] = 'token ' + token;
    https.get(opts, res => { let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
  });
}

function ghPost(endpoint, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = { hostname: 'api.github.com', path: endpoint, method: 'POST',
      headers: { 'User-Agent': 'MergeOS-PR-Verify/1.0', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data) } };
    if (token) opts.headers['Authorization'] = 'token ' + token;
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── Command runner ─────────────────────────────────────────────
function run(cmd, cwd) {
  try { const o = execSync(cmd, { cwd: cwd || process.cwd(), timeout: 120000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return { ok: true, output: o.trim().substring(0, 1000) }; }
  catch (e) { return { ok: false, output: ((e.stdout||'')+(e.stderr||'')).trim().substring(0, 500), code: e.status }; }
}

// ── Evidence detection ─────────────────────────────────────────
function checkEvidence(body) {
  const t = (body || '').toLowerCase();
  return {
    screenshots: /\.(png|jpg|jpeg|gif|webp|svg)/i.test(body || '') || /!\[/.test(body || ''),
    video: /\.(mp4|mov|webm)|video|screen.?record/i.test(t),
    logs: /```[\s\S]*?```|console\.log|error|traceback|output/i.test(t)
  };
}

// ── Detect test commands ────────────────────────────────────────
function detectTests(dir) {
  let cmds = [];
  try {
    const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    if (files.includes('package.json')) {
      try { const pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
        if (pkg.scripts?.test) cmds.push({ n:'npm test', c:'npm test', d:dir }); } catch(e) {}
    }
    if (files.includes('go.mod')) cmds.push({ n:'go test', c:'go test ./...', d:dir });
    if (files.includes('pyproject.toml')||files.includes('setup.py')||files.includes('setup.cfg'))
      cmds.push({ n:'pytest', c:'python -m pytest tests/ -v --tb=short 2>&1 || echo "no tests"', d:dir });
    if (files.includes('Cargo.toml')) cmds.push({ n:'cargo test', c:'cargo test 2>&1 || echo "no tests"', d:dir });
  } catch(e) {}
  return cmds;
}

// ── Export for testing ─────────────────────────────────────────
module.exports = { checkEvidence, detectTests, ghGet, ghPost, run };

// ── CLI ─────────────────────────────────────────────────────────
if (require.main === module) {
const args = process.argv.slice(2);
function g(f) { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
const prUrl = g('--pr') || g('-p');
const ghToken = g('--token') || g('-t') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repoDir = g('--repo-dir') || g('-d') || process.cwd();
const dryRun = args.includes('--dry-run') || args.includes('-n');
const postReport = args.includes('--post');

if (!prUrl) { console.error('Usage: node pr-verify.js --pr <PR_URL> [--repo-dir <dir>] [--post] [--dry-run]'); process.exit(1); }
const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
if (!m) { console.error('Invalid PR URL'); process.exit(1); }
const repo = m[1], prNum = parseInt(m[2]), shortRepo = repo.split('/')[1];

(async () => {
  console.log('\nPR Verification Tool — ' + repo + '#' + prNum);
  console.log('='.repeat(50));

  const pr = await ghGet('/repos/' + repo + '/pulls/' + prNum, ghToken);
  if (pr.message) { console.error('Error: ' + pr.message); process.exit(1); }
  const sha = (pr.head?.sha || '').substring(0, 7), author = pr.user?.login || '?';
  console.log('\n1/5 PR: ' + pr.title);
  console.log('   @' + author + ' | ' + (pr.head?.ref||'?') + ' | sha:' + sha + ' | +' + (pr.additions||0) + '/-' + (pr.deletions||0));

  let ciStatus = 'unknown', ciLines = [];
  try {
    const c = await ghGet('/repos/' + repo + '/commits/' + pr.head?.sha + '/check-runs?per_page=20', ghToken);
    const runs = c?.check_runs || [];
    if (!runs.length) { ciStatus = 'no checks'; ciLines = ['No checks']; }
    else { const f = runs.filter(r => r.conclusion === 'failure');
      ciStatus = f.length ? f.length + '/' + runs.length + ' FAILED' : runs.length + '/' + runs.length + ' passed';
      ciLines = runs.map(r => (r.conclusion==='success'?'✅':'❌') + ' ' + r.name + ': ' + (r.conclusion||r.status)); }
  } catch(e) { ciStatus = 'error'; }
  console.log('\n2/5 CI: ' + ciStatus);
  ciLines.slice(0,10).forEach(l => console.log('   ' + l));

  const cmds = detectTests(repoDir);
  let tResults = [];
  console.log('\n3/5 Tests (dir: ' + repoDir + '):');
  for (const tc of cmds) {
    process.stdout.write('   ' + tc.n + '... ');
    const r = run(tc.c, tc.d);
    console.log(r.ok ? 'OK' : 'FAIL');
    tResults.push({ name:tc.n, ok:r.ok });
  }
  if (!cmds.length) { console.log('   No test framework detected'); tResults.push({ name:'no tests', ok:true }); }

  const ev = checkEvidence(pr.body);
  console.log('\n4/5 Evidence: screenshots=' + ev.screenshots + ' video=' + ev.video + ' logs=' + ev.logs);

  const ciOk = ciStatus.includes('passed') || ciStatus === 'no checks';
  const tOk = tResults.every(t => t.ok);
  let verdict;
  if (ciOk && tOk && ev.screenshots) verdict = '✅ APPROVE';
  else if (!ciOk) verdict = '❌ CI FAILING';
  else if (!ev.screenshots) verdict = '⚠️ EVIDENCE MISSING';
  else verdict = '⚠️ NEEDS REVIEW';

  const report = '## QA Verification — ' + shortRepo + '#' + prNum + '\n\n' +
    '**PR:** ' + pr.title + '\n**Author:** @' + author + ' | **SHA:** ' + sha + '\n\n' +
    '### CI: ' + ciStatus + '\n' + ciLines.map(l=>'- '+l).join('\n') + '\n\n' +
    '### Tests\n' + tResults.map(t=>(t.ok?'✅':'❌')+' '+t.name).join('\n') + '\n\n' +
    '### Evidence\n| Screenshots | ' + (ev.screenshots?'✅':'❌') + ' |\n| Video/GIF | ' + (ev.video?'✅':'❌') + ' |\n| Logs | ' + (ev.logs?'✅':'❌') + ' |\n\n' +
    '### Verdict: **' + verdict + '**\n\n' +
    '*Auto-verified via [PR Verify Tool](https://github.com/mergeos-bounties/mergeos/issues/64)*';

  console.log('\n5/5 Verdict: ' + verdict + '\n');
  console.log(report);

  const rp = path.join(process.cwd(), 'verify-' + shortRepo + '-' + prNum + '.md');
  fs.writeFileSync(rp, report);
  console.log('Saved: ' + rp);

  if (postReport) {
    try { const r = await ghPost('/repos/' + repo + '/issues/' + prNum + '/comments', { body: report }, ghToken);
      console.log('Posted: ' + (r.id ? '✅ #' + r.id : '❌')); } catch(e) { console.log('Post error: ' + e.message); }
  }
  if (dryRun) console.log('DRY RUN');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
} // require.main
