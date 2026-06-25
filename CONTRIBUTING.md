# Contributing

Thanks for contributing to the C-Address Onboarding Bridge contract and SDK. This guide explains how to set up the development environment, build and test the Rust contract and TypeScript SDK, make safe contract changes, and prepare pull requests for review.

## Development Environment

Install the core toolchain before working on the repository:

- Rust stable with Cargo: https://rustup.rs
- WebAssembly target for Soroban contracts:

  ```bash
  rustup target add wasm32-unknown-unknown
  ```

- Soroban/Stellar CLI matching the network you are testing against:

  ```bash
  cargo install --locked stellar-cli
  stellar --version
  ```

- Node.js 20 or newer for scripts and the TypeScript SDK.
- npm for SDK dependency installation and script execution.

Clone the repository and install SDK dependencies:

```bash
git clone <repo-url>
cd C-Address-Onboarding-Bridge--Contract
npm install --prefix sdk
```

Use testnet keys and test assets for development. Do not commit secret keys, funded production accounts, deployment credentials, or private RPC credentials.

## Building the Contract

Build the Rust workspace during normal development:

```bash
cargo build
```

Build the onboarding bridge package in release mode:

```bash
cargo build -p onboarding-bridge --release
```

Build the WASM artifact used for deployment:

```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
```

The expected deployment artifact is generated under `target/wasm32-unknown-unknown/release/`.

## Running Tests

Run all Rust tests before submitting contract changes:

```bash
cargo test
```

Run contract tests with Soroban test utilities when the change touches contract behavior, authorization, fee accounting, events, or deployment assumptions:

```bash
cargo test -p onboarding-bridge --features testutils
```

When adding or changing a public contract function, include tests for success paths, authorization failures, invalid input, and state changes.

## SDK Build and Tests

The SDK lives in `sdk/` and should stay aligned with contract exports. Install dependencies first:

```bash
npm install --prefix sdk
```

Use the SDK package scripts when available:

```bash
npm run build --prefix sdk
npm test --prefix sdk
```

If a script is not yet defined, document the manual validation you performed in the pull request. SDK changes should include TypeScript examples for new public APIs and should preserve compatibility with the contract methods they wrap.

## Code Style

Rust code should be formatted and linted before review:

```bash
cargo fmt
cargo clippy --all-targets --all-features
```

TypeScript code should follow the existing SDK conventions:

- Prefer explicit exported types for public SDK methods.
- Keep network passphrases, RPC URLs, contract IDs, and signer material configurable.
- Avoid committing generated artifacts unless the repository already tracks them.
- Keep examples testnet-safe and mark placeholders clearly.

## Commit Messages

Use Conventional Commits so changes are easy to scan and release notes can be generated later:

- `feat(contract): add batch funding validation`
- `fix(sdk): preserve memo encoding for CEX deposits`
- `docs: add deployment guide`
- `test(contract): cover fee withdrawal authorization`

Keep commits focused. Separate contract behavior changes from SDK wrappers and documentation when practical.

## Pull Request Workflow

1. Create a focused branch, such as `docs/contributing-guide`, `feat/fee-events`, or `fix/sdk-memo-validation`.
2. Link the issue in the pull request body.
3. Summarize contract, SDK, script, and documentation changes separately.
4. Include the commands you ran, such as `cargo test`, `cargo fmt`, `cargo clippy`, and SDK build/test commands.
5. Include testnet deployment notes when the change affects deployment, initialization, authorization, events, or asset movement.
6. Wait for CI and review before merging.

Reviewers should be able to understand whether a change affects on-chain state, SDK call signatures, generated artifacts, deployment scripts, or documentation only.

## Adding New Features

Contract changes and SDK changes should move together when a public behavior changes:

1. Add or update contract state, events, errors, and public functions.
2. Add Rust tests for authorization, expected state transitions, and failure cases.
3. Update deployment or initialization scripts if configuration changes.
4. Update the SDK wrapper and exported TypeScript types.
5. Add or update README examples and any integration guides.
6. Document migration notes if existing deployments or SDK consumers must change behavior.

Avoid expanding contract privileges without tests and documentation. For admin-only behavior, clearly define who can call it, what state it changes, and how failures surface to SDK consumers.

## Security Reports

Do not disclose vulnerabilities publicly before maintainers have had time to investigate. Follow the process in [SECURITY.md](SECURITY.md) for supported versions, reporting expectations, response timelines, and safe-harbor guidance.

Security-sensitive pull requests should avoid exposing private keys, production contract IDs, funded accounts, logs with secrets, or provider credentials.
