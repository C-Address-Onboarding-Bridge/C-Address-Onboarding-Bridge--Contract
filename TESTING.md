# Testing Guide

This guide explains how to run and extend the contract and SDK test suites for
the C-Address Onboarding Bridge.

## Prerequisites

- Rust toolchain with `cargo`.
- Soroban target support for contract builds:

```bash
rustup target add wasm32-unknown-unknown
```

- Node.js and npm for the TypeScript SDK.

Install SDK dependencies from the `sdk/` directory:

```bash
cd sdk
npm install
```

## Contract Tests

Contract tests live under `contracts/onboarding-bridge/src/` and use Rust
`#[test]` functions with `soroban-sdk` test utilities.

Run the full contract suite:

```bash
cargo test -p onboarding-bridge --features testutils
```

Run a specific test by name:

```bash
cargo test -p onboarding-bridge --features testutils fund_c_address
```

Build the optimized contract WASM:

```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
```

### Writing Contract Tests

New contract behavior should include tests for:

- Happy path behavior.
- Authorization checks, especially source, admin, and fee collector calls.
- Invalid inputs such as zero or negative amounts.
- Asset allowlist and blocklist behavior when relevant.
- Fee calculation and accrued fee accounting.
- Events emitted by successful and failed flows.
- Pause, upgrade, and initialization guards when touched.

Prefer small tests that set up only the accounts, assets, and balances required
for the behavior under test. Keep network calls out of unit tests; use
`soroban-sdk` test utilities and local mock state instead.

## SDK Tests

SDK tests live under `sdk/src/__tests__/` and use Jest.

Run the SDK suite:

```bash
cd sdk
npm test
```

Build and type-check the SDK:

```bash
cd sdk
npm run build
```

### Writing SDK Tests

New SDK behavior should include tests for:

- Transaction option validation.
- Request or transaction construction.
- Memo encoding and decoding.
- Error handling for missing configuration.
- Mocked RPC failures and clear error messages.
- Compatibility between SDK option types and contract method arguments.

Use mocks for RPC calls and external on-ramp providers. SDK unit tests should not
depend on live wallets, third-party APIs, or public network availability.

## Snapshot and Fixture Guidance

When a test needs stable serialized output, keep fixtures minimal and committed
near the test that uses them. If snapshot-style assertions are added, make sure
the snapshot captures a meaningful contract, SDK, or event shape rather than
incidental formatting.

Review snapshot changes carefully in PRs. A snapshot update should come with a
short explanation of the behavior change it represents.

## Feature Test Checklist

Before opening a PR for a new feature, verify that the test coverage includes:

- Happy path.
- At least one relevant error path.
- Edge cases around empty, zero, maximum, or repeated values.
- Event emissions for state-changing contract calls.
- Authorization requirements for privileged calls.
- SDK validation and error behavior when the public API changes.
- Documentation updates for new commands, options, or workflows.

## Pull Request Validation

For most changes, include the commands you ran in the PR body. A typical
validation block looks like:

```text
cargo test -p onboarding-bridge --features testutils
cd sdk && npm test
cd sdk && npm run build
```

Documentation-only changes can state that no runtime tests were required, but
should still be checked for spelling, command accuracy, and broken links.
