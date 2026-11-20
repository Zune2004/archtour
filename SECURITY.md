# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

Please report vulnerabilities using **GitHub Private Vulnerability Reporting** on this repository:
1. Go to the repository's **Security** tab.
2. Select **Advisories** and click **Report a vulnerability**.

Do not report security vulnerabilities via public GitHub issues, discussions, or pull requests. There is no email address for vulnerability reports; please use GitHub private vulnerability reporting exclusively.

## Scope & Guidelines

- **CLI Scope**: The core commands (`interactive`, `from-code`, `scan`, `diff`, renderers) read local files and upload nothing; rendering, layout, parsing and export run locally. The experimental `ai` command sends your prompt to the AI provider you choose, and `publish` uploads a diagram to the destination you name; both only when you run them.
- **Experimental Server**: The optional self-hosted server (`server/server.mjs`) is experimental and must run behind a reverse proxy that terminates HTTPS.
- **Secrets in Specs**: Never paste secrets, credentials, tokens, or sensitive values into diagram specs.
