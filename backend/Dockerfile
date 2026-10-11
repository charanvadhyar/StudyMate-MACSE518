# StudyMate API for Railway. Start command applies the schema (idempotent) and then serves.
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 4000
CMD ["sh", "-c", "node src/db/setupSchema.js && node src/server.js"]
