# Local npm startup remains the default; these images are an optional deployment.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY . .
RUN npm ci
ENV NODE_ENV=production

FROM dependencies AS control
# Paper 1.18.1 requires Java 17. Compiler tools install the viewer plugin.
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/goal-training \
    && /opt/goal-training/bin/python -m pip install --no-cache-dir -r scripts/learning/requirements.txt --index-url https://download.pytorch.org/whl/cpu
ENV PYTHON_PATH=/opt/goal-training/bin/python
ENV CONTROL_HOST=0.0.0.0 DATA_DIR=/data ARTIFACT_DIR=/artifacts SERVER_DIR=/server JAVA_PATH=java
EXPOSE 4100 25565
CMD ["node", "--import", "tsx", "apps/control/src/index.ts"]

FROM dependencies AS dashboard
RUN npm run build -w @mlcraft/dashboard
ENV DASHBOARD_HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "--import", "tsx", "scripts/dashboard.ts", "start"]

# Optional renderer runtime. Prepare assets on this Linux host; CPU Mesa is a
# functional fallback, while larger fleets need GPU drivers and benchmarks.
FROM control AS control-render
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth libgl1 libgl1-mesa-dri libx11-6 libxcursor1 libxrandr2 libxinerama1 libxi6 libasound2 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*
ENV MAX_RENDER_CLIENTS=2
CMD ["xvfb-run", "-a", "-s", "-screen 0 1024x768x24", "node", "--import", "tsx", "apps/control/src/index.ts"]
