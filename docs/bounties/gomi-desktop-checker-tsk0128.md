# Gomi IDE Desktop Release Checker — prj_0127 / tsk_0128

**Bounty:** mergeos-bounties/mergeos#244 (50 MRG)
**Task:** mergeos-bounties/Gomi#5 (25 MRG)

## Deliverable

- [Gomi PR #155](https://github.com/mergeos-bounties/Gomi/pull/155): `scripts/check-desktop-release.mjs`

## What it does

The script validates Gomi IDE branding and release prerequisites:

| Check | Detail |
|-------|--------|
| Product name | Verifies "Gomi" / "Gomi IDE" in product.json |
| Win32 icon | Validates win32 branding asset exists |
| App ID | Confirms Win32 app ID is configured |
| Shell name | Checks Win32 shell display name |
| Electron main | Verifies electron/main.cjs exists |
| Build config | Validates appId + win target in package.json |
| Resources dir | Checks resources/gomi-branding/ exists |

## Usage

```bash
node scripts/check-desktop-release.mjs
```

Exits 0 on success, 1 with failure details.