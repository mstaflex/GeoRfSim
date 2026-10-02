# GeoRfSim is a purely static web app: all models run in the browser, there is
# no backend, no build step and no runtime dependency. The container only runs
# nginx - without root, on port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="GeoRfSim" \
      org.opencontainers.image.description="3-D drone radio-link simulator with established propagation and fading models" \
      org.opencontainers.image.licenses="MIT"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY app/ /usr/share/nginx/html/

# The base image already sets USER 101 - repeated here for clarity.
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
