# ADR-002: Open asset model instead of asset whitelist

## Status

Accepted

## Context

The bridge can either restrict funding to an allowlist of asset contracts or accept any asset contract provided by the caller. A whitelist improves operational control, but it adds administration overhead and can block new assets until governance updates the list.

## Decision

The initial contract uses an open asset model. Callers provide the asset contract address for each funding operation, and the bridge routes that asset according to the request. Asset risk assessment is handled by integrators and user interfaces rather than by an on-chain allowlist.

## Consequences

The bridge remains flexible and can support new Stellar assets without contract administration. Integrators must validate supported assets before exposing them to end users. If abuse or compliance requirements demand tighter control later, an allowlist can be introduced as a versioned contract change.
