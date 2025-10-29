const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

// --- 1. 서버 환경 및 설정 ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // 연결 유지 (하트비트) 설정
    pingInterval: 10000, // 10초마다 핑 전송
    pingTimeout: 5000,   // 5초 동안 퐁 응답이 없으면 연결 해제
});

app.use(express.json()); // JSON 요청 본문 파싱을 위한 미들웨어

// --- I. 핵심 데이터 구조 (서버 메모리 관리) ---
const rooms = {};
/*
rooms 데이터 구조 예시:
{
    'roomId-123': {
        roomId: 'roomId-123',
        name: 'My First Room',
        history: [], // { type, roomId, sender, text, ts }
        users: {
            'user-abcd': { nickname: 'user-abcd', socketId: '...' }
        }
    }
}
*/
const connectedUsers = {};
/*
connectedUsers 데이터 구조 예시:
{
    'user-abcd': {
        socketId: 'socketId-xyz',
        currentRoomId: 'roomId-123'
    }
}
*/

const MAX_HISTORY_LENGTH = 50;

// --- 공통 메시지 처리 함수 ---
/**
 * 메시지를 생성하고 Room 기록에 저장한 후, 해당 Room의 모든 클라이언트에게 전파합니다.
 * @param {string} type - 'chat' 또는 'system'
 * @param {string} roomId - 메시지가 속한 Room ID
 * @param {string} sender - 메시지 발신자 닉네임 ('System' for system messages)
 * @param {string} text - 메시지 내용
 */
function handleMessage(type, roomId, sender, text) {
    const room = rooms[roomId];
    if (!room) return;

    const message = {
        type,
        roomId,
        sender,
        text,
        ts: new Date().toISOString()
    };

    // 1. history에 메시지 추가 및 50개 제한 유지
    room.history.push(message);
    if (room.history.length > MAX_HISTORY_LENGTH) {
        room.history.shift();
    }

    // 2. 해당 Room의 모든 클라이언트에게 메시지 브로드캐스팅
    io.to(roomId).emit('messageReceived', message);
    console.log(`[Message Handled] Room: ${roomId}, Type: ${type}, Sender: ${sender}, Text: ${text}`);
}


// --- II. API (HTTP Endpoints) 구현 상세 ---

// 1. 익명 닉네임 자동 부여
app.get('/api/user/generate-nickname', (req, res) => {
    let nickname;
    do {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        nickname = `user-${randomNum}`;
    } while (connectedUsers[nickname]); // 중복되지 않을 때까지 반복

    res.json({ success: true, nickname });
});

// 2. Room 관리 기능
// Room 생성
app.post('/api/room/create', (req, res) => {
    const { roomName, creatorNickname } = req.body;
    if (!roomName || !creatorNickname) {
        return res.status(400).json({ success: false, message: 'roomName and creatorNickname are required.' });
    }

    const roomId = `room-${crypto.randomUUID()}`;
    const newRoom = {
        roomId,
        name: roomName,
        history: [],
        users: {},
    };
    rooms[roomId] = newRoom;

    const roomInfo = {
        roomId: newRoom.roomId,
        name: newRoom.name,
        userCount: Object.keys(newRoom.users).length,
    };

    // 모든 클라이언트에게 Room 생성 전파
    io.emit('roomCreated', roomInfo);

    console.log(`[Room Created] ID: ${roomId}, Name: ${roomName}, Creator: ${creatorNickname}`);
    res.status(201).json({ success: true, room: roomInfo });
});

// Room 목록 조회
app.get('/api/room/list', (req, res) => {
    const roomList = Object.values(rooms).map(room => ({
        roomId: room.roomId,
        name: room.name,
        userCount: Object.keys(room.users).length,
    }));
    res.json({ success: true, rooms: roomList });
});

// Room 삭제
app.delete('/api/room/delete/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    // 해당 Room에 있던 사용자들의 상태 업데이트
    Object.values(room.users).forEach(user => {
        const connectedUser = connectedUsers[user.nickname];
        if (connectedUser) {
            connectedUser.currentRoomId = null;
        }
    });

    delete rooms[roomId];

    // 모든 클라이언트에게 Room 삭제 전파
    io.emit('roomDeleted', { roomId });

    console.log(`[Room Deleted] ID: ${roomId}`);
    res.json({ success: true, message: 'Room deleted successfully.' });
});

// 3. Room 입장 및 퇴장 처리
// Room 입장
app.post('/api/room/join', (req, res) => {
    const { nickname, roomId, socketId } = req.body;
    if (!nickname || !roomId || !socketId) {
        return res.status(400).json({ success: false, message: 'nickname, roomId, and socketId are required.' });
    }

    // 미존재 Room 처리: 새로운 Room 즉시 생성
    if (!rooms[roomId]) {
        console.log(`[Room Auto-Created] Room ${roomId} does not exist. Creating it.`);
        rooms[roomId] = {
            roomId,
            name: `Room ${roomId}`, // 임시 이름 부여
            history: [],
            users: {},
        };
        // 새 Room 생성 사실을 모든 클라이언트에게 전파
        io.emit('roomCreated', {
            roomId,
            name: rooms[roomId].name,
            userCount: 0
        });
    }

    const room = rooms[roomId];
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
        return res.status(404).json({ success: false, message: 'Socket not found.' });
    }

    // 데이터 관리: 사용자 정보 추가 및 상태 업데이트
    room.users[nickname] = { nickname, socketId };
    connectedUsers[nickname] = { socketId, currentRoomId: roomId };
    socket.join(roomId);

    // 전파 (순차적)
    // 1. 시스템 메시지 전파 (입장)
    handleMessage('system', roomId, 'System', `${nickname} has joined the room.`);

    // 2. 기록 전달 (새로 입장한 클라이언트에게만)
    socket.emit('messageHistory', room.history);

    console.log(`[User Joined] Nickname: ${nickname}, Room: ${roomId}`);
    res.json({ success: true, message: 'Joined room successfully.' });
});

// Room 퇴장
app.post('/api/room/leave', (req, res) => {
    const { nickname, roomId, socketId } = req.body;
    if (!nickname || !roomId || !socketId) {
        return res.status(400).json({ success: false, message: 'nickname, roomId, and socketId are required.' });
    }

    handleLeaveRoom(nickname, roomId, socketId);

    res.json({ success: true, message: 'Left room successfully.' });
});

/**
 * 사용자를 Room에서 퇴장시키는 로직을 처리하는 헬퍼 함수
 * @param {string} nickname
 * @param {string} roomId
 * @param {string} socketId
 */
function handleLeaveRoom(nickname, roomId, socketId) {
    const room = rooms[roomId];
    const socket = io.sockets.sockets.get(socketId);

    if (room && room.users[nickname]) {
        // 시스템 메시지 전파 (퇴장)
        handleMessage('system', roomId, 'System', `${nickname} has left the room.`);

        // 데이터 관리
        delete room.users[nickname];
        if (connectedUsers[nickname]) {
            connectedUsers[nickname].currentRoomId = null;
        }

        if (socket) {
            socket.leave(roomId);
        }

        console.log(`[User Left] Nickname: ${nickname}, Room: ${roomId}`);

        // Room 자동 삭제: 참여자가 0명이 되면 Room 삭제
        if (Object.keys(room.users).length === 0) {
            delete rooms[roomId];
            io.emit('roomDeleted', { roomId });
            console.log(`[Room Auto-Deleted] Room ${roomId} is now empty and has been deleted.`);
        }
    }
}


// --- III. WebSocket (Socket.IO) 구현 상세 ---

io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // 2. 메시지 처리 및 저장
    socket.on('chatMessage', ({ roomId, nickname, message }) => {
        if (!roomId || !nickname || !message) {
            // 필수 정보가 누락된 경우 처리하지 않음
            console.error(`[chatMessage Error] Invalid payload: roomId, nickname, and message are required.`);
            return;
        }
        handleMessage('chat', roomId, nickname, message);
    });

    // 1. 연결 해제 (disconnect) 처리
    socket.on('disconnect', () => {
        console.log(`[Socket Disconnected] ID: ${socket.id}`);
        // 연결이 끊어진 소켓에 해당하는 사용자 찾기
        const userEntry = Object.entries(connectedUsers).find(
            ([, userData]) => userData.socketId === socket.id
        );

        if (userEntry) {
            const [nickname, userData] = userEntry;
            const { currentRoomId } = userData;

            if (currentRoomId && rooms[currentRoomId]) {
                // 사용자가 Room에 있었다면 퇴장 처리
                handleLeaveRoom(nickname, currentRoomId, socket.id);
            }

            // connectedUsers 목록에서 사용자 삭제
            delete connectedUsers[nickname];
        }
    });
});


// --- IV. 클라이언트 테스트 환경 ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat Server Test Client</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; }
                .container { display: flex; gap: 20px; }
                .panel { border: 1px solid #ccc; padding: 15px; border-radius: 5px; }
                #api-panel { flex: 1; }
                #chat-panel { flex: 2; }
                #log { white-space: pre-wrap; word-wrap: break-word; }
                .log-entry { border-bottom: 1px solid #eee; padding: 5px 0; }
            </style>
        </head>
        <body>
            <h1>Chat Server Test Client</h1>
            <div class="container">
                <div id="api-panel" class="panel">
                    <h2>API Tests</h2>
                    <div>
                        <button id="generateNickname">1. Generate Nickname</button>
                        <p>Nickname: <b id="nickname-display"></b></p>
                    </div>
                    <hr>
                    <div>
                        <input type="text" id="roomName" placeholder="Room Name">
                        <button id="createRoom">2. Create Room</button>
                    </div>
                    <hr>
                    <div>
                        <button id="getRoomList">3. Get Room List</button>
                        <ul id="room-list"></ul>
                    </div>
                </div>
                <div id="chat-panel" class="panel">
                    <h2>Chat Area</h2>
                    <div id="join-area">
                        <input type="text" id="roomIdToJoin" placeholder="Room ID to Join">
                        <button id="joinRoom">4. Join Room</button>
                    </div>
                    <div id="chat-area" style="display: none;">
                        <h3 id="current-room-display"></h3>
                        <div id="messages" style="height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; margin-bottom: 10px;"></div>
                        <input type="text" id="messageInput" placeholder="Enter message">
                        <button id="sendMessage">Send</button>
                        <button id="leaveRoom">Leave Room</button>
                    </div>
                </div>
            </div>
            <h2>Event Log</h2>
            <div id="log" class="panel" style="background-color: #f0f0f0;"></div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                let myNickname = '';
                let myRoomId = '';
                let mySocketId = '';

                const log = document.getElementById('log');
                const nicknameDisplay = document.getElementById('nickname-display');
                const roomList = document.getElementById('room-list');

                // --- Helper ---
                function logEvent(eventName, data) {
                    const entry = document.createElement('div');
                    entry.className = 'log-entry';
                    entry.innerHTML = \`<b>[\${new Date().toLocaleTimeString()}] \${eventName}</b>: \${JSON.stringify(data)}\`;
                    log.prepend(entry);
                }

                // --- Socket.IO Listeners ---
                socket.on('connect', () => {
                    mySocketId = socket.id;
                    logEvent('Socket Connected', { socketId: mySocketId });
                });
                socket.on('roomCreated', (data) => logEvent('roomCreated', data));
                socket.on('roomDeleted', (data) => logEvent('roomDeleted', data));
                socket.on('messageReceived', (data) => {
                    logEvent('messageReceived', data);
                    const msgDiv = document.createElement('div');
                    msgDiv.textContent = \`[\${new Date(data.ts).toLocaleTimeString()}] \${data.sender}: \${data.text}\`;
                    document.getElementById('messages').appendChild(msgDiv);
                });
                socket.on('messageHistory', (data) => {
                    logEvent('messageHistory', data);
                    const messagesDiv = document.getElementById('messages');
                    messagesDiv.innerHTML = '';
                    data.forEach(msg => {
                        const msgDiv = document.createElement('div');
                        msgDiv.textContent = \`[\${new Date(msg.ts).toLocaleTimeString()}] \${msg.sender}: \${msg.text}\`;
                        messagesDiv.appendChild(msgDiv);
                    });
                });

                // --- API Actions ---
                document.getElementById('generateNickname').onclick = async () => {
                    const res = await fetch('/api/user/generate-nickname');
                    const data = await res.json();
                    if (data.success) {
                        myNickname = data.nickname;
                        nicknameDisplay.textContent = myNickname;
                        logEvent('API: generate-nickname', data);
                    }
                };

                document.getElementById('createRoom').onclick = async () => {
                    if (!myNickname) { alert('Please generate a nickname first.'); return; }
                    const roomName = document.getElementById('roomName').value;
                    const res = await fetch('/api/room/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ roomName, creatorNickname: myNickname })
                    });
                    logEvent('API: create-room', await res.json());
                    document.getElementById('getRoomList').click(); // Refresh list
                };

                document.getElementById('getRoomList').onclick = async () => {
                    const res = await fetch('/api/room/list');
                    const data = await res.json();
                    logEvent('API: get-room-list', data);
                    roomList.innerHTML = '';
                    data.rooms.forEach(room => {
                        const li = document.createElement('li');
                        li.textContent = \`\${room.name} (ID: \${room.roomId}) - \${room.userCount} users\`;
                        roomList.appendChild(li);
                    });
                };

                document.getElementById('joinRoom').onclick = async () => {
                    if (!myNickname || !mySocketId) { alert('Please generate a nickname first.'); return; }
                    myRoomId = document.getElementById('roomIdToJoin').value;
                    if (!myRoomId) { alert('Please enter a Room ID.'); return; }

                    const res = await fetch('/api/room/join', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nickname: myNickname, roomId: myRoomId, socketId: mySocketId })
                    });
                    logEvent('API: join-room', await res.json());

                    document.getElementById('join-area').style.display = 'none';
                    document.getElementById('chat-area').style.display = 'block';
                    document.getElementById('current-room-display').textContent = \`In Room: \${myRoomId}\`;
                };

                document.getElementById('sendMessage').onclick = () => {
                    const message = document.getElementById('messageInput').value;
                    if (message) {
                        socket.emit('chatMessage', { roomId: myRoomId, nickname: myNickname, message });
                        logEvent('Socket Emit: chatMessage', { message });
                        document.getElementById('messageInput').value = '';
                    }
                };

                document.getElementById('leaveRoom').onclick = async () => {
                    const res = await fetch('/api/room/leave', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nickname: myNickname, roomId: myRoomId, socketId: mySocketId })
                    });
                    logEvent('API: leave-room', await res.json());

                    document.getElementById('join-area').style.display = 'block';
                    document.getElementById('chat-area').style.display = 'none';
                    document.getElementById('messages').innerHTML = '';
                    myRoomId = '';
                };

                // Initial load
                document.getElementById('getRoomList').click();
            </script>
        </body>
        </html>
    `);
});

// --- 서버 실행 ---
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
