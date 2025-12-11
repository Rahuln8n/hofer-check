FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
# Copy package files first for better layer caching
COPY package.json package-lock.json /app/

# Faster npm install: no audit, no progress, prefer offline (speeds up installs)
RUN npm ci --unsafe-perm --no-audit --no-fund --no-progress --prefer-offline

# Copy the rest of the app
COPY . /app

ENV PORT 3000
EXPOSE 3000

CMD ["node", "index.js"]
