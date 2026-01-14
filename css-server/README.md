# Local Community Solid Server (CSS) Setup

This directory contains the configuration for running a local Community Solid Server for development and testing.

## Prerequisites

1. Node.js (v18 or higher)
2. npm or yarn

## Installation

You can use CSS in two ways:

### Option 1: Use npx (Recommended - No Installation Needed)

The `css:start` script uses `npx`, so you don't need to install CSS globally. Just run:

```bash
npm run css:start
```

### Option 2: Install Globally

```bash
npm install -g @solid/community-server
```

Then you can run CSS directly:

```bash
community-solid-server -c css-server/config.json -f css-server/data -p 3000
```

### Option 3: Install Locally

```bash
npm install --save-dev @solid/community-server
```

Then update the script in `package.json` to use the local installation.

## Configuration

The `config.json` file uses the default file-based configuration which:
- Runs on `http://localhost:3000` (default CSS port)
- Stores Pod data in `./css-server/data/`
- Enables public access for testing
- Supports OIDC authentication
- Uses ACP (Access Control Policy) for authorization

## Running the Server

### Using npm script (Recommended)

```bash
npm run css:start
```

### Using npx directly

```bash
npx @solid/community-server -c css-server/config.json -f css-server/data -p 3000
```

### Using Docker

Create a `docker-compose.css.yml`:

```yaml
services:
  css:
    image: solidproject/community-server:latest
    ports:
      - "3000:3000"
    volumes:
      - ./css-server/data:/data
      - ./css-server/config.json:/config.json
    command: ["-c", "/config.json", "-f", "/data", "-p", "3000"]
```

Then run:

```bash
docker-compose -f docker-compose.css.yml up -d
```

## Environment Variables

You can override the default port:

- `CSS_PORT`: Port to run CSS on (default: 3000)

Example:

```bash
CSS_PORT=3001 npm run css:start
```

## Using with LibreChat

Once the CSS server is running:

1. The server will be available at `http://localhost:3000`
2. You can create a Pod by visiting `http://localhost:3000/`
3. Use `http://localhost:3000` as the issuer URL when logging in with Solid in LibreChat
4. The local CSS can access `localhost:3080` URLs, solving the Client Identifier Document issue

## Testing

1. Start the CSS server:
   ```bash
   npm run css:start
   ```

2. Create a test Pod:
   - Visit `http://localhost:3000/`
   - Register a new account
   - Note your WebID (e.g., `http://localhost:3000/username/profile/card#me`)

3. Test authentication in LibreChat:
   - Use `http://localhost:3000` as the issuer
   - Login with your test account

## Troubleshooting

### Port Already in Use

If port 3000 is already in use, change it:

```bash
CSS_PORT=3001 npm run css:start
```

Then update your `.env` to use the correct issuer URL.

### Permission Errors

If you get permission errors with a global installation, use `npx` instead (which the script already does).

### Cannot Access Client Identifier Document

The local CSS server should be able to access `localhost:3080`. If you still have issues:

1. Make sure both servers are running
2. Check that `DOMAIN_SERVER` in your `.env` is set to `http://localhost:3080`
3. Verify the CSS server can reach your LibreChat backend

### Remote Context Loading Errors

If you see errors about loading remote contexts, it might be a network issue. The config uses version `^6.0.0` which should be stable. If problems persist, try:

1. Check your internet connection
2. Try using a different CSS version
3. Use Docker instead (which includes all dependencies)
