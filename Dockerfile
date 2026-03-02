FROM node:20-bullseye

ENV NODE_ENV=production
WORKDIR /app

# Install system deps (python3 + pip for pptx extraction script)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install node dependencies
COPY package*.json ./
RUN npm install

# Install python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy remaining source
COPY . .

# Build prisma client
RUN npm run postinstall

# Expose default port
EXPOSE 3001

CMD ["npm", "start"]
