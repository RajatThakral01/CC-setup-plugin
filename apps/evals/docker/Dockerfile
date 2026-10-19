# Eval image (plan M9 9.2): the Next.js fixture with dependencies and browsers pre-installed, plus a
# pinned Claude Code. Built by `pnpm evals image`; every input is pinned (base digest, Claude Code
# version, lockfile, Playwright versions), and the tag is a hash of those inputs.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BASE_IMAGE}
ARG CLAUDE_CODE_VERSION
ARG EXTRA_PLAYWRIGHT_VERSIONS=""
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    DISABLE_AUTOUPDATER=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git procps python3 \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version
COPY next-app/ /home/node/app/
WORKDIR /home/node/app
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && for v in ${EXTRA_PLAYWRIGHT_VERSIONS}; do npx -y "playwright@${v}" install chromium; done \
 && chmod -R a+rX /opt/ms-playwright \
 && chown -R node:node /home/node/app
USER node
# One build up front: Next normalises tsconfig.json on first build (kept out of run diffs) and the
# build cache makes the hidden checks faster.
RUN npm run build \
 && git init -q \
 && git add -A \
 && git -c user.email=eval@example.invalid -c user.name=eval commit -qm "fixture baseline"
