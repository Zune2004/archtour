# Contributing to Archtour

## Setup

- **Node.js**: Requires Node.js 22.12 or later (`node >= 22.12`; the rendering libraries need it).
- **Browser**: Chrome or Edge (or Chromium) must be installed on your system. Archtour uses your existing system browser instead of downloading a separate Chromium binary.
- **Dependencies**: Install dependencies using:
  ```bash
  npm ci
  ```

## Development & Test Commands

- **Run test suite**:
  ```bash
  npm test
  ```
- **Run project checks**:
  ```bash
  npm run check
  ```

## Code Layout

- `tools/` - CLI (`tools/cli.mjs`), parsers, rules and the PR comment.
- `tests/` - Automated test suite.
- `docs/` - Specification, documentation, and prompt guides.

## Rules

1. **Tests for new behaviour**: All bug fixes and new features must include automated tests in `tests/`.
2. **No new dependencies without discussion**: Keep the package lean; do not introduce new dependencies without prior discussion.
3. **Keep output one self-contained HTML file**: Rendered diagrams must be completely self-contained in a single HTML file with embedded fonts and assets.
4. **Offline by default**: Archtour must function completely offline without external network requests or telemetry.
