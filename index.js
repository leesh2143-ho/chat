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
        <html lang="ko">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Real-Time Chat</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; margin: 0; background-color: #f4f4f8; }
                .app-container { max-width: 800px; margin: auto; background-color: #fff; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
                .header { padding: 15px; background-color: #4a90e2; color: white; display: flex; justify-content: space-between; align-items: center; }
                .view { padding: 20px; }
                #chat-view { display: none; }
                .room-list-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #eee; }
                .room-list-item:hover { background-color: #f9f9f9; }
                .join-btn { padding: 5px 10px; border: none; background-color: #4a90e2; color: white; cursor: pointer; border-radius: 3px; }
                .create-room-form { display: flex; gap: 10px; margin-top: 20px; }
                .create-room-form input { flex-grow: 1; padding: 10px; border: 1px solid #ddd; }
                .create-room-form button { padding: 10px 15px; border: none; background-color: #34a853; color: white; cursor: pointer; }
                #messages { height: 400px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; margin-bottom: 10px; background-color: #fafafa; }
                .message { padding: 8px 12px; border-radius: 18px; margin-bottom: 10px; max-width: 70%; word-wrap: break-word; }
                .my-message { background-color: #4a90e2; color: white; align-self: flex-end; text-align: right; }
                .other-message { background-color: #e9e9eb; color: #333; align-self: flex-start; text-align: left; }
                .system-message { color: #888; font-style: italic; text-align: center; width: 100%; }
                #message-form { display: flex; gap: 10px; }
                #message-form textarea { flex-grow: 1; padding: 10px; border: 1px solid #ddd; resize: none; }
                #message-form button { padding: 10px 20px; border: none; background-color: #4a90e2; color: white; cursor: pointer; }
                #chat-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="app-container">
                <div class="header">
                    <div><b id="nickname-display"></b></div>
                    <div>Connection: <b id="connection-status">Disconnected</b></div>
                </div>

                <!-- Room List View -->
                <div id="room-list-view" class="view">
                    <h2>Available Chat Rooms</h2>
                    <div id="room-list"></div>
                    <div class="create-room-form">
                        <input type="text" id="new-room-name" placeholder="Enter new room name">
                        <button id="create-room-btn">Create Room</button>
                    </div>
                </div>

                <!-- Chat View -->
                <div id="chat-view" class="view">
                    <div id="chat-header">
                        <h2 id="room-title"></h2>
                        <button id="leave-room-btn">Leave</button>
                    </div>
                    <div id="messages"></div>
                    <form id="message-form">
                        <textarea id="message-input" placeholder="Type a message..."></textarea>
                        <button type="submit">Send</button>
                    </form>
                </div>
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                // --- Global State ---
                let myNickname = '';
                let mySocketId = '';
                let currentRoomId = null;
                let roomListInterval = null;

                // --- DOM Elements ---
                const nicknameDisplay = document.getElementById('nickname-display');
                const connectionStatus = document.getElementById('connection-status');
                const roomListView = document.getElementById('room-list-view');
                const chatView = document.getElementById('chat-view');
                const roomListDiv = document.getElementById('room-list');
                const createRoomBtn = document.getElementById('create-room-btn');
                const newRoomNameInput = document.getElementById('new-room-name');
                const roomTitle = document.getElementById('room-title');
                const messagesDiv = document.getElementById('messages');
                const messageForm = document.getElementById('message-form');
                const messageInput = document.getElementById('message-input');
                const leaveRoomBtn = document.getElementById('leave-room-btn');

                // --- Socket.IO Client Setup ---
                const socket = io({
                    reconnectionAttempts: 2,
                    reconnectionDelay: 10000
                });

                // --- Helper Functions ---
                const api = {
                    get: (url) => fetch(url).then(res => res.json()),
                    post: (url, body) => fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    }).then(res => res.json())
                };

                function switchView(viewName) {
                    if (viewName === 'chat') {
                        roomListView.style.display = 'none';
                        chatView.style.display = 'block';
                        clearInterval(roomListInterval);
                    } else {
                        roomListView.style.display = 'block';
                        chatView.style.display = 'none';
                        startRoomListPolling();
                    }
                }

                function addMessageToUI(msg) {
                    const msgElement = document.createElement('div');
                    msgElement.classList.add('message');
                    if (msg.type === 'system' || msg.sender === 'System') {
                        msgElement.classList.add('system-message');
                        msgElement.textContent = \`[\${new Date(msg.ts).toLocaleTimeString()}] \${msg.text}\`;
                    } else {
                        msgElement.classList.add(msg.sender === myNickname ? 'my-message' : 'other-message');
                        msgElement.innerHTML = \`<b>\${msg.sender}</b><br>\${msg.text}<br><small style="opacity: 0.7;">\${new Date(msg.ts).toLocaleTimeString()}</small>\`;
                    }
                    messagesDiv.appendChild(msgElement);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }

                // --- Core Logic Functions ---
                async function initializeApp() {
                    try {
                        const { success, nickname } = await api.get('/api/user/generate-nickname');
                        if (success) {
                            myNickname = nickname;
                            nicknameDisplay.textContent = \`Nickname: \${myNickname}\`;
                        }
                    } catch (error) {
                        console.error('Failed to generate nickname:', error);
                        nicknameDisplay.textContent = 'Could not get nickname';
                    }
                    switchView('list');
                }

                async function updateRoomList() {
                    try {
                        const { success, rooms } = await api.get('/api/room/list');
                        if (success) {
                            roomListDiv.innerHTML = '';
                            if (rooms.length === 0) {
                                roomListDiv.innerHTML = '<p>No rooms available. Create one!</p>';
                            } else {
                                rooms.forEach(room => {
                                    const roomItem = document.createElement('div');
                                    roomItem.className = 'room-list-item';
                                    roomItem.innerHTML = \`
                                        <div>
                                            <b>\${room.name}</b> (ID: \${room.roomId})
                                            <br>
                                            <small>\${room.userCount} user(s)</small>
                                        </div>
                                        <button class="join-btn" data-room-id="\${room.roomId}" data-room-name="\${room.name}">Join</button>
                                    \`;
                                    roomListDiv.appendChild(roomItem);
                                });
                            }
                        }
                    } catch(e) {
                        console.error("Could not update room list", e);
                        roomListDiv.innerHTML = '<p>Error fetching room list.</p>';
                    }
                }

                function startRoomListPolling() {
                    updateRoomList();
                    if(roomListInterval) clearInterval(roomListInterval);
                    roomListInterval = setInterval(updateRoomList, 5000);
                }

                async function handleJoinRoom(roomId, roomName) {
                    if (!myNickname || !mySocketId) return alert('Cannot join room: nickname or socket connection not ready.');
                    try {
                        const { success, message } = await api.post('/api/room/join', { nickname: myNickname, roomId, socketId: mySocketId });
                        if (success) {
                            currentRoomId = roomId;
                            roomTitle.textContent = roomName;
                            messagesDiv.innerHTML = ''; // Clear previous messages
                            switchView('chat');
                        } else {
                            alert(\`Failed to join room: \${message}\`);
                        }
                    } catch (e) {
                        alert('Error joining room.');
                    }
                }

                // --- Event Handlers ---
                createRoomBtn.addEventListener('click', async () => {
                    const roomName = newRoomNameInput.value.trim();
                    if (!roomName) return alert('Please enter a room name.');
                    if (!myNickname) return alert('Cannot create room: nickname not generated.');

                    try {
                        const { success, room } = await api.post('/api/room/create', { roomName, creatorNickname: myNickname });
                        if (success) {
                            newRoomNameInput.value = '';
                            await handleJoinRoom(room.roomId, room.name);
                        } else {
                            alert('Failed to create room.');
                        }
                    } catch (e) {
                        alert('Error creating room.');
                    }
                });

                roomListDiv.addEventListener('click', (e) => {
                    if (e.target.classList.contains('join-btn')) {
                        const roomId = e.target.dataset.roomId;
                        const roomName = e.target.dataset.roomName;
                        handleJoinRoom(roomId, roomName);
                    }
                });

                leaveRoomBtn.addEventListener('click', async () => {
                    if (!currentRoomId) return;
                    try {
                        await api.post('/api/room/leave', { nickname: myNickname, roomId: currentRoomId, socketId: mySocketId });
                    } catch(e) {
                         console.error("Error leaving room:", e);
                    } finally {
                        currentRoomId = null;
                        switchView('list');
                    }
                });

                messageForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    const message = messageInput.value.trim();
                    if (message && currentRoomId) {
                        socket.emit('chatMessage', { roomId: currentRoomId, nickname: myNickname, message });
                        messageInput.value = '';
                    }
                });

                messageInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        messageForm.requestSubmit();
                    }
                });

                // --- Socket.IO Event Listeners ---
                socket.on('connect', () => {
                    mySocketId = socket.id;
                    connectionStatus.textContent = 'Connected';
                    connectionStatus.style.color = '#34a853';
                });

                socket.on('disconnect', () => {
                    connectionStatus.textContent = 'Disconnected';
                    connectionStatus.style.color = '#ea4335';
                });

                socket.on('reconnect_failed', async () => {
                    alert('Failed to reconnect to the server. Attempting to rejoin the last room.');
                    if (currentRoomId) {
                        try {
                            // Re-fetch nickname just in case, then rejoin
                            await initializeApp();
                            await handleJoinRoom(currentRoomId, roomTitle.textContent);
                            alert('Successfully rejoined the room.');
                        } catch (e) {
                            alert('Could not rejoin the room. Please refresh the page.');
                            switchView('list');
                        }
                    }
                });

                socket.on('roomCreated', () => {
                    if(roomListView.style.display !== 'none') updateRoomList();
                });
                socket.on('roomDeleted', () => {
                     if(roomListView.style.display !== 'none') updateRoomList();
                });

                socket.on('messageHistory', (history) => {
                    messagesDiv.innerHTML = '';
                    history.forEach(addMessageToUI);
                });

                socket.on('messageReceived', addMessageToUI);

                // --- Initial Load ---
                window.onload = initializeApp;
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
