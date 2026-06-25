# Changelog

All notable changes to this project are documented in this file.

This project follows Semantic Versioning. Version tags should use the `vMAJOR.MINOR.PATCH` format for repository releases and the `contract-vMAJOR.MINOR.PATCH` format for contract crate publishing.

## [Unreleased]

### Added

- Security policy and vulnerability disclosure guidance.
- Contribution guidelines for issues, pull requests, tests, and documentation.
- README diagrams for architecture, funding flow, batch funding, fee calculation, and contract state.
- SDK integration guide and SDK API reference.
- Production deployment guide, migration guide, and testing guide.
- Full integration examples for TypeScript and JavaScript.
- GitHub Actions workflows for documentation and contract crate publishing.
- Contributor code of conduct.

## [0.1.0] - 2024-01-01

### Added

- Initial Soroban onboarding bridge contract.
- Single-address funding with `fund_c_address`.
- Batch C-address funding with `batch_fund_c_address`.
- Fee model based on basis points.
- Admin and fee collector roles.
- Fee withdrawal support for collected bridge fees.
- Query functions for fee settings, admin, fee collector, balances, and initialization state.
- TypeScript SDK with bridge transaction helpers.
- Off-ramp helpers for MoonPay, Transak, and CEX deposit memo generation.
- Testnet deployment script and configuration flow.

[Unreleased]: https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/releases/tag/v0.1.0
