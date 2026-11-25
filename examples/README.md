# C-Address Onboarding Bridge — Examples

End-to-end integration examples for the Onboarding Bridge SDK, covering the complete lifecycle: SDK setup, contract verification, funding, batch operations, fee withdrawal, and off-ramp URL generation.

## Prerequisites

1. **Node.js ≥ 18** and **npm ≥ 9**
2. **A deployed and initialized bridge contract on testnet** — run the deploy script first:
   ```bash
   cp deploy-config.testnet.example.json deploy-config.testnet.json
   # edit deploy-config.testnet.json with your real keys
   npx ts-node scripts/deploy.ts all --network testnet
   ```
3. **A funded testnet account** — get free XLM from the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test).

## Install the SDK

From the repo root:

```bash
cd sdk && npm install && npm run build && cd ..
```

Or install from npm (once published):

```bash
npm install @stellar/c-address-onboarding-bridge-sdk @stellar/stellar-sdk
```

## Running the examples

### TypeScript

```bash
# Set required environment variables
export SOURCE_SECRET="S..."
export FEE_COLLECTOR_SECRET="S..."
export CONTRACT_ID="CA..."
export USDC_ASSET="CA..."

# Run
npx ts-node examples/typescript/full-integration.ts
```

Or with a `.env` file and `dotenv`:

```bash
npx ts-node -r dotenv/config examples/typescript/full-integration.ts
```

### JavaScript

```bash
export SOURCE_SECRET="S..."
export FEE_COLLECTOR_SECRET="S..."
export CONTRACT_ID="CA..."
export USDC_ASSET="CA..."

node examples/javascript/full-integration.js
```

## What the examples demonstrate

| Step | Description |
|------|-------------|
| **1. SDK setup** | Construct `OnboardingBridgeSDK` with retry config |
| **2. Contract verification** | `isInitialized`, `getFee`, `getAdmin`, `getFeeCollector` |
| **3. Fund a C-address** | `fundCAddress` with confirmation polling |
| **4. Batch funding** | `batchFundCAddresses` — multiple targets in one tx |
| **5. Fee withdrawal** | `getFeeBalance` → `withdrawFees` |
| **6. Off-ramp URLs** | `getOnRampUrl` for MoonPay and Transak; `compareProviders` |
| **7. CEX memo helpers** | `generateCEXDepositMemo` / `decodeCEXDepositMemo` |
| **8. Error handling** | Mutating method result checking + validation error catching |

## Key patterns

### Mutating methods never throw

```ts
const result = await sdk.fundCAddress(options, keypair);

if (result.status === 'failed') {
  console.error('Failed:', result.error);
  return;
}
// result.status === 'pending' — poll for confirmation
const tx = await server.getTransaction(result.hash);
```

### Read-only methods throw on error

```ts
try {
  const balance = await sdk.getCAddressBalance('CC...', 'CD...');
} catch (err) {
  console.error('Query failed:', err.message);
}
```

### Amount precision

All amounts are in the token's **smallest unit**. For assets with 7 decimal places (XLM, most Stellar tokens):

```
1 token = 10_000_000 stroops
```

For USDC bridged from Ethereum (6 decimals on Ethereum, but may be 7 on Stellar — confirm with the token contract):

```
1 USDC = 10_000_000  (if 7 decimals on Stellar)
```

### Transaction confirmation

`fundCAddress` returns `status: 'pending'` after submission. Always poll for finality before showing success to users:

```ts
import { rpc } from '@stellar/stellar-sdk';

const server = new rpc.Server(rpcUrl);
let tx = await server.getTransaction(result.hash);
while (tx.status === 'NOT_FOUND') {
  await new Promise((r) => setTimeout(r, 2000));
  tx = await server.getTransaction(result.hash);
}
if (tx.status !== 'SUCCESS') throw new Error('Transaction failed');
```

## Off-ramp provider comparison

```ts
const offramp = new OffRampIntegration({ testMode: true });
const comparison = offramp.compareProviders('100', 'XLM', 'USD');

// { moonpay: { feeAmount: '4.50', netAmount: '95.50', settlementTime: 2 }, ... }
for (const [provider, info] of Object.entries(comparison)) {
  console.log(`${provider}: fee=${info.feeAmount}, net=${info.netAmount}, ~${info.settlementTime}h`);
}
```

## Security notes

- **Never hardcode secret keys** — use environment variables or a secrets manager.
- **Use `Networks.PUBLIC` for mainnet** — using testnet passphrase on mainnet (or vice versa) causes all transactions to fail.
- **Always check `result.status`** before assuming a transaction succeeded.
