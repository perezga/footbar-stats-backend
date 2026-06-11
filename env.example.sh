# Source this file (or copy these exports into your shell profile / direnv).
#
#   source backend/env.example.sh
#   npm run dev
#
# Required:
export FOOTBAR_CLIENT_ID="your-client-id"
export FOOTBAR_CLIENT_SECRET="your-client-secret"
export COOKIE_SECRET="$(openssl rand -hex 32)"

# Optional — defaults shown:
# export REDIRECT_URI="https://localhost:4000/auth/callback"   # Footbar requires https
# export FRONTEND_ORIGIN="http://localhost:5173"
# export PORT=4000

# Optional — Footbar account for the daily background sync (lets the scheduler
# log in headlessly; without it the sync reuses the browser-login tokens):
# export FOOTBAR_USERNAME="you@example.com"
# export FOOTBAR_PASSWORD="…"
# export SYNC_INTERVAL_HOURS=24   # 0 disables the background sync
