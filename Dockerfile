# Use Playwright image with browsers installed
FROM mcr.microsoft.com/playwright:latest
WORKDIR /app
COPY package.json package-lock.json* /app/
RUN npm ci --unsafe-perm
COPY . /app
ENV PORT 3000
EXPOSE 3000
CMD ["node", "index.js"]
