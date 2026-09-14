#!/bin/bash
# Deploy metamodern.md to production (Vercel).
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

vercel --prod --yes
