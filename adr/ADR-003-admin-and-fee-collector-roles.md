# ADR-003: Separate admin and fee collector roles

## Status

Accepted

## Context

The bridge requires privileged operations for configuration and treasury operations. Combining all privileges into one key would be simple, but it increases the impact of key compromise and makes operational ownership unclear.

## Decision

The contract separates the admin role from the fee collector role. The admin controls configuration such as fee settings and role changes. The fee collector can withdraw accumulated fees but cannot change bridge configuration.

## Consequences

Role separation reduces blast radius and supports different custody models for operations and treasury. Deployments must document who controls each key and how key rotation is approved. Tests and SDK examples should keep the two roles distinct so integrations do not assume a single privileged signer.
