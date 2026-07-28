# Security Policy

This document outlines the security policy for the **C-Address Onboarding Bridge** project, including supported versions, how to report vulnerabilities, disclosure timelines, and the scope of security research.

---

## Supported Versions

The following versions of the C-Address Onboarding Bridge contract and SDK are currently supported with security patches:

| Component | Version | Status |
|-----------|---------|--------|
| Smart Contract (`onboarding-bridge`) | `0.1.0` | ✅ Actively supported |
| TypeScript SDK (`@stellar/c-address-onboarding-bridge-sdk`) | `0.1.0` | ✅ Actively supported |

### Version Support Policy

- **Active support**: We provide security patches for the latest released version of each component.
- **End-of-life (EOL)**: Once a new minor or major version is released, the previous version will receive critical security patches for **90 days** before reaching EOL.
- **Pre-release versions** (alpha, beta, RC) are not eligible for security patches. Please upgrade to the latest stable release.
- **WASM bytecode hashes** of deployed contracts are tracked in release notes. Always verify the on-chain WASM hash matches the audited source before interacting with a deployed contract.

---

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you believe you have found a security issue in any component within the scope defined below, please report it to us as soon as possible.

### Reporting Channels

1. **GitHub Private Vulnerability Reporting** (preferred):
   - Navigate to the [Security Advisories](https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/security/advisories) page of this repository.
   - Click **"Report a vulnerability"** and submit your findings.
   - This method keeps your report confidential and allows for threaded discussion with maintainers.

2. **Email** (alternative):
   - Send an encrypted or plain-text email to: `security@c-address-onboarding-bridge.dev`
   - Use the subject line: `[SECURITY] C-Address Onboarding Bridge — &lt;brief description&gt;`
   - Include a detailed description, steps to reproduce, and any proof-of-concept code.

### What to Include in Your Report

- A clear description of the vulnerability and its potential impact.
- The affected component(s) and version(s).
- Step-by-step instructions to reproduce the issue.
- Proof-of-concept code, transaction XDRs, or test cases (if applicable).
- Your assessment of severity (Critical, High, Medium, Low, Informational).
- Any suggested remediation or fix.

### What to Expect

| Phase | Timeline | Action |
|-------|----------|--------|
| Acknowledgment | Within 48 hours | We will confirm receipt of your report and begin triage. |
| Initial Assessment | Within 7 days | We will validate the vulnerability and assign a severity rating. |
| Fix Development | Varies by severity | Critical/High: 14–30 days. Medium: 30–60 days. Low: 60–90 days. |
| Patch Release | With fix | We will publish a patched release and coordinated security advisory. |
| Public Disclosure | 90 days after fix or by mutual agreement | See [Disclosure Timeline](#disclosure-timeline) below. |

We will keep you informed of our progress throughout the process. If you do not receive a response within the timelines above, please feel free to follow up.

---

## Disclosure Timeline

We follow a **coordinated disclosure** model to protect users while allowing time for fixes to be developed and deployed.

- **Confidentiality period**: Reports remain confidential for up to **90 days** from the date of acknowledgment, or until a fix is released — whichever comes first.
- **Extension**: If additional time is needed to develop or deploy a fix (e.g., for complex contract upgrades or ecosystem coordination), we may request an extension. We will discuss this with you transparently.
- **Public disclosure**: After a fix is released, we will publish a security advisory on GitHub detailing:
  - The vulnerability category and CVE ID (if assigned).
  - Affected versions and the patched version.
  - A technical summary (without exploitable details).
  - Credit to the reporter.
- **Early disclosure**: If a vulnerability is actively exploited in the wild before a fix is ready, we may accelerate public disclosure to protect the community. We will coordinate this with the reporter whenever possible.

---

## Bug Bounty

**There is currently no formal bug bounty program for this project.**

We deeply value the time and effort security researchers invest in helping us improve the security of the C-Address Onboarding Bridge. While we cannot offer monetary rewards at this time, we offer:

- **Public recognition** in our [Security Hall of Fame](#recognition-policy-for-reporters).
- **Credit** in release notes and security advisories.
- **Collaboration** on fixes and technical write-ups (with your consent).

If a bug bounty program is launched in the future, this section will be updated, and eligible past reports may be considered retroactively.

---

## Scope

### In Scope

The following components and attack surfaces are within scope for security research:

| Component | Language | In-Scope Vulnerabilities |
|-----------|----------|--------------------------|
| **Smart Contract** (`contracts/onboarding-bridge/`) | Rust (Soroban) | Re-entrancy, integer overflow/underflow, authorization bypasses, fee manipulation, access control flaws, storage collision, upgrade logic flaws, panic/DoS, unauthorized token transfers |
| **TypeScript SDK** (`sdk/`) | TypeScript | Input validation flaws, keypair exposure in memory, insecure memo generation, RPC injection, transaction manipulation, dependency vulnerabilities |
| **Indexer** (`indexer/`) | Rust | Event parsing flaws, database injection, unauthorized webhook calls, data integrity issues |
| **Relayer** (`relayer/`) | TypeScript | Authentication bypasses, relay manipulation, replay attacks, insecure configuration handling |
| **Deployment Scripts** (`scripts/`) | TypeScript | Secret key exposure, insecure configuration, supply chain attacks |

Security-relevant tests for the Indexer and Relayer should cover the
vulnerability classes listed above. See `TESTING.md` for the expected indexer
and relayer testing strategy once their test harnesses are added.

### Out of Scope

The following are **not** eligible for vulnerability reports under this policy:

- **Stellar core, Soroban runtime, or `stellar-sdk`**: Vulnerabilities in the Stellar protocol, Soroban VM, or official Stellar SDKs should be reported to the [Stellar Foundation](https://stellar.org) or the respective upstream repository.
- **Third-party on-ramp providers** (Moonpay, Transak, CEXs): Issues with payment processors, KYC flows, or exchange APIs are outside our control.
- **User key management**: Loss of private keys, phishing, or social engineering attacks targeting end users.
- **Documentation typos** or non-security-related bugs (please open a regular GitHub issue instead).
- **Denial of Service (DoS)** via network-level attacks (e.g., RPC spam) that do not exploit contract or SDK logic.
- **Physical security** or infrastructure attacks against our GitHub organization or CI/CD providers.
- **Vulnerabilities in end-of-life (EOL) versions** of any component.

### Safe Harbor

We support and encourage security research conducted in good faith. If you follow this policy and act in good faith:

- We will **not** pursue legal action against you for your research.
- We will **not** report you to law enforcement for your research.
- We will **not** revoke any access you may have to our open-source repositories.

To remain in good faith, you must:

- Avoid accessing, modifying, or deleting data belonging to others.
- Avoid disrupting production services or mainnet deployments.
- Avoid social engineering, phishing, or physical attacks.
- Stop testing and report immediately if you encounter user data or private keys.

---

## Recognition Policy for Reporters

We believe in publicly acknowledging the security researchers who help us keep this project safe.

### Security Hall of Fame

Researchers who report valid, non-duplicate vulnerabilities (Medium severity or higher) will be listed in our Security Hall of Fame, published in the repository's `SECURITY.md` and release notes.

| Researcher | Date | Contribution | Severity |
|------------|------|--------------|----------|
| *(To be populated as reports are received)* | | | |

### Recognition Details

- **Credit in advisories**: Your name (or alias) and affiliation will be included in the GitHub Security Advisory and release notes, unless you request anonymity.
- **LinkedIn / Twitter shout-outs**: With your permission, we will publicly thank you on our project's social media channels.
- **Collaboration invites**: For significant contributions, we may invite you to participate in pre-release security reviews or design discussions.
- **No monetary compensation**: As noted in [Bug Bounty](#bug-bounty), we do not currently offer financial rewards.

### Anonymity

If you prefer to remain anonymous, we fully respect that. Simply indicate your preference when submitting the report, and we will credit you as "Anonymous" or omit your name entirely.

---

## Contact & Resources

- **Security Advisories**: [https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/security/advisories](https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/security/advisories)
- **Security Email**: `security@c-address-onboarding-bridge.dev`
- **General Issues**: [https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/issues](https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge--Contract/issues)

---

*Last updated: 2024-06-29*
*Version: 1.0*
