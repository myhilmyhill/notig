FROM nginx:1.27-alpine

RUN apk add --no-cache git git-daemon fcgiwrap spawn-fcgi libcap 
RUN addgroup -g 1000 notig  && adduser -D -u 1000 -G notig notig \
    && setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx \
    && mkdir -p /tmp/fcgiwrap /data/repos /var/cache/nginx /var/log/nginx \
    && chown -R notig:notig /tmp/fcgiwrap /data/repos /var/cache/nginx /var/log/nginx

COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/nginx.main.conf /etc/nginx/nginx.conf
COPY nginx/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENV GIT_HTTP_EXPORT_ALL=1 \
    GIT_PROJECT_ROOT=/data/repos

VOLUME ["/data/repos"]

USER notig

CMD ["/entrypoint.sh"]
