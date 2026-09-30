FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY sqlite-store.js ./
COPY tbank-ca-bundle.pem ./

# Amvera's network certificate chain requires this CA bundle for T-Bank.
ENV NODE_EXTRA_CA_CERTS=/app/tbank-ca-bundle.pem

EXPOSE 3000

CMD ["node", "server.js"]
