# Changelog

## 0.2.0 — 2026-11-17

### Security
- Donor dashboard bound to `127.0.0.1`, with a session token on every API call; wallet export needs explicit confirmation.
- Removed the committed network secret and all hardcoded secrets; the oracle key is an independent secret.
- Node identity tokens, admin key and HMAC-signed partner API on the controller.
- dVPN: per-session X25519 key exchange; the exit relay only reaches public addresses on web ports.
- Workloads validated strictly, no shell, no caller-chosen paths.
- Fixed npm audit findings in the contracts toolchain.

### Added
- Foxy Finance partner API: account linking with one-time codes, hardware discounts, verified compute jobs with replicas, plan payments in `$FOXY`.
- JavaScript and Python partner SDKs.
- `.fox` domains served over HTTP and HTTPS; optional hosting of the Foxy Finance server.
- `FoxyTreasuryVault`: withdrawable reserves, refunds, recorded subscriptions, payment in `$FOXY` with burn.
- Contract compile and deploy scripts; 45 automated tests and CI.
- Project website, English README, contributing guide.

### Fixed
- The local dVPN proxy now starts even if the gateway is not up yet.
- Rewards ledger and account links persist across controller restarts.
