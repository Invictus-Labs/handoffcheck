# HandoffCheck demo image: DOCUMENTATION AND DEMO ONLY.
#
# A container is NOT the isolation boundary for HandoffCheck. Release code that you drill is untrusted
# input; the supported isolation is a dedicated disposable Linux VM (the `lima` provider), with an
# egress policy. This image only runs the offline synthetic demo (provider `local-sandbox`,
# isolation "none") so you can see the report format without installing Node. Its receipts are
# labelled isolation=none and can never satisfy a VM-isolation criterion.
#
#   docker build -t handoffcheck-demo .
#   docker run --rm --network none handoffcheck-demo            # outbound denied: the core must still work
#   docker run --rm --network none -v "$PWD/out:/out" handoffcheck-demo demo --output /out
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY schemas ./schemas
COPY migrations ./migrations
COPY templates ./templates
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY tests ./tests
COPY vitest.config.ts ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    HANDOFFCHECK_TELEMETRY=off
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/schemas ./schemas
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/templates ./templates
COPY --from=build /app/fixtures ./fixtures
RUN useradd --system --create-home --uid 10001 handoff && mkdir -p /out && chown handoff /out
USER handoff
VOLUME ["/out"]
ENTRYPOINT ["node", "/app/dist/src/cli.js"]
CMD ["demo", "--output", "/out"]
