FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npm install --no-save @cloudflare/workerd-linux-64

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

# Set RUN_MODE=local to use Node's native HTTPS stack instead of Wrangler's
# embedded Worker runtime. This avoids trust-store differences on self-hosted hosts.
CMD ["sh", "-c", "if [ \"$RUN_MODE\" = \"local\" ]; then npm run local; else npx wrangler dev --local --ip 0.0.0.0 --port 8787; fi"]
