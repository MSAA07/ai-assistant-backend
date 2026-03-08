FROM node:20-bullseye

ENV NODE_ENV=production
WORKDIR /app

# Install system deps (python3 + pip for pptx extraction script)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install node dependencies (copy package manifests + prisma schema for postinstall)
COPY package*.json ./
COPY prisma ./prisma
RUN npm install && npm cache clean --force

# Install python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy remaining source
COPY . .

# Build prisma client (ensure latest schema)
RUN npm run postinstall

# Expose default port
EXPOSE 3001

CMD ["sh", "-c", "if printf '%s' \"$RAILWAY_SERVICE_NAME\" | grep -qi 'worker'; then node worker.js; else npm start; fi"]
