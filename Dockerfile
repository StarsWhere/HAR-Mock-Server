FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV HAR_PATHS=/app/history.har

EXPOSE 3000

CMD ["npm", "start"]
