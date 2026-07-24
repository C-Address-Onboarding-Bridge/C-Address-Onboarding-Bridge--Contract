# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CI now produces a size-optimized WASM artifact (`onboarding_bridge.optimized.wasm`) via `stellar contract optimize` (`wasm-opt -Oz`) and reports raw vs. optimized size in the job summary and a `wasm-size-report` artifact
- WASM size badge in the README, refreshed from the `badges` branch on every push to `main`
- `BridgeError::ReentrantCall` (code 41): the reentrancy guard now traps with a typed error code instead of a panic-message string

### Changed
- Release profile now declares `lto = "fat"` explicitly (previously the equivalent `lto = true`)
- Removed the last panic-message string from the contract binary, reducing WASM size

## [0.1.0] - 2024-01-01

### Added
- Initial release with fund_c_address, batch_fund_c_address
- Fee model with basis points
- Admin and fee collector roles
- TypeScript SDK with basic functions
- Off-ramp integration (Moonpay, Transak)

[Unreleased]: https://github.com/BestBisong/C-Address-Onboarding-Bridge--Contract/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BestBisong/C-Address-Onboarding-Bridge--Contract/releases/tag/v0.1.0
