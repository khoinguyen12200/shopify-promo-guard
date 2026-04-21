# Promo Guard — one-command orchestrator

SHELL := /bin/bash

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

# Local dev database (docker-compose). Uses port 5434 to avoid clashing with
# any system Postgres or other Shopify projects (repair-ops uses 5433).
DEV_DB_URL  := postgresql://promo:promo@localhost:5434/promo_guard
DEV_DB_NAME := promo-guard-db

# JS function extensions — built via Shopify CLI (Javy → wasm).
JS_FUNCTION_EXTENSIONS := promo-guard-validator

# ──────────────────────────────────────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Print available targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ──────────────────────────────────────────────────────────────────────────────
# Top-level
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: setup
setup: check-prereqs install db-up db-migrate functions-schema seed ## First-time initialization
	@echo ""
	@echo "✅ Setup complete. Next: run 'make dev'."

.PHONY: dev
dev: db-up ## Start Remix + Shopify CLI + background job worker. Ctrl+C stops all.
	@echo "Starting dev processes (app + worker). Ctrl+C to stop everything."
	@# `shopify app dev` runs the Remix app + extension watchers + a
	@# cloudflared tunnel (needed so Shopify can POST webhooks to your
	@# laptop). cloudflared must be on PATH — install via:
	@#   brew install cloudflared
	@# To override with a different tunnel (e.g. ngrok):
	@#   TUNNEL_URL=https://…  make dev
	@# The worker polls the Job table so webhooks, cold-start backfills,
	@# and shard appends actually run. Without it, jobs queue up and no
	@# signals get collected. `make worker` still works if you want to
	@# run it in its own terminal.
	@npm run worker & WORKER_PID=$$!; \
	 trap 'kill $$WORKER_PID 2>/dev/null; wait 2>/dev/null' INT TERM EXIT; \
	 shopify app dev $(if $(TUNNEL_URL),--tunnel-url $(TUNNEL_URL))

.PHONY: worker
worker: ## Run only the background job worker (alternative to bundled `make dev`)
	npm run worker

.PHONY: build
build: build-remix build-functions build-extensions ## Production build of everything
	@echo "✅ Build complete."

.PHONY: test
test: test-node test-functions ## Run all tests
	@echo "✅ All tests passed."

.PHONY: verify
verify: lint typecheck test ## What CI runs on every PR
	@echo "✅ verify passed."

.PHONY: clean
clean: db-down ## Remove generated artifacts and stop docker
	rm -rf build/ public/build/ node_modules/.cache/
	@for ext in $(JS_FUNCTION_EXTENSIONS); do \
		rm -rf extensions/$$ext/dist 2>/dev/null || true; \
	done

# ──────────────────────────────────────────────────────────────────────────────
# Prerequisites check
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: check-prereqs
check-prereqs: ## Verify required tools are installed
	@command -v node >/dev/null 2>&1 || { echo "❌ node missing — install Node 20+"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "❌ npm missing"; exit 1; }
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker missing — install Docker Desktop"; exit 1; }
	@command -v shopify >/dev/null 2>&1 || { echo "❌ shopify CLI missing — npm i -g @shopify/cli@latest"; exit 1; }
	@command -v cloudflared >/dev/null 2>&1 || { echo "❌ cloudflared missing — brew install cloudflared (avoids Shopify CLI fetching it over flaky GitHub releases)"; exit 1; }
	@node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20){process.exit(1)}" || { echo "❌ Node 20+ required, got $$(node -v)"; exit 1; }
	@echo "✅ prereqs OK"

# ──────────────────────────────────────────────────────────────────────────────
# Install / deps
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: install
install: ## Install Node deps (top-level + workspaces)
	npm install

# ──────────────────────────────────────────────────────────────────────────────
# Database (local dev — docker-compose)
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: db-up
db-up: ## Start local Postgres via docker-compose
	docker compose up -d db
	@echo "Waiting for Postgres to be ready..."
	@for i in $$(seq 1 30); do \
		docker compose exec -T db pg_isready -U promo -d promo_guard >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@echo "✅ db ready at $(DEV_DB_URL)"

.PHONY: db-down
db-down: ## Stop local Postgres
	docker compose stop db 2>/dev/null || true

.PHONY: db-reset
db-reset: ## Drop and recreate the dev DB (destructive!)
	docker compose down -v
	$(MAKE) db-up
	$(MAKE) db-migrate
	$(MAKE) seed

.PHONY: db-migrate
db-migrate: ## Apply Prisma migrations to the dev DB
	DATABASE_URL="$(DEV_DB_URL)" DIRECT_DATABASE_URL="$(DEV_DB_URL)" \
		npx prisma migrate dev

.PHONY: db-generate
db-generate: ## Regenerate the Prisma client
	npx prisma generate

.PHONY: db-studio
db-studio: ## Open Prisma Studio against the dev DB
	DATABASE_URL="$(DEV_DB_URL)" npx prisma studio

.PHONY: db-psql
db-psql: ## Open a psql session against the dev DB
	docker compose exec db psql -U promo -d promo_guard

.PHONY: seed
seed: ## Seed the dev DB with a fake shop + sample data (idempotent)
	@if [ -f scripts/seed-dev.ts ]; then \
		DATABASE_URL="$(DEV_DB_URL)" npx tsx scripts/seed-dev.ts; \
	else \
		echo "⚠  scripts/seed-dev.ts not created yet (task T04) — skipping seed."; \
	fi

# ──────────────────────────────────────────────────────────────────────────────
# Shopify Functions (TypeScript)
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: functions-schema
functions-schema: ## Download the latest Function schemas (Shopify → schema.graphql per extension)
	@for ext in $(JS_FUNCTION_EXTENSIONS); do \
		if [ -d extensions/$$ext ]; then \
			echo "→ schema for $$ext"; \
			(cd extensions/$$ext && shopify app function schema --stdout > schema.graphql); \
		fi; \
	done

.PHONY: build-functions
build-functions: ## Build all JS function extensions to wasm (via Javy)
	@for ext in $(JS_FUNCTION_EXTENSIONS); do \
		if [ -d extensions/$$ext ]; then \
			echo "→ building $$ext"; \
			(cd extensions/$$ext && npm run build); \
		fi; \
	done
	@$(MAKE) functions-verify-size

.PHONY: functions-verify-size
functions-verify-size: ## Verify each .wasm is under the 256 KB Shopify limit
	@ok=1; \
	for ext in $(JS_FUNCTION_EXTENSIONS); do \
		wasm=$$(find extensions/$$ext -name "*.wasm" -type f 2>/dev/null | head -1); \
		if [ -n "$$wasm" ]; then \
			size=$$(wc -c < "$$wasm"); \
			if [ "$$size" -gt 256000 ]; then \
				echo "❌ $$wasm is $$size bytes (exceeds 256000)"; \
				ok=0; \
			else \
				echo "✅ $$wasm — $$size bytes"; \
			fi; \
		fi; \
	done; \
	if [ $$ok -eq 0 ]; then exit 1; fi

# ──────────────────────────────────────────────────────────────────────────────
# Remix app + extensions
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: build-remix
build-remix: db-generate ## Build Remix app for production
	npm run build

.PHONY: build-extensions
build-extensions: ## Build non-Function extensions (Admin UI extension)
	@# Shopify CLI builds UI extensions as part of `shopify app deploy`. For local
	@# artifact verification we can run `shopify app build`.
	shopify app build 2>/dev/null || echo "⚠  shopify app build not yet applicable (scaffold extensions first)."

# ──────────────────────────────────────────────────────────────────────────────
# Quality gates
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: lint
lint: ## Run linters
	npm run lint

.PHONY: typecheck
typecheck: db-generate ## Typecheck TypeScript
	npm run typecheck 2>/dev/null || npx tsc --noEmit

.PHONY: test-node
test-node: db-generate ## Run Node tests (Vitest)
	npx vitest run --config ./vitest.config.ts

.PHONY: test-functions
test-functions: ## Run JS function extension unit tests
	@for ext in $(JS_FUNCTION_EXTENSIONS); do \
		if [ -d extensions/$$ext ]; then \
			echo "→ test ($$ext)"; \
			(cd extensions/$$ext && npm test -- --run) || exit 1; \
		fi; \
	done

# ──────────────────────────────────────────────────────────────────────────────
# Deploy
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: deploy
deploy: ## Deploy app + extensions to Shopify (staging). Production uses Cloud Build.
	@echo "⚠  Production deploys run via gcloud builds submit, not this target."
	@echo "    See cloudbuild.yaml (created in task T54)."
	shopify app deploy
