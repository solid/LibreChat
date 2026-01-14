# Installing Community Solid Server

The CSS server needs to be installed locally to avoid remote context loading issues.

## Installation

Run this command in your terminal:

```bash
npm install --save-dev @solid/community-server@^8.0.0-alpha.1
```

This will install CSS as a dev dependency, which allows it to resolve the context files locally instead of fetching them from the remote service.

## After Installation

Once installed, you can start the server with:

```bash
npm run css:start
```

## Why Local Installation?

When using `npx`, CSS tries to fetch the context files from a remote service (`linkedsoftwaredependencies.org`), which can fail due to:
- Network issues
- Service downtime
- Rate limiting

Installing it locally ensures all context files are available locally, avoiding these issues.
