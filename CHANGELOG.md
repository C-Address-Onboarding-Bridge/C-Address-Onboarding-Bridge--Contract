# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cross-chain funding with relayer signature verification, replay protection, and relayer threshold management.
- Referral fee splitting and fee-tier/loyalty-token support.
- Timelocked C-address funding with delayed claim and query support.
- Commit-reveal funding flow for privacy-preserving deposits.
- Meta-transaction support with signer registration and nonce tracking.
- Admin controls for pausing, asset allowlisting, blocklist/allowlist access control, daily limits, fee caps, and emergency token reclaim.
- Timelocked contract upgrade scheduling, execution, cancellation, and pending-upgrade query support.
- Two-step admin and fee-collector handoff using propose/accept flows.
- SDK wrappers for timelocked funding, claiming, and querying.

## [0.1.0] - 2024-01-01

### Added
- Initial release with fund_c_address, batch_fund_c_address
- Fee model with basis points
- Admin and fee collector roles
- TypeScript SDK with basic functions
- Off-ramp integration (Moonpay, Transak)

[Unreleased]: https://github.com/BestBisong/C-Address-Onboarding-Bridge--Contract/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BestBisong/C-Address-Onboarding-Bridge--Contract/releases/tag/v0.1.0
