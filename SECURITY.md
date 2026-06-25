# Security Policy

## Supported Versions

Security fixes are accepted for the current default branch and the latest deployed contract artifacts derived from it. Older experimental branches, forks, generated build outputs, and abandoned proof-of-concept deployments are not covered unless a maintainer explicitly marks them as supported.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability before the maintainers have had time to review it.

Preferred reporting channels:

- Use GitHub private vulnerability reporting when it is enabled for this repository.
- If private reporting is unavailable, contact the project maintainers through the organization profile and include a clear security subject line.

A useful report should include:

- Affected contract, function, SDK, or deployment component.
- Impact assessment, including affected funds, authorization boundaries, or availability risks.
- Reproduction steps or a minimal proof of concept.
- Whether the issue has been disclosed anywhere else.
- Suggested remediation if you have one.

## Disclosure Timeline

The maintainers aim to acknowledge valid reports within 3 business days and provide an initial triage update within 10 business days. Public disclosure should wait until a fix is merged and users have had reasonable time to upgrade or migrate, unless active exploitation requires a faster coordinated notice.

## Scope

In scope:

- Smart contract authorization, accounting, escrow, fee, and refund logic.
- Cross-contract calls, token transfer flows, and storage persistence behavior.
- SDK behavior that could cause unsafe signing, transaction construction, or user fund movement.
- CI, deployment, or documentation defects that could lead to insecure production usage.

Out of scope:

- Social engineering, spam, denial-of-service against third-party infrastructure, or physical attacks.
- Vulnerabilities that require leaked private keys, compromised maintainer accounts, or malicious forks.
- Reports based only on automated scanner output without a concrete exploit path.
- Issues in dependencies that do not affect this repository's deployed behavior.

## Safe Harbor

Good-faith research that stays within the scope above, avoids privacy violations, and does not move or lock user funds without permission will be treated as authorized security research. Stop testing and report immediately if you encounter live funds, secrets, or personal data.

## Bug Bounty Information

This repository may use issue-specific rewards or external bounty programs. Unless a bounty is explicitly attached to an issue or announced by maintainers, submitting a report does not guarantee payment.

## Recognition

Reporters who provide actionable, coordinated disclosures may be credited in release notes, advisories, or the related pull request unless they request anonymity.
