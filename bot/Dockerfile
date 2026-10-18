FROM node:22-alpine
WORKDIR /app/bot
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev
COPY bot/ ./
COPY README.md /app/README.md
ENV README_PATH=/app/README.md DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "src/main.js"]
