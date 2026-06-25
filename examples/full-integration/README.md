# Full integration example

This example shows the complete C-Address onboarding bridge flow on Stellar testnet. It uses the repository SDK and deployment script instead of duplicating deployment logic.

## What it covers

- SDK setup
- Testnet contract deployment and initialization
- Funding one C address from a G address
- Batch funding multiple C addresses
- Withdrawing collected bridge fees
- MoonPay and Transak off-ramp URL generation
- CEX deposit memo helpers
- Error handling around SDK calls

## Prerequisites

- Node.js 18+
- A funded Stellar testnet admin account
- A funded Stellar testnet source G address
- The testnet asset contract ID used for funding
- Optional MoonPay and Transak API keys for generated provider URLs

## Install

From the repository root:

    npm install --prefix sdk

For TypeScript execution, install your preferred runner in the example workspace or run the file through your application build system.

## Environment

Set these values before running either example:

    export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
    export NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    export ADMIN_SECRET_KEY="S..."
    export SOURCE_SECRET_KEY="S..."
    export FEE_COLLECTOR_SECRET_KEY="S..."
    export FEE_COLLECTOR_PUBLIC_KEY="G..."
    export TARGET_C_ADDRESS="C..."
    export SECOND_TARGET_C_ADDRESS="C..."
    export ASSET_CONTRACT_ID="C..."
    export CONTRACT_ID="C..."
    export MOONPAY_API_KEY=""
    export TRANSAK_API_KEY=""

Use testnet keys only. Do not commit real secrets.

## Deploy and initialize on testnet

The repository already includes the deployment script used by this example. Create deploy-config.json in the repository root:

    {
      "rpcUrl": "https://soroban-testnet.stellar.org",
      "networkPassphrase": "Test SDF Network ; September 2015",
      "adminSecretKey": "S...",
      "feeCollectorPublicKey": "G...",
      "feeBps": 50,
      "wasmPath": "./target/wasm32-unknown-unknown/release/onboarding_bridge.wasm"
    }

Build and deploy:

    cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
    npx ts-node scripts/deploy.ts all

After the deployment script prints the contract ID, set CONTRACT_ID and run one of the example flows.

## Run the TypeScript flow

    npx ts-node examples/full-integration/typescript/full-flow.ts

## Run the JavaScript flow

    npm run build --prefix sdk
    node examples/full-integration/javascript/full-flow.js

## Expected flow

1. Build the SDK configuration from environment variables.
2. Check whether the deployed bridge is initialized.
3. Fund one target C address.
4. Batch fund two target C addresses.
5. Generate MoonPay and Transak URLs for the target C address.
6. Generate and decode a CEX deposit memo.
7. Withdraw accumulated fees with the fee collector key.
8. Log SDK failures without hiding the transaction status.
