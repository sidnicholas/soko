#!/usr/bin/env bash
# Full vitest suite, including live-DB e2e tests, against a throwaway local
# Postgres (infra/docker/docker-compose.test.yml) — never the DATABASE_URL in
# .env. Extra arguments go to vitest, e.g. `pnpm test:db tests/e2e/search.test.ts`.
set -euo pipefail
cd "$(dirname "$0")/.."

export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:54329/opportunity_os_test}"

COMPOSE=(docker compose -f infra/docker/docker-compose.test.yml)
# Recreate on every run: data is tmpfs, so this starts from an empty database
# and results don't depend on what a previous run left behind.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
pnpm exec vitest run "$@"
