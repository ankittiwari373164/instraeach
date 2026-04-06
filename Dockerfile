FROM node:20-slim

# Install Python + pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set python3 as default python
RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Install Node dependencies
COPY package.json ./
RUN npm install

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages || \
    pip3 install --no-cache-dir -r requirements.txt

# Copy all project files
COPY . .

# Create data and sessions directories (persistent via Railway volume)
RUN mkdir -p data data/sessions

EXPOSE 3000

CMD ["node", "api/server.js"]
