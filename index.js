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

  // Room 입장 이벤트 핸들러
  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    const systemMessage = {
      type: 'system',
      roomId: roomId,
      sender: 'Server',
      text: `${socket.data.nickname} entered this room`,
      ts: new Date().toISOString(),
    };
    io.to(roomId).emit('systemMessage', systemMessage);
    console.log(`${socket.data.nickname} joined room: ${roomId}`);
  });

  // 채팅 메시지 이벤트 핸들러
  socket.on('chatMessage', ({ roomId, text }) => {
    const chatMessage = {
      type: 'chat',
      roomId: roomId,
      sender: socket.data.nickname,
      text: text,
      ts: new Date().toISOString(),
    };
    io.to(roomId).emit('chatMessage', chatMessage);
    console.log(`Message from ${socket.data.nickname} in room ${roomId}: ${text}`);
  });

  socket.on('disconnect', () => {
    console.log(socket.data.nickname + ' disconnected');
    // 소켓이 속한 모든 Room에 퇴장 메시지를 보냅니다.
    // socket.rooms에는 소켓 ID 자체도 포함되어 있으므로, 이를 제외하고 순회합니다.
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        const systemMessage = {
          type: 'system',
          roomId: roomId,
          sender: 'Server',
          text: `${socket.data.nickname} left the room`,
          ts: new Date().toISOString(),
        };
        io.to(roomId).emit('systemMessage', systemMessage);
        console.log(`Sent leave message to room: ${roomId}`);
      }
    }
  });
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
