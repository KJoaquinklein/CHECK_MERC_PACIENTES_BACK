# Imagen de producción de la API. Las migraciones NO corren al arrancar: se ejecutan como un
# paso aparte del despliegue (npm run migrar:prod) con el rol hc_migrator.

# --- Etapa 1: compilar TypeScript ---
FROM node:22-slim AS construccion
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- Etapa 2: imagen final, solo con dependencias de producción ---
FROM node:22-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=construccion /app/dist ./dist

# No se ejecuta como root
USER node
EXPOSE 3000

# GET /salud comprueba que el proceso responde (no consulta la base a propósito)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.API_PREFIX||'')+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
