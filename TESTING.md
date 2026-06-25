# Testing Guide

This guide explains the testing strategy for the C-Address Onboarding Bridge contract and TypeScript SDK, how to add new tests, and what reviewers should expect for feature work.

## Test Layers

The repository has two main test layers:

- **Contract tests**: Rust tests that exercise Soroban contract behavior with `soroban-sdk` test utilities.
- **SDK tests**: TypeScript tests that validate SDK request construction, error handling, off-ramp helpers, and integration-facing behavior.

Use unit tests for isolated helpers and integration-style tests for flows that cross contract state, SDK transaction construction, events, or deployment assumptions.

## Contract Tests

Contract tests should use Rust `#[test]` functions and `soroban-sdk` testutils. They should create a deterministic test environment, register the contract, create test addresses or token clients, invoke contract functions, and assert state changes and emitted behavior.

Run all contract tests with:

```bash
cargo test -p onboarding-bridge --features testutils
```

Run a specific test by name with:

```bash
cargo test -p onboarding-bridge --features testutils test_name
```

Run the full Rust workspace when shared crates or workspace configuration changes:

```bash
cargo test
```

### Writing Contract Tests

A good contract test should:

1. Build a fresh Soroban environment.
2. Register the onboarding bridge contract and any token contracts needed by the flow.
3. Initialize admin, fee collector, fee bps, and balances explicitly.
4. Invoke one behavior under test.
5. Assert return values, contract state, balances, authorization behavior, and events.

Prefer small tests with clear setup over large scenario tests that hide the reason for a failure.

### Snapshot Tests

Use snapshot-style assertions only for stable serialized outputs such as generated config, event payload examples, or SDK fixtures. Do not snapshot values that include ledger numbers, timestamps, generated addresses, or nondeterministic ordering unless they are normalized first.

### Contract Coverage Expectations

New contract behavior should include tests for:

- Happy path behavior.
- Error cases and rejected inputs.
- Edge cases such as zero amounts, maximum fee bps, missing initialization, duplicate initialization, unsupported assets, or empty batch requests.
- Event emission and event payload shape.
- Authorization checks for admin-only or fee-collector-only functions.
- State transitions, including fee accrual and withdrawal.

## SDK Tests

The SDK should be tested with Jest or the repository's configured JavaScript test runner. Install SDK dependencies before running SDK checks:

```bash
npm install --prefix sdk
```

Run SDK tests when the package defines the script:

```bash
npm test --prefix sdk
```

Run the SDK build before publishing-facing changes:

```bash
npm run build --prefix sdk
```

If a script is not available yet, document the manual validation in the pull request and add the missing script as part of SDK test infrastructure work.

### SDK Mocking Strategy

SDK tests should avoid live public-network dependencies. Prefer mocks or fakes for:

- Soroban RPC responses.
- Transaction submission results.
- Wallet/keypair signing boundaries where possible.
- Moonpay and Transak URL generation inputs.
- CEX memo generation and parsing.

Use live testnet only for explicit integration checks, and keep those tests opt-in so routine CI does not depend on external funding, RPC uptime, or provider accounts.

### Unit vs Integration Tests

Use SDK unit tests for pure helpers, request builders, URL generation, memo generation, validation, and error normalization.

Use integration-style SDK tests for flows that build transactions, parse RPC responses, reconcile events, or verify that SDK inputs match contract expectations.

## Adding Tests for a Feature

When adding a feature, start with the behavior matrix:

| Area | Questions to cover |
| --- | --- |
| Inputs | Which values are valid, invalid, missing, duplicated, or boundary-sized? |
| Authorization | Who can call it and who must be rejected? |
| State | Which ledger/contract values change, and which must remain unchanged? |
| Events | Which events are emitted, and what fields should consumers rely on? |
| SDK | Does the SDK expose a safe typed wrapper and useful error surface? |
| Operations | Does deployment, initialization, monitoring, or fee withdrawal behavior change? |

Add the smallest tests that prove those answers.

## Test Checklist

Before requesting review, confirm the pull request covers the relevant items:

- [ ] Contract happy path.
- [ ] Contract error cases.
- [ ] Contract edge cases.
- [ ] Event emission and payload expectations.
- [ ] Authorization checks.
- [ ] SDK unit tests for public helper behavior.
- [ ] SDK integration-style tests or documented manual validation for transaction-building behavior.
- [ ] README, SDK examples, or migration notes updated when public behavior changes.
- [ ] Commands run are listed in the pull request body.

## Pull Request Notes

Include the exact test commands and results in each pull request. If a test could not be run, explain why, describe the risk, and include the manual validation performed instead.
