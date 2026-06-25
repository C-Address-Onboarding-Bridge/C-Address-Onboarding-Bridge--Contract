# SDK API Reference

This reference summarizes the public TypeScript SDK surface for the C-Address Onboarding Bridge. It is intended for application developers integrating contract funding, CEX memo routing, and fiat/off-ramp URL generation.

## OnboardingBridgeSDK

The main SDK class for building and submitting bridge contract interactions.

### Constructor

```ts
new OnboardingBridgeSDK(config: BridgeConfig)
```

Creates an SDK client bound to one contract, RPC endpoint, and Stellar network passphrase.

### `fundCAddress(options, signer)`

```ts
fundCAddress(options: FundCOptions, signer?: unknown): Promise<TransactionResult>
```

Funds a single target C-address from a source account.

Parameters:

- `options.source`: source G-address or account identifier providing funds.
- `options.target`: target C-address receiving the net amount.
- `options.asset`: token contract address or asset identifier expected by the contract.
- `options.amount`: integer amount string using the asset precision expected by the token client.
- `signer`: optional signer/keypair/wallet boundary, depending on application integration.

Returns a `TransactionResult` with the submitted hash and status metadata.

Common errors:

- Invalid source, target, or asset address.
- Insufficient source balance.
- Missing authorization or rejected signature.
- RPC timeout or rejected contract invocation.

### `batchFundCAddress(options, signer)`

```ts
batchFundCAddress(options: BatchFundOptions, signer?: unknown): Promise<TransactionResult>
```

Funds multiple C-addresses in one contract call when supported by the deployed contract.

Parameters:

- `options.source`: source G-address or account identifier.
- `options.transfers`: list of target, asset, and amount records.
- `signer`: optional signer/keypair/wallet boundary.

Use this for bulk funding flows after validating every transfer row client-side. Reject empty batches, duplicate rows that should not be duplicated, and amounts that exceed operational limits.

### `withdrawFees(options, signer)`

```ts
withdrawFees(options: WithdrawFeesOptions, signer?: unknown): Promise<TransactionResult>
```

Withdraws accumulated protocol fees to the configured fee collector. This should be restricted to the authorized fee collector path and used from operational tooling rather than public UI.

### Query helpers

Implementations may expose read helpers for admin, fee collector, fee basis points, initialization state, balances, or events. Query helpers should be side-effect free and safe to call from dashboards or monitoring jobs.

## OffRampIntegration

The helper class for building provider URLs and CEX routing memos.

### Constructor

```ts
new OffRampIntegration(config: OffRampConfig)
```

Creates an integration helper for Moonpay, Transak, CEX memo generation, and development/test-mode routing.

### `getMoonpayUrl(options)`

```ts
getMoonpayUrl(options: { targetCAddress: string; amount?: string; currency?: string }): string
```

Builds a Moonpay URL that routes the user toward funding a C-address. Validate the generated URL before display and make the target address visible to the user.

### `getTransakUrl(options)`

```ts
getTransakUrl(options: { targetCAddress: string; amount?: string; currency?: string }): string
```

Builds a Transak URL using the configured API key and routing options.

### `generateCEXDepositMemo(cAddress)`

```ts
generateCEXDepositMemo(cAddress: string): string
```

Encodes a target C-address into a memo suitable for CEX deposit routing. Display generated memos clearly and warn users to copy them exactly.

### `parseCEXDepositMemo(memo)`

```ts
parseCEXDepositMemo(memo: string): string
```

Decodes a CEX routing memo back into its target C-address when supported by the SDK version.

## Interfaces

### `BridgeConfig`

| Field | Description |
| --- | --- |
| `contractId` | Deployed bridge contract ID. |
| `rpcUrl` | Soroban RPC endpoint for the target network. |
| `networkPassphrase` | Stellar network passphrase such as `Networks.TESTNET` or `Networks.PUBLIC`. |
| `adminKeypair` | Optional admin signer for operational calls. Keep this out of browser clients. |

### `FundCOptions`

| Field | Description |
| --- | --- |
| `source` | Source account funding the transaction. |
| `target` | Destination C-address. |
| `asset` | Asset/token identifier. |
| `amount` | Integer amount string using token precision. |

### `BatchFundOptions`

| Field | Description |
| --- | --- |
| `source` | Source account funding all transfers. |
| `transfers` | Array of target, asset, and amount rows. |

### `WithdrawFeesOptions`

| Field | Description |
| --- | --- |
| `asset` | Token or asset whose fees should be withdrawn. |
| `destination` | Fee collector destination, when the SDK method accepts an override. |

### `OffRampConfig`

| Field | Description |
| --- | --- |
| `moonpayApiKey` | Moonpay public API key for URL generation. |
| `transakApiKey` | Transak public API key for URL generation. |
| `testMode` | Enables provider test-mode or sandbox URLs where supported. |

### `TransactionResult`

| Field | Description |
| --- | --- |
| `hash` | Submitted transaction hash. |
| `successful` | Whether the submission was accepted as successful. |
| `ledger` | Optional ledger number when returned by RPC/Horizon helpers. |
| `events` | Optional decoded event payloads when returned by SDK helpers. |

## Error handling

Common error categories:

- **Validation errors**: malformed G-address, C-address, contract ID, amount, or asset.
- **Authorization errors**: missing signer, rejected signature, or unauthorized admin/fee-collector call.
- **Contract errors**: uninitialized contract, paused/disabled flow, fee limit violation, or token transfer failure.
- **Network errors**: Soroban RPC timeout, unavailable provider, failed simulation, or rejected submission.
- **Provider errors**: Moonpay/Transak URL configuration problems or unsupported currency/region.

Application code should catch SDK errors, map them to user-safe messages, and log structured diagnostics without leaking secret keys or provider credentials.

## Example

```ts
import { Networks } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK, OffRampIntegration } from "@stellar/c-address-onboarding-bridge-sdk";

const bridge = new OnboardingBridgeSDK({
  contractId: process.env.BRIDGE_CONTRACT_ID!,
  rpcUrl: process.env.SOROBAN_RPC_URL!,
  networkPassphrase: Networks.TESTNET,
});

const tx = await bridge.fundCAddress({
  source: "GA...",
  target: "CC...",
  asset: "CD...",
  amount: "10000000",
});

const offramp = new OffRampIntegration({ testMode: true });
const url = offramp.getMoonpayUrl({ targetCAddress: "CC...", currency: "USDC", amount: "100" });
```
