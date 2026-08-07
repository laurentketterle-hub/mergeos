# Implementation #64 — PR Verification CI

## Overview

This implements the bounty [#64](https://github.com/mergeos-bounties/mergeos/issues/64):
**[300 MRG per PR] Test submitted PRs and verify bounty evidence.**

A GitHub Actions workflow () that automatically verifies bounty PRs by:
- Checking for evidence files in 
- Running backend (Go) and frontend (Node) tests
- Generating a structured verification report
- Posting the report as a PR comment

## Workflow

- **File:** 
- **Trigger:** PR opened, synchronized, reopened, or labeled
- **Target branches:** , 
- **Condition:** Runs only when PR has labels , , or 

## Verification Steps

1. **Evidence check** — counts files in , lists them
2. **Test execution** — runs FAIL	./... [setup failed]
FAIL for backend,  for frontend
3. **Report generation** — creates  with PR metadata, evidence count, test results, and labels
4. **PR comment** — posts the report as a comment on the PR using 

## DCO

Signed-off-by: noreply@users.noreply.github.com
