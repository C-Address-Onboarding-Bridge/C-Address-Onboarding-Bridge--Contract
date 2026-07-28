# Developer Setup Guide

Local development environment for the C-Address Onboarding Bridge — Soroban smart contract, TypeScript SDK, and off-chain relayer service.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Docker + Docker Compose | 24+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| Rust + wasm32 target | stable | `curl https://sh.rustup.rs -sSf \| sh` |
| Stellar CLI | latest | `cargo install --locked stellar-cli` |
| Git | any | — |

Add the wasm32 target after installing Rust:

```bash
rustup target add wasm32-unknown-unknown
```

---

## 1. Clone and Configure

```bash
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract.git
cd C-Address-Onboarding-Bridge--Contract
cp .env.example .env
```

Edit `.env` and fill in values. The minimum required for local dev:

```
DATABASE_URL=postgres://bridge:bridge@localhost:5432/bridge
REDIS_URL=redis://localhost:6379
STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
NETWORK_PASSPHRASE=Standalone Network ; February 2017
```

Everything else can remain blank until you need it.

---

## 2. Install Dependencies

```bash
# TypeScript SDK
cd sdk && npm install && cd ..
```

---

## 3. Start the Local Stack (Docker Compose)

```bash
docker compose up -d
```

This starts four services:

| Service | Port | Description |
|---|---|---|
| `api` | 3000 | Relayer service with ts-node-dev hot reload |
| `postgres` | 5432 | Event store and reconciliation DB |
| `redis` | 6379 | Nonce deduplication cache |
| `soroban` | 8000 | Stellar + Soroban local sandbox |

Check all services are healthy:

```bash
docker compose ps
```

View logs (all services or a specific one):

```bash
docker compose logs -f
docker compose logs -f api
```

Stop the stack:

```bash
docker compose down          # keep volumes
docker compose down -v       # also wipe DB and Redis data
```

---

## 4. Deploy the Contract Locally

### Build the WASM

```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
```

### Generate a local admin keypair

```bash
stellar keys generate admin --network local
stellar keys address admin   # copy the G-address
```

### Create `deploy-config.json`

```json
{
  "rpcUrl": "http://localhost:8000/soroban/rpc",
  "networkPassphrase": "Standalone Network ; February 2017",
  "adminSecretKey": "<output of: stellar keys show admin>",
  "feeCollectorPublicKey": "<another G-address>",
  "feeBps": 50,
  "wasmPath": "./target/wasm32-unknown-unknown/release/onboarding_bridge.wasm"
}
```

### Deploy and initialize

```bash
npx ts-node scripts/deploy.ts all
```

Copy the printed contract C-address into your `.env`:

```
CONTRACT_ID=C...
```

---

## 5. Run Tests

### Contract (Rust)

```bash
cargo test -p onboarding-bridge --features testutils
```

### SDK (TypeScript)

```bash
cd sdk && npm test
```

### Both

```bash
cargo test -p onboarding-bridge --features testutils && (cd sdk && npm test)
```

---

## 6. Git Hooks (pre-commit)

Install husky so the pre-commit hook runs automatically:

```bash
npx husky install
```

The hook (`.husky/pre-commit`) runs on every `git commit`:

1. **TypeScript type-check** — `tsc --noEmit` across the SDK
2. **ESLint** — on staged `.ts` files only
3. **Rust fmt check** — `cargo fmt --check` on staged `.rs` files

To skip the hook in an emergency:

```bash
git commit --no-verify -m "..."
```

---

## 7. VS Code Setup

Open the repo in VS Code and accept the prompt to install recommended extensions, or install them manually:

```
rust-lang.rust-analyzer       — Rust IDE support
esbenp.prettier-vscode        — TypeScript/JSON formatter
dbaeumer.vscode-eslint        — ESLint integration
ms-azuretools.vscode-docker   — Docker Compose UI
bierner.markdown-mermaid      — Preview Mermaid diagrams
mikestead.dotenv              — .env syntax highlighting
tamasfe.even-better-toml      — Cargo.toml highlighting
eamodio.gitlens               — Enhanced git blame/history
```

Workspace settings (`.vscode/settings.json`) are already configured for:
- Format on save (Prettier for TS, rustfmt for Rust)
- ESLint auto-fix on save
- rust-analyzer with `testutils` feature and Clippy
- Rulers at 100 characters

---

## 8. Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `STELLAR_RPC_URL` | ✅ | Soroban JSON-RPC endpoint |
| `NETWORK_PASSPHRASE` | ✅ | Stellar network passphrase |
| `CONTRACT_ID` | ✅ | Deployed bridge contract C-address |
| `ADMIN_SECRET_KEY` | ✅ | Admin keypair secret (load from secrets manager in prod) |
| `FEE_COLLECTOR_SECRET_KEY` | ✅ | Fee collector keypair secret |
| `RELAYER_SECRET_KEY` | ✅ | Keypair that submits Soroban transactions |
| `RELAYER_PRIVATE_KEYS` | ✅ | Comma-separated Ed25519 seeds (hex) for signing |
| `THRESHOLD` | ✅ | Minimum signatures required (must match on-chain value) |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `ETH_RPC_URL` | optional | Ethereum JSON-RPC endpoint |
| `ETH_BRIDGE_CONTRACT` | optional | Ethereum bridge contract address |
| `ETH_EVENT_TOPIC` | optional | keccak256 of the BridgeFund event signature |
| `SOLANA_WS_URL` | optional | Solana WebSocket endpoint |
| `SOLANA_PROGRAM_ID` | optional | Solana bridge program id |
| `MOONPAY_API_KEY` | optional | Moonpay on-ramp API key |
| `TRANSAK_API_KEY` | optional | Transak on-ramp API key |

---

## 9. Troubleshooting

### `soroban` container stays unhealthy

The quickstart image takes ~30 s to boot. Check its logs:

```bash
docker compose logs soroban
```

If it keeps failing, pull the latest image:

```bash
docker compose pull soroban && docker compose up -d soroban
```

### `cargo: command not found` inside the `api` container

The `api` container is Node-only. Run Rust commands on your host machine, not inside Docker.

### Port already in use

Check what's using the port and stop it, or change the host-side port in `docker-compose.yml`:

```bash
lsof -i :5432    # example for Postgres
```

### `tsc` type-check fails in pre-commit hook

Run it manually to see the full error:

```bash
cd sdk && npx tsc --noEmit
```

### `stellar keys show admin` prints nothing

The key wasn't created or was created for a different network. Re-run:

```bash
stellar keys generate admin --network local
```

### Contract call returns `NotInitialized`

You need to deploy and initialize the contract first (see step 4), then set `CONTRACT_ID` in `.env`.

### Redis or Postgres data is stale between runs

Wipe volumes and restart:

```bash
docker compose down -v && docker compose up -d
```

---

## 10. Project Structure

```
.
├── contracts/
│   └── onboarding-bridge/
│       └── src/
│           ├── lib.rs          # Contract implementation
│           └── tests.rs        # Contract tests
├── sdk/
│   └── src/
│       ├── bridge.ts           # OnboardingBridgeSDK
│       ├── offramp.ts          # OffRampIntegration (Moonpay/Transak/CEX)
│       ├── types.ts            # Shared TypeScript types
│       └── __tests__/          # SDK unit tests
├── relayer/
│   └── index.ts                # Off-chain relayer service
├── scripts/
│   └── deploy.ts               # Deploy + initialize script
├── .husky/
│   └── pre-commit              # Git pre-commit hook
├── .vscode/
│   ├── settings.json           # Workspace editor settings
│   └── extensions.json         # Recommended extensions
├── docker-compose.yml          # Local dev stack
├── Dockerfile.dev              # API/relayer dev container
├── .env.example                # Environment variable template
├── Cargo.toml                  # Rust workspace
└── DEVELOPER_SETUP.md          # This file
```
