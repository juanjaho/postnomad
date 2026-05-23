# Security

Postnomad is a personal fork of [Bruno](https://github.com/usebruno/bruno) and shares essentially all of its security-relevant code with upstream.

## Reporting a vulnerability

For issues you believe affect **upstream Bruno** as well, please report them to the Bruno security team — they're far better positioned to fix and disclose them across the whole user base. See [Bruno's security policy](https://github.com/usebruno/bruno/blob/main/security.md).

For issues that only apply to **this fork** (changes I've made on top of upstream), open a private security advisory on the GitHub repo. Please do **not** report security issues through public GitHub issues.

When reporting, include as many details as possible:

- **Type of issue** (e.g., XSS, prototype pollution, RCE in the script sandbox, malicious npm package, etc.)
- **Full paths of source file(s)** related to the issue
- **Location of affected code** (commit SHA or direct URL)
- **Any special configuration** required to reproduce
- **Step-by-step reproduction**
- **Proof-of-concept or exploit code** (if available)
- **Potential impact** and how an attacker might exploit it
