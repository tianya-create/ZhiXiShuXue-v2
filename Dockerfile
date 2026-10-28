FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm install && cd backend && npm install && cd ../frontend && npm install
COPY . .
RUN cd frontend && npm run build
EXPOSE 5001 5000
CMD ["npm", "run", "start"]
