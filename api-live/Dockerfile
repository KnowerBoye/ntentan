FROM node:20-alpine AS builder
WORKDIR /usr/src/ntentan-api
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /usr/src/ntentan-api
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /usr/src/ntentan-api/dist ./dist
COPY --from=builder /usr/src/ntentan-api/portal ./portal
# Pre-baked Twi scanner guidance (translate+TTS output), loaded from cwd at runtime.
COPY --from=builder /usr/src/ntentan-api/assets ./assets

# Set environment variables
ENV FIREBASE_CREDENTIALS=/usr/src/ntentan-api/secrets/firebase-cred.json \
    NODE_ENV=PRODUCTION 

EXPOSE 8080
CMD ["npm", "start"]