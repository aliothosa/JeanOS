# ─── Fase 1: Build Angular ───────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Instalar dependencias primero (cache layer)
COPY package.json ./
RUN npm install --legacy-peer-deps

# Copiar fuentes y compilar en producción
COPY . .
RUN npm run build:prod

# ─── Fase 2: Nginx sirve los estáticos ───────────────────────────────────────
FROM docker.io/library/nginx:1.25-alpine

# Eliminar config por defecto
RUN rm -rf /usr/share/nginx/html/*

# Copiar los archivos compilados de Angular
COPY --from=builder /app/dist/jeanos-frontend /usr/share/nginx/html

# Configuración de Nginx con proxy al backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
