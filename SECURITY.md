# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting (the "Report a vulnerability" button under the repository's Security tab), or email the maintainer at the address listed on the npm package. I will acknowledge the report, work with you on a fix, and credit you when the fix ships unless you prefer otherwise.

## Supported versions

sitepass is pre-1.0. Fixes land on the latest published version. Once 1.0 is out, the latest minor will receive security fixes.

## Review note

The constant-time comparison and the cookie signing scheme are the security-critical parts of this package. They live in `src/core.ts`. Before tagging a 1.0 release, these should get a second pair of eyes from someone familiar with timing-safe comparison and HMAC token design.

## What sitepass does and does not defend against

It puts one shared password in front of a site and signs a stateless session cookie. It is meant for previews, staging, and simple private sites.

It does not provide per-user accounts, rate limiting, or audit logs. A shared password is brute-forceable, so use a long passphrase. For anything that needs real identity or compliance, use a dedicated auth provider.
