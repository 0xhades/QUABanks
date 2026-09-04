FROM --platform=linux/amd64 oven/bun:1.2.21-debian AS javascript

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./package.json
COPY editor/package.json editor/bun.lock ./editor/
RUN bun install --cwd editor --frozen-lockfile

COPY pyproject.toml uv.lock ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir arabic-reshaper pypdf python-bidi reportlab

COPY render_template.py build_editable_pptx.mjs sample_packet.json ./
COPY assets ./assets
COPY schema ./schema
COPY container ./container

ENV PATH="/opt/venv/bin:${PATH}"
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "container/server.ts"]
