FROM nginx:alpine

# Static single-file control panel — nginx's default config already
# serves /usr/share/nginx/html on port 80, so no custom nginx.conf needed.
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80
