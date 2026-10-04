FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

# Run the Worker locally in the container; Wrangler provides the Web Worker
# runtime while binding the MCP endpoint to all container interfaces.
CMD ["npx", "wrangler", "dev", "--local", "--ip", "0.0.0.0", "--port", "8787"]
