# C-Address Onboarding Bridge

A Soroban smart contract + TypeScript SDK that lets anyone fund a Soroban smart account (C-address) directly — from a CEX withdrawal, a credit card, or an existing G-address — without the user needing to understand the underlying account model.

## Architecture

```
User (G-address / CEX / Credit Card)
            │
            ▼
  ┌─────────────────────┐
  │ OnboardingBridge    │  ← Soroban smart contract
  │  - routes funds     │
  │  - collects fee     │
  │  - emits events     │
  └────────┬────────────┘
           │
           ▼
  Target C-address (Soroban smart account)
```

### Contract (`contracts/onboarding-bridge/`)

| Function | Description |
|---|---|
| `initialize` | Set admin, fee collector, and fee rate |
| `fund_c_address` | Route tokens from source to a C-address |
| `batch_fund_c_address` | Fund multiple C-addresses in one tx |
| `set_fee_bps` / `set_fee_collector` / `set_admin` | Admin management |
| `withdraw_fees` | Fee collector drains accumulated fees |
| `query_fee_bps` / `query_fee_collector` / `query_admin` | Read config |
| `query_balance` | Check any address's token balance |
| `query_is_initialized` | Check if contract is initialized |

### SDK (`sdk/`)

- `OnboardingBridgeSDK` — Wraps all contract calls, handles tx building/signing
- `OffRampIntegration` — Moonpay/Transak URL generation + CEX memo encoding

## Quick Start

### Build Contract

```bash
cargo build -p onboarding-bridge --release
```

### Run Tests

```bash
cargo test -p onboarding-bridge --features testutils
```

### Deploy to Testnet

1. Build WASM:
```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
```

2. Create `deploy-config.json`:
```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "adminSecretKey": "S...",
  "feeCollectorPublicKey": "G...",
  "feeBps": 50,
  "wasmPath": "./target/wasm32-unknown-unknown/release/onboarding_bridge.wasm"
}
```

3. Deploy and initialize:
```bash
npx ts-node scripts/deploy.ts all
```

### Use the SDK

```ts
import { OnboardingBridgeSDK, OffRampIntegration } from '@stellar/c-address-onboarding-bridge-sdk';

const bridge = new OnboardingBridgeSDK({
  contractId: 'C...',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

const result = await bridge.fundCAddress(
  { source: 'G...', target: 'C...', asset: 'C...', amount: '1000' },
  sourceKeypair,
);

// Credit card on-ramp
const offramp = new OffRampIntegration({ testMode: true });
const moonpayUrl = offramp.getMoonpayUrl({
  targetCAddress: 'C...',
  amount: '100',
  currency: 'XLM',
});

// CEX deposit routing
const memo = offramp.generateCEXDepositMemo('C...');
```

## Fee Model

Fees are configured in basis points (bps, 1/10000 of 1%). Max 1000 bps (10%).
Fees accumulate in the contract and are withdrawn by the fee collector.

## Events

- `CAddressFunded` — emitted on each fund/batch transfer
- `FeesWithdrawn` — emitted when fees are withdrawn

## License

MIT
