FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY site/ ./site/

EXPOSE 3000

USER node

CMD ["npm", "start"]
