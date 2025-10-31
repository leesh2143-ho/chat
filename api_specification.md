/*
아래 텍스트는 마크다운(Markdown) 문서의 소스 코드입니다.
이 내용을 복사하여 VS Code에 붙여 넣은 후, 파일 이름을 'api_specification.md'로 저장하세요.
*/

const markdownSource = `
# Chat Server API 명세서 (Node.js/Express) - 상세

이 문서는 Node.js Express 서버에서 처리하는 모든 HTTP RESTful API 엔드포인트와 Socket.IO 이벤트를 구체적으로 정의합니다.

모든 API 응답은 **JSON** 형식이며, 성공 시 **HTTP 200/201**과 \`{"success": true, ...}\`를, 실패 시 **HTTP 400/404**와 \`{"success": false, "message": "..."}\`를 반환합니다.

## 1. User/Authentication Endpoints

### 1.1. 닉네임 자동 생성 (GET)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/user/generate-nickname\` | \`GET\` | **없음** | 

| **상태** | **필드** | **타입** | **설명** | **예시** | 
| :--- | :--- | :--- | :--- | :--- | 
| **200 OK** | \`success\` | boolean | 성공 여부 (true) | \`true\` | 
|  | \`nickname\` | string | 서버가 생성한 고유 닉네임 | \`"user-7541"\` | 

## 2. Room Management Endpoints

### 2.1. Room 목록 조회 (GET)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/room/list\` | \`GET\` | **없음** | 

| **상태** | **필드** | **타입** | **설명** | 
| :--- | :--- | :--- | :--- | 
| **200 OK** | \`success\` | boolean | 성공 여부 (true) | 
|  | \`rooms\` | Array | Room 객체들의 배열 (비어있을 수 있음) | 
| **Room 객체** | \`roomId\` | string | Room의 고유 ID | 
|  | \`name\` | string | Room의 이름 | 
|  | \`userCount\` | number | 현재 Room에 접속 중인 사용자 수 | 

### 2.2. Room 생성 (POST)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/room/create\` | \`POST\` | \`{"roomName": string, "creatorNickname": string}\` | 

| **상태** | **필드** | **타입** | **설명** | 
| :--- | :--- | :--- | :--- | 
| **201 Created** | \`success\` | boolean | 성공 여부 (true) | 
|  | \`room\` | object | 생성된 Room 정보 | 
|  | \`room.roomId\` | string | 생성된 Room의 고유 ID | 
| **400 Bad Request** | \`message\` | string | 필수 필드 누락 오류 메시지 | 

### 2.3. Room 삭제 (DELETE)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/room/delete/:roomId\` | \`DELETE\` | **없음** | 

| **상태** | **필드** | **타입** | **설명** | 
| :--- | :--- | :--- | :--- | 
| **200 OK** | \`success\` | boolean | 성공 여부 (true) | 
|  | \`message\` | string | "Room deleted successfully." | 
| **404 Not Found** | \`message\` | string | Room을 찾을 수 없는 경우 | 

## 3. Room Interaction Endpoints

### 3.1. Room 입장 (POST)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/room/join\` | \`POST\` | \`{"nickname": string, "roomId": string, "socketId": string}\` | 

| **상태** | **필드** | **타입** | **설명** | **비고** | 
| :--- | :--- | :--- | :--- | :--- | 
| **200 OK** | \`success\` | boolean | 성공 여부 (true) | \- | 
|  | \`message\` | string | "Joined room successfully." | \- | 
| **400 Bad Request** | \`message\` | string | 필수 필드 누락 오류 메시지 | \- | 
| **404 Not Found** | \`message\` | string | \`socketId\`에 해당하는 소켓을 찾을 수 없는 경우 | \- | 
| **로직** | \- | \- | \- | **RoomID가 존재하지 않으면 자동으로 Room 생성** 후 입장 처리. | 

### 3.2. Room 퇴장 (POST)

| **필드** | **URI** | **Method** | **요청 본문** | 
| :--- | :--- | :--- | :--- | 
| **명세** | \`/api/room/leave\` | \`POST\` | \`{"nickname": string, "roomId": string, "socketId": string}\` | 

| **상태** | **필드** | **타입** | **설명** | **비고** | 
| :--- | :--- | :--- | :--- | :--- | 
| **200 OK** | \`success\` | boolean | 성공 여부 (true) | \- | 
|  | \`message\` | string | "Left room successfully." | \- | 
| **400 Bad Request** | \`message\` | string | 필수 필드 누락 오류 메시지 | \- | 
| **로직** | \- | \- | \- | 퇴장 처리 후, Room에 남은 사용자 0명 시 자동 삭제. | 

## 4. Socket.IO 이벤트 명세 (Real-Time Communication)

### 4.1. Client -> Server (Emit)

| **이벤트 이름** | **역할** | **데이터 구조 (Payload)** | **비고** | 
| :--- | :--- | :--- | :--- | 
| \`chatMessage\` | 현재 Room에 채팅 메시지 전송 | \`{"roomId": string, "nickname": string, "message": string}\` | \`message\`는 텍스트 내용입니다. | 

### 4.2. Server -> Client (On)

| **이벤트 이름** | **역할** | **데이터 구조 (Payload)** | **비고** | 
| :--- | :--- | :--- | :--- | 
| \`messageReceived\` | 새로운 채팅 또는 시스템 메시지 수신 | **Message Object** 참조 | **type:** \`chat\` (사용자 대화) 또는 \`system\` (입장/퇴장 알림) | 
| \`messageHistory\` | Room 입장 시 최근 50개 대화 기록 수신 | \`Array<Message Object>\` | \`/api/room/join\` 성공 후 해당 클라이언트에게만 전송. | 
| \`roomCreated\` | 서버에 새로운 Room이 생성됨 | \`{"roomId": string, "name": string, "userCount": number}\` | 모든 연결된 클라이언트에게 전송됩니다. | 
| \`roomDeleted\` | Room이 삭제됨 | \`{"roomId": string}\` | 모든 연결된 클라이언트에게 전송됩니다. | 

### Message Object 구조

| **필드** | **타입** | **설명** | **예시 값** | 
| :--- | :--- | :--- | :--- | 
| \`type\` | string | 메시지 유형 (\`chat\` 또는 \`system\`) | \`"chat"\` | 
| \`roomId\` | string | 메시지가 속한 Room ID | \`"room-1234"\` | 
| \`sender\` | string | 발신자 닉네임 (\`system\` 메시지일 경우 "System") | \`"user-7541"\` | 
| \`text\` | string | 메시지 내용 | \`"안녕하세요!"\` | 
| \`ts\` | string | 메시지 생성 시각 (ISO8601 형식) | \`"2025-10-31T00:00:00.000Z"\` | 
\`;

console.log(markdownSource);
`;
