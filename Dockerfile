FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY funding-bot.js ./
ENV NODE_ENV=production
EXPOSE 3505
CMD ["node", "funding-bot.js"]
