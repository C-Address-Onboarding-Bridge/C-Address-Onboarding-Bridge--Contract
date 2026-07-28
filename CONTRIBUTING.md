# Contributing to C-Address Onboarding Bridge

Thank you for your interest in contributing! This document outlines how to set up your development environment, build the project, and submit pull requests.

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Building the Contract](#building-the-contract)
- [Running Tests](#running-tests)
- [Building and Testing the SDK](#building-and-testing-the-sdk)
- [Code Style Guide](#code-style-guide)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Workflow](#pull-request-workflow)
- [Adding New Features](#adding-new-features)
- [Security Vulnerability Reporting](#security-vulnerability-reporting)

## Development Environment Setup

### Prerequisites

Ensure you have the following installed:

| Tool | Version | Install |
|---|---|---|
| Docker + Docker Compose | 24+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Node.js | 20+ LTS (18, 20, 22 recommended) | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| Rust + wasm32 target | stable | `curl https://sh.rustup.rs -sSf \| sh` then `rustup target add wasm32-unknown-unknown` |
| Soroban CLI | latest | `cargo install --locked stellar-cli` |
| Git | any | — |

### Initial Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract.git
   cd C-Address-Onboarding-Bridge--Contract
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your local configuration (Docker Compose provides defaults for local development).

3. **Install SDK dependencies:**
   ```bash
   cd sdk
   npm install
   cd ..
   ```

4. **Start local services:**
   ```bash
   docker compose up -d
   ```
   This starts the Soroban sandbox, PostgreSQL, Redis, and the relayer service.

## Building the Contract

### Build for Native (x86-64)

```bash
cargo build -p onboarding-bridge --release
```

### Build WASM (Soroban)

```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
```

The compiled WASM binary will be at:
```
target/wasm32-unknown-unknown/release/onboarding_bridge.wasm
```

## Running Tests

### Contract Tests

```bash
# Run all contract tests
cargo test -p onboarding-bridge --features testutils

# Run a specific test
cargo test -p onboarding-bridge --features testutils test_initialize

# Run tests with output
cargo test -p onboarding-bridge --features testutils -- --nocapture
```

### SDK Tests

```bash
cd sdk
npm test
cd ..
```

### Run All Checks (as in CI)

```bash
# Contract
cargo build -p onboarding-bridge --release
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
cargo test -p onboarding-bridge --features testutils

# SDK
cd sdk
npm install
npx tsc --noEmit
npm run build
npm test
cd ..
```

## Building and Testing the SDK

### Build the SDK

```bash
cd sdk
npm run build
cd ..
```

Output TypeScript will be compiled to `sdk/dist/`.

### Type Check

```bash
cd sdk
npx tsc --noEmit
cd ..
```

### Run SDK Tests

```bash
cd sdk
npm test
cd ..
```

### Lint SDK Code

```bash
cd sdk
npm run lint
cd ..
```

The SDK ESLint setup lives in `sdk/.eslintrc.json` and is installed with the
SDK dev dependencies. The pre-commit hook lints staged files under `sdk/src/`
with the same configuration.

## Code Style Guide

### Rust

- Follow standard Rust conventions enforced by `cargo fmt` and `clippy`
- Format code before committing:
  ```bash
  cargo fmt --all
  cargo clippy --all-targets --all-features
  ```

> **Both are enforced in CI** by the `Format & Lint` job, which runs
> `cargo fmt --all -- --check` and `cargo clippy --all-targets --all-features -- -D warnings`.
> The pre-commit hook only covers formatting and can be skipped with
> `--no-verify`, so clippy warnings will still fail your PR. Run both locally
> to avoid a round trip.

### TypeScript/JavaScript (SDK)

- Use TypeScript for type safety
- Follow ESLint rules configured in the project
- Lint before committing:
  ```bash
  cd sdk
  npm run lint
  cd ..
  ```

### General Guidelines

- Keep functions and modules focused and single-purpose
- Write clear, descriptive variable and function names
- Add comments only for non-obvious logic
- Ensure all tests pass before submitting a PR
- Update documentation if you change public APIs

## Commit Message Conventions

We use **Conventional Commits** for clear, structured commit messages. This enables automated changelog generation and semantic versioning.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type

Must be one of:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, etc.)
- **refactor**: Code refactoring without feature changes
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Build, CI, or dependency updates

### Scope

Optional. Area of the codebase (e.g., `contract`, `sdk`, `ci`, `docs`).

### Subject

- Imperative mood ("add" not "adds" or "added")
- No period at the end
- Max 50 characters
- Lowercase

### Body

- Explain *why* the change was made
- Wrap at 72 characters
- Separate from subject with a blank line

### Footer

Optional. Reference issues and breaking changes:

```
Closes #123
BREAKING CHANGE: this removes the old API
```

### Examples

```
feat(contract): add batch_fund_c_address function

Implement batch funding to reduce transaction count and fees.
Validates all targets before processing.

Closes #42
```

```
fix(sdk): handle network timeout gracefully

Add exponential backoff retry logic for RPC calls.

Closes #85
```

## Pull Request Workflow

### Branch Naming

Use conventional branch names:

- `feat/short-description` — New feature
- `fix/short-description` — Bug fix
- `docs/short-description` — Documentation
- `refactor/short-description` — Refactoring
- `chore/short-description` — Build or dependency updates

Example:
```bash
git checkout -b feat/add-batch-funding
```

### Before Submitting

1. **Ensure your branch is up to date:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```

2. **Run all tests locally:**
   ```bash
   cargo test -p onboarding-bridge --features testutils
   cd sdk && npm test && cd ..
   ```

3. **Check formatting and linting:** (CI runs the `--check`/`-D warnings` forms)
   ```bash
   cargo fmt --all -- --check
   cargo clippy --all-targets --all-features -- -D warnings
   cd sdk && npm run lint && cd ..
   ```

4. **Check for vulnerable dependencies:** (CI runs these in the `Dependency Audit` job)
   ```bash
   cargo audit
   cd sdk && npm audit --audit-level=high && cd ..
   ```

5. **Verify Conventional Commits:**
   All commits must follow the format above.

### Creating a Pull Request

1. Push your branch to GitHub:
   ```bash
   git push origin feat/short-description
   ```

2. Open a PR with a clear description:
   - **Title**: Short, descriptive (starts with type from Conventional Commits)
   - **Description**: 
     - What problem does this solve?
     - How does it solve it?
     - Any breaking changes or migration notes?
   - **Checklist**:
     - [ ] Tests pass locally
     - [ ] Code follows style guide
     - [ ] Commits follow Conventional Commits
     - [ ] Documentation updated (if applicable)
     - [ ] No unrelated changes

3. Address review feedback:
   - Make changes in new commits (don't rebase unless requested)
   - Re-request review after addressing comments

### Merge Requirements

- ✅ All GitHub Actions CI checks pass
- ✅ At least one approval from a maintainer
- ✅ All conversations resolved
- ✅ Branch is up to date with `main`

## Adding New Features

### Contract Changes

1. **Design phase:**
   - Open an issue describing the feature
   - Discuss design with maintainers
   - Get approval before implementing

2. **Implementation:**
   - Add contract logic in `contracts/onboarding-bridge/src/`
   - Write comprehensive tests with `testutils` feature
   - Update inline documentation
   - Run benchmarks to check performance

3. **SDK Updates:**
   - Add TypeScript bindings in `sdk/src/`
   - Write integration tests
   - Update SDK tests and type-check passes

4. **Documentation:**
   - Update README.md with new functionality
   - Add comments for complex logic
   - Update this CONTRIBUTING.md if workflow changed

### SDK-Only Changes

1. Write tests first
2. Implement the feature
3. Ensure type-check passes
4. Update README or docs as needed

## Security Vulnerability Reporting

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues to: `security@c-address-onboarding-bridge.dev` or use the [GitHub Private Vulnerability Reporting](https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/security/advisories) feature.

See [SECURITY.md](SECURITY.md) for full details on reporting procedures and our security policy.

---

## Questions?

- Check [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md) for environment setup details
- Review [README.md](README.md) for architecture overview
- Open an issue for questions or suggestions

Thank you for contributing! 🎉
