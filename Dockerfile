FROM python:3.14-slim

LABEL org.opencontainers.image.title="Typestash" \
      org.opencontainers.image.description="Self-hosted font library: preview, search, organise and download your fonts" \
      org.opencontainers.image.source="https://github.com/jatinkrmalik/typestash" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TYPESTASH_FONTS=/fonts \
    TYPESTASH_DATA=/data \
    TYPESTASH_PORT=8080

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && mkdir -p /fonts /data

COPY app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('TYPESTASH_PORT', '8080')}/healthz\", timeout=3)"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "/app/server.py"]
