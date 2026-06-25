# ADR-001: Fee model and basis point calculation

## Status

Accepted

## Context

The bridge needs a predictable way to charge fees when routing assets to C addresses. The fee value must be precise enough for small transfers, simple enough to audit, and compatible with integer-only smart contract arithmetic.

## Decision

The contract represents fees in basis points. One basis point is 0.01 percent, so 100 basis points equals 1 percent. Fee calculation uses integer multiplication followed by division by 10,000. The contract caps the configured fee to prevent excessive values.

## Consequences

Basis points are familiar to financial integrators and avoid floating point arithmetic. Very small transfers can round down because the contract uses integer division. Any future tiered pricing model should preserve the same unit so SDKs, documentation, and operational runbooks remain compatible.
