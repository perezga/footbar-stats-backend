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
