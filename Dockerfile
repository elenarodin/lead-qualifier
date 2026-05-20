FROM node:22-alpine AS build
WORKDIR /app

# Install build toolchain for better-sqlite3 native module.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 needs its prebuilt .node binary at runtime. Copy node_modules
# wholesale from the build stage (already contains the compiled binding).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY rubric.yaml ./

# Fly volume is mounted at /data
ENV DB_PATH=/data/qualifier.db

CMD ["node", "dist/index.js"]
