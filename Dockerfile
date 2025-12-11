
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
COPY package.json package-lock.json* /app/
RUN npm ci --unsafe-perm
COPY . /app
ENV PORT 3000
EXPOSE 3000
CMD ["node", "index.js"]
