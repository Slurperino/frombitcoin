FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY contracts ./contracts
COPY chainlink ./chainlink
COPY public ./public
COPY scripts ./scripts
COPY schemas ./schemas
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/chainlink ./chainlink
COPY --from=build /app/public ./public
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY schemas ./schemas
COPY config ./config

RUN mkdir -p /var/lib/bitcoinbride && chown -R node:node /var/lib/bitcoinbride

USER node

CMD ["npm", "run", "service:redeems", "--", "--help"]
