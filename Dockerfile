FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY funding-bot.js ./
ENV NODE_ENV=production
CMD ["node", "funding-bot.js"]
