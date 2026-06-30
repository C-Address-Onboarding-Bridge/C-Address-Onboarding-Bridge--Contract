# Testing Guide

This document describes the testing strategy and how to contribute tests to the C-Address Onboarding Bridge project.

## Table of Contents

- [Contract Tests](#contract-tests)
- [SDK Tests](#sdk-tests)
- [Running Tests](#running-tests)
- [Test Checklist](#test-checklist)
- [Best Practices](#best-practices)

## Contract Tests

### Test Framework

Contract tests use Rust's `#[test]` attribute with the [soroban-sdk](https://docs.rs/soroban-sdk/) `testutils` module. This provides:

- In-process contract execution
- Mock ledger and blockchain context
- Simulated contract registration and calls
- Event inspection and assertion
- Snapshot testing for storage state verification

### Key Testing Components

#### Environment Setup

```rust
use soroban_sdk::Env;

#[test]
fn my_test() {
    let env = Env::default();
    // Test code uses env for contract execution
}
```

The `Env::default()` creates an isolated sandbox environment for each test.

#### Contract Registration

```rust
let bridge_id = env.register(OnboardingBridge, ());
let token_id = env.register(TestToken, ());
```

Contracts must be registered in the test environment before they can be invoked.

#### Authentication Mocking

```rust
env.mock_all_auths();  // Mock all authorization checks
```

For simpler testing, all authorization requirements can be mocked. More complex tests can verify specific auth requirements.

#### Client Creation

```rust
let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
```

Auto-generated clients provide type-safe contract method calls with proper error handling.

### How to Write Contract Tests

#### 1. Basic Test Structure

```rust
#[test]
fn test_basic_operation() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, token_id) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    // Setup initial state
    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    
    // Execute contract operation
    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    
    // Assert results
    assert_eq!(bridge.query_fee_bps(), 50u32);
    assert_eq!(bridge.query_admin(), admin);
}
```

#### 2. Testing Happy Path

The happy path tests the normal, successful execution flow:

```rust
#[test]
fn test_fund_c_address_success() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, token_id) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    
    // Initialize and setup
    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    
    let target = Address::generate(&env);
    
    // Execute and verify balances
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
    
    assert_eq!(check_balance(&env, &token_id, &user), 500i128);  // 500 spent
    assert_eq!(check_balance(&env, &token_id, &target), 495i128); // 495 received (5 fee)
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 5i128); // 5 accrued
}
```

#### 3. Testing Error Cases

Error cases verify that the contract properly rejects invalid operations:

```rust
#[test]
fn test_initialize_fee_too_high() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, _) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    
    // Try to set fee > 1000 basis points (10%)
    assert_eq!(
        bridge.try_initialize(&admin, &fee_collector, &2000u32, &None),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}
```

Use `try_*` methods for operations expected to fail, which return `Result<T, Error>`.

#### 4. Testing Edge Cases

Edge cases test boundary conditions and unusual but valid states:

```rust
#[test]
fn test_fund_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, token_id) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    // Initialize contract
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &Address::generate(&env), &100u32, &None);
    bridge.add_asset(&token_id, &None);
    
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    
    // Edge case: zero amount should succeed (though may not transfer anything)
    bridge.fund_c_address(&user, &target, &token_id, &0i128, &None, &None);
}
```

#### 5. Testing Event Emissions

Events are critical for off-chain tracking and must be tested:

```rust
#[test]
fn test_fund_c_address_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, token_id) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    // Setup...
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    
    // Clear previous events
    env.events().all();
    
    // Execute contract call
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &None, &None);
    
    // Verify event was emitted
    let events = env.events().all();
    assert!(!events.is_empty());
    // Assert on specific event topics and data
}
```

#### 6. Testing Authorization

Authorization tests verify that only authorized parties can execute sensitive operations:

```rust
#[test]
fn test_set_fee_requires_admin() {
    let env = Env::default();
    
    let (bridge_id, _) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    let admin = Address::generate(&env);
    let unauthorized_user = Address::generate(&env);
    
    env.mock_all_auths();
    bridge.initialize(&admin, &Address::generate(&env), &50u32, &None);
    
    // Remove mocking for next call
    env.mock_all_auths();
    
    // Unauthorized user cannot change fee
    // (This would normally fail, but behavior depends on contract implementation)
    // See contract implementation for actual authorization checks
}
```

### Snapshot Testing

Snapshot testing verifies that contract storage state matches expected values. Soroban SDK provides `insta`-compatible snapshot testing:

```rust
#[test]
fn test_storage_snapshot() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (bridge_id, token_id) = setup_contracts(&env);
    let bridge = OnboardingBridgeClient::new(&env, &bridge_id);
    
    let admin = Address::generate(&env);
    bridge.initialize(&admin, &Address::generate(&env), &50u32, &None);
    
    // Storage state can be inspected and snapshots verified
}
```

Snapshot files are stored in `test_snapshots/` directory and checked into git. Snapshots make it easy to review what changed when contract behavior changes.

### Coverage Expectations

Aim for the following coverage targets:

- **Core logic**: ≥ 90% (all critical paths and error cases)
- **Admin functions**: ≥ 85% (initialization, configuration changes)
- **Batch operations**: ≥ 80% (complex multi-step operations)
- **Event emission**: 100% (every event must be tested)
- **Authorization**: 100% (every auth requirement must be verified)

### Running Specific Tests

```bash
# Run all contract tests
cargo test -p onboarding-bridge --features testutils

# Run a specific test
cargo test -p onboarding-bridge --features testutils test_initialize --

# Run tests matching a pattern
cargo test -p onboarding-bridge --features testutils test_fee -- --nocapture

# Run with output (see println! statements)
cargo test -p onboarding-bridge --features testutils -- --nocapture

# Run benchmarks
cargo test -p onboarding-bridge --features testutils bench_ -- --nocapture
```

## SDK Tests

### Test Framework

SDK tests use [Jest](https://jestjs.io/), a popular JavaScript testing framework configured for TypeScript.

### Configuration

Tests are configured in `sdk/jest.config.js` and discovered automatically from files matching `**/__tests__/**/*.test.ts`.

### Setup

```typescript
import { OnboardingBridgeSDK } from '../bridge';
import { SorobanRpc } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => ({
  // Mock implementation of Stellar SDK
}));

describe('OnboardingBridgeSDK', () => {
  let sdk: OnboardingBridgeSDK;
  
  beforeEach(() => {
    sdk = new OnboardingBridgeSDK(CONFIG);
  });
});
```

### Mock Strategies

#### 1. Mocking External Dependencies

```typescript
jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn().mockImplementation(() => mockProvider),
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ toXDR: () => 'xdr' }),
  })),
}));
```

#### 2. Mocking Responses

```typescript
const mockProvider = {
  getAccount: jest.fn().mockResolvedValue({ sequenceNumber: '100' }),
  sendTransaction: jest.fn().mockResolvedValue({ 
    hash: 'mock_hash', 
    status: 'PENDING' 
  }),
};
```

#### 3. Testing Async Operations

```typescript
describe('fundCAddress', () => {
  it('returns transaction status', async () => {
    const result = await sdk.fundCAddress(params, mockKeypair);
    
    expect(result).toBeDefined();
    expect(result.status).toBe('PENDING');
    expect(mockProvider.sendTransaction).toHaveBeenCalled();
  });
});
```

### Integration vs Unit Tests

- **Unit tests**: Test individual SDK methods in isolation with mocked dependencies
  - Test parameter validation
  - Test error handling
  - Test return value transformation

- **Integration tests**: Test SDK against real or simulated Soroban network
  - Set up actual contract instances
  - Execute real transactions
  - Verify on-chain state changes
  - Usually run in separate test suite (CI environment dependent)

### How to Add Tests

1. Create test file: `sdk/src/__tests__/myfeature.test.ts`

```typescript
import { OnboardingBridgeSDK } from '../bridge';

describe('Feature Name', () => {
  let sdk: OnboardingBridgeSDK;
  
  beforeEach(() => {
    // Setup
  });
  
  it('should do something', () => {
    // Test code
  });
});
```

2. Follow the pattern:
   - **Arrange**: Set up test data and mocks
   - **Act**: Execute the function being tested
   - **Assert**: Verify the result

```typescript
it('should calculate fee correctly', () => {
  // Arrange
  const amount = '1000';
  const feeBps = 100;
  
  // Act
  const fee = sdk.calculateFee(amount, feeBps);
  
  // Assert
  expect(fee).toBe('10');
});
```

## Running Tests

### Contract Tests

```bash
# Run all contract tests
cargo test -p onboarding-bridge --features testutils

# Run tests with output
cargo test -p onboarding-bridge --features testutils -- --nocapture

# Run specific test
cargo test -p onboarding-bridge --features testutils test_initialize --

# Run benchmarks
cargo test -p onboarding-bridge --features testutils bench_ --
```

### SDK Tests

```bash
cd sdk

# Run all tests
npm test

# Run specific test file
npm test bridge.test.ts

# Run with coverage
npm test -- --coverage

# Watch mode (re-run on file changes)
npm test -- --watch
```

### All Tests (CI)

The CI pipeline runs all tests:

```bash
cargo test -p onboarding-bridge --features testutils
cd sdk && npm install && npm test
```

## Test Checklist

Every new feature should include tests for:

- [ ] **Happy Path**: Main feature works as intended
  - Normal inputs produce expected outputs
  - State changes are correct
  - Events are emitted properly

- [ ] **Error Cases**: Invalid operations are rejected
  - Invalid parameters (out of range, wrong type)
  - Pre-condition failures (not initialized, insufficient balance)
  - Authorization failures (not admin, not fee collector)

- [ ] **Edge Cases**: Boundary conditions work correctly
  - Zero amounts / empty vectors
  - Maximum values
  - Repeated operations
  - Concurrent operations (if applicable)

- [ ] **Event Emissions**: All events are logged properly
  - Correct event type
  - Correct event data
  - Event emitted at right time

- [ ] **Authorization Checks**: Only authorized parties can act
  - Admin-only operations reject non-admin callers
  - Fee collector ops reject non-collector callers
  - User-initiated operations require user auth

- [ ] **State Persistence**: Storage changes survive across calls
  - Queries return initialized values
  - Modifications persist across transactions
  - Counters/accumulators work correctly

## Best Practices

### 1. Use Descriptive Test Names

❌ Bad:
```rust
#[test]
fn test_1() { }
```

✅ Good:
```rust
#[test]
fn test_fund_c_address_deducts_fee_from_source() { }
```

### 2. Test One Thing Per Test

❌ Bad:
```rust
#[test]
fn test_contract() {
    // Initialize
    // Fund
    // Check balance
    // Withdraw
    // Check event
}
```

✅ Good:
```rust
#[test]
fn test_initialize_sets_fee_correctly() { }

#[test]
fn test_fund_transfers_net_amount_to_target() { }

#[test]
fn test_withdraw_fees_only_for_fee_collector() { }
```

### 3. Use Helper Functions

```rust
fn create_test_users(env: &Env) -> (Address, Address, Address) {
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let fee_collector = Address::generate(env);
    (admin, user, fee_collector)
}

fn setup_contracts(env: &Env) -> (Address, Address) {
    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(TestToken, ());
    (bridge_id, token_id)
}
```

### 4. Keep Tests Independent

Each test should:
- Not depend on other tests running first
- Not rely on shared state
- Clean up after itself (though Env::default() isolates this)

### 5. Assert on Behavior, Not Implementation

❌ Bad:
```rust
assert_eq!(internal_counter, 5);
```

✅ Good:
```rust
assert_eq!(bridge.query_total_funded(), 5000i128);
```

### 6. Document Complex Test Logic

```rust
#[test]
fn test_batch_fund_with_mixed_valid_blocked_addresses() {
    // Batch funding must succeed for valid targets and fail gracefully for blocked.
    // Invalid transfers should be refunded to source.
    let env = Env::default();
    // ... test code
}
```

### 7. Mock External Systems, Not Core Logic

✅ Mock:
- External API calls
- Blockchain RPC calls
- Time/randomness

❌ Don't Mock:
- Core contract logic
- Data transformations
- State updates

## See Also

- [Soroban SDK Documentation](https://docs.rs/soroban-sdk/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Stellar SDK Documentation](https://developers.stellar.org/learn/basics/stellar-ecosystem/stellar-sdks)
