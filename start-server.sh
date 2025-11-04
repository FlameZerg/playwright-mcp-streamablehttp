#!/bin/sh

# Set the PORT environment variable if not set
export PORT=${PORT:-8081}

# Start the server with explicit host binding
# The server may ignore --host flag, so we'll use a different approach
exec node cli.js --headless --browser chromium --no-sandbox --port $PORT
