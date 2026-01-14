# Quick Start: Local Community Solid Server

This guide will help you quickly set up a local Community Solid Server (CSS) for development.

## Step 1: Start the CSS Server (No Installation Needed!)

The script uses `npx`, so you don't need to install anything:

```bash
npm run css:start
```

This will start the CSS server on `http://localhost:3000` (or the port specified in `CSS_PORT` environment variable).

**Note:** The first time you run this, `npx` will download the Community Solid Server package, which may take a minute.

## Step 2: Pre-seeded Pods

The server is configured with pre-seeded pods in `seed-config.json`. You can use these accounts:

- **ruky**: `rukyjacob@gmail.com` / `Test123$` → WebID: `http://localhost:3000/ruky/profile/card#me`
- **alice**: `alice@example.com` / `alice123` → WebID: `http://localhost:3000/alice/profile/card#me`
- **bob**: `bob@example.com` / `bob123` → WebID: `http://localhost:3000/bob/profile/card#me`
- **charlie**: `charlie@example.com` / `charlie123` → WebID: `http://localhost:3000/charlie/profile/card#me`

You can also create additional accounts by:
1. Opening your browser and going to `http://localhost:3000`
2. Clicking "Register" to create a new account
3. Choosing a username (e.g., `testuser`)
4. Your WebID will be: `http://localhost:3000/testuser/profile/card#me`

## Step 3: Configure LibreChat

Make sure your `.env` file has:

```bash
DOMAIN_SERVER=http://localhost:3080
DOMAIN_CLIENT=http://localhost:3080
```

## Step 4: Test Login

1. Start your LibreChat backend: `npm run backend:dev`
2. Start your LibreChat frontend: `npm run frontend:dev`
3. Go to the login page
4. Select "Solid" as the provider
5. Enter `http://localhost:3000` as the issuer URL
6. Login with one of the pre-seeded accounts (e.g., `rukyjacob@gmail.com` / `Test123$`)

The pre-seeded pods are automatically created when the CSS server starts, so you can immediately use them for testing.

## Benefits

- No need for tunnel services (ngrok, etc.)
- Local CSS can access `localhost:3080` URLs
- Faster development cycle
- Full control over the Pod server
- Works offline
- No global installation needed (uses npx)

## Troubleshooting

### Port Already in Use

If port 3000 is in use, use a different port:

```bash
CSS_PORT=3001 npm run css:start
```

Then use `http://localhost:3001` as the issuer URL.

### Cannot Access Client Identifier Document

Make sure:
1. Both CSS server and LibreChat backend are running
2. `DOMAIN_SERVER` is set to `http://localhost:3080` (not `https://`)
3. You're using `http://localhost:3000` as the issuer (not `https://`)

### CSS Server Won't Start

Check if the data directory exists and is writable:

```bash
mkdir -p css-server/data
chmod -R 755 css-server/data
```

### Remote Context Loading Errors

If you see errors about loading remote contexts:
1. Check your internet connection (first run needs to download CSS)
2. Try again - it might be a temporary network issue
3. The config uses a stable version (^6.0.0) that should work

### Permission Errors

If you get permission errors, the script already uses `npx` which should avoid this. If issues persist:
1. Don't use `sudo` with npm
2. Fix npm permissions: `npm config set prefix ~/.npm-global`
3. Or install CSS locally: `npm install --save-dev @solid/community-server`
