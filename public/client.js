const socket = io();
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const roomIdInput = document.getElementById('room-id');
const joinRoomBtn = document.getElementById('join-room');
const statusDiv = document.getElementById('status');
let currentRoom = '';
let myNickname = '';

socket.on('connect', () => {
  statusDiv.textContent = 'Connected';
  statusDiv.style.backgroundColor = '#4caf50'; // Green
});

socket.on('disconnect', () => {
  statusDiv.textContent = 'Disconnected';
  statusDiv.style.backgroundColor = '#f44336'; // Red
});

socket.on('nicknameAssigned', (nickname) => {
  myNickname = nickname;
});

joinRoomBtn.addEventListener('click', () => {
  const roomId = roomIdInput.value;
  if (roomId) {
    socket.emit('joinRoom', roomId);
    currentRoom = roomId; // 현재 입장한 Room ID 저장
    roomIdInput.value = '';
    document.getElementById('room-controls').style.display = 'none'; // Room 입장 후 UI 숨김
    document.getElementById('form').style.display = 'flex';
  }
});

form.style.display = 'none'; // 초기에는 메시지 입력 폼 숨김

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // 기본 동작(줄바꿈) 방지
    const text = input.value.trim();
    if (text && currentRoom) {
      socket.emit('chatMessage', { roomId: currentRoom, text: text });
      input.value = '';
    }
  }
});

form.addEventListener('submit', function(e) {
  e.preventDefault(); // 폼의 기본 제출 동작 방지
  const text = input.value.trim();
  if (text && currentRoom) {
    socket.emit('chatMessage', { roomId: currentRoom, text: text });
    input.value = '';
  }
});

function addMessageToList(msg) {
  const item = document.createElement('li');
  if (msg.type === 'system') {
    item.className = 'system-message';
    item.textContent = `[${new Date(msg.ts).toLocaleTimeString()}] ${msg.text}`;
  } else { // 'chat'
    if (msg.sender === myNickname) {
      item.className = 'my-message';
    } else {
      item.className = 'other-message';
    }
    item.textContent = `[${new Date(msg.ts).toLocaleTimeString()}] ${msg.sender}: ${msg.text}`;
  }
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
}

socket.on('chatMessage', addMessageToList);
socket.on('systemMessage', addMessageToList);

socket.on('history', function(history) {
  messages.innerHTML = ''; // Clear the list before rendering history
  history.forEach(addMessageToList);
});
