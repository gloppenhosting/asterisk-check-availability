FROM mhart/alpine-node:5.3.0
MAINTAINER Andreas Krüger
ENV NODE_ENV production
ENV NODE_DEBUG false

RUN apk add --update nodejs

COPY /server.js /server.js
COPY /ami.js /ami.js
COPY /package.json /package.json
COPY /config /config

RUN npm install

CMD ["node", "server.js"]
