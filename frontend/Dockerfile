FROM node:24-alpine AS build
WORKDIR /app
ARG VITE_PUBLIC_ORIGIN=http://localhost:8090
ENV VITE_PUBLIC_ORIGIN=$VITE_PUBLIC_ORIGIN
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
