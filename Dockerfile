FROM node:22-bookworm-slim

WORKDIR /app

# Install Docker CLI + AWS CLI dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        docker.io \
        awscli \
    && rm -rf /var/lib/apt/lists/*

# Enable Yarn
RUN corepack enable

# Copy dependencies
COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

# Copy application
COPY . .

ENV NODE_ENV=production
ENV PORT=3001
ENV DOCKER_BIN=/usr/bin/docker
ENV AWS_BIN=/usr/bin/aws

EXPOSE 3001

CMD ["yarn", "start"]
