const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  // 4자리 랜덤 숫자를 생성하여 닉네임 할당
  const randomNickname = 'user-' + Math.floor(1000 + Math.random() * 9000);
  socket.data.nickname = randomNickname;
  console.log(socket.data.nickname + ' connected');

  // 메시지 이벤트 핸들러
  socket.on('message', (msg) => {
    const echoMessage = `${socket.data.nickname}: ${msg}`;
    socket.emit('message', echoMessage);
  });

  socket.on('disconnect', () => {
    console.log(socket.data.nickname + ' disconnected');
  });
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
