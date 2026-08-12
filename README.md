# 수업 의견판 V7 — GitHub Pages + Firebase Realtime Database

V6의 핵심 기능을 GitHub Pages + Firebase 기반으로 옮긴 버전입니다.

## V7 핵심 변화

- 학생 화면 5초 polling 제거
- 질문이 바뀔 때만 Firebase Realtime Database 이벤트로 즉시 갱신
- 교사 화면도 학생 응답을 실시간 이벤트로 수신
- 학생은 로그인 화면/Google 권한 요청 없이 자동 익명 인증
- 교사가 `수업 종료`를 누르면 해당 수업 학생 페이지가 즉시 `goOffline()`으로 연결 종료
- 학생 페이지가 백그라운드로 5분 이상 가면 연결 자동 종료, 다시 돌아오면 **같은 sessionId일 때만** 재연결
- 교사가 종료를 깜빡한 경우를 대비해 학생 연결 90분 안전 종료
- 1반~9반 선택
- 자유 의견 / 찬반 / 객관식 / 5점 척도
- 선택 이유/추가 의견
- 현재 응답 실시간 집계
- 발표 모드
- 동일 학생은 질문당 1개 답변: 다시 제출하면 기존 답변 수정
- 이전 질문 기록 날짜별/반별 보관 및 삭제
- 모든 반이 같은 학생 QR 사용

---

## 1. Firebase 프로젝트 만들기

1. Firebase Console에서 새 프로젝트 생성
2. `Authentication → 로그인 방법`
3. **익명(Anonymous)** 활성화
4. **Google** 활성화
5. 교사용 페이지에서 본인 Google 계정으로 최초 로그인
6. 최초 로그인 화면에 표시되는 **교사 UID를 복사**

학생은 Anonymous 인증을 코드에서 자동 수행하므로 로그인 화면이 뜨지 않습니다. 교사는 Google 로그인만 사용합니다.

---

## 2. Realtime Database 만들기

1. `Build → Realtime Database → Create Database`
2. 위치 선택
3. 처음에는 잠금 모드로 생성 권장
4. `Rules` 탭에 이 폴더의 `database.rules.json` 내용을 붙여넣기
5. `PASTE_TEACHER_UID_HERE`를 1단계에서 복사한 실제 교사 UID로 **모두 교체**
6. Publish

> `test mode`로 공개하지 마세요. 학생은 익명 인증 후 필요한 경로만 읽고, 자기 UID의 답변만 쓸 수 있도록 규칙이 제한합니다.

---

## 3. 웹 앱 등록 + firebase-config.js 입력

1. Firebase 프로젝트 개요에서 `</>` Web 앱 추가
2. 앱 닉네임 입력
3. SDK 설정의 `firebaseConfig` 값을 확인
4. `firebase-config.js`의 `FIREBASE_CONFIG`를 실제 값으로 교체

특히 `databaseURL`이 반드시 들어가야 합니다.

예시:

```js
export const FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "my-class-app.firebaseapp.com",
  databaseURL: "https://my-class-app-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "my-class-app",
  storageBucket: "my-class-app.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};
```

---

## 4. GitHub에 올리기

새 GitHub 저장소를 만든 뒤 아래 파일을 저장소 최상단(root)에 업로드합니다.

- `index.html`
- `student.js`
- `teacher.html`
- `teacher.js`
- `styles.css`
- `firebase-config.js`
- `database.rules.json` (웹사이트 동작에는 필요 없지만 규칙 백업용)
- `README.md`

GitHub 저장소에서:

1. `Settings → Pages`
2. `Build and deployment`
3. Source: **Deploy from a branch**
4. Branch: `main`
5. Folder: `/ (root)`
6. Save

잠시 후 주소가 생성됩니다.

학생용:

```text
https://사용자명.github.io/저장소명/
```

교사용:

```text
https://사용자명.github.io/저장소명/teacher.html
```

Firebase `Authentication → 설정 → 승인된 도메인(Authorized domains)`에 `사용자명.github.io`를 추가해야 Google 로그인이 정상 동작합니다.

---

## 5. 실제 수업 흐름

### 교사

1. `teacher.html` 접속
2. 본인 Google 계정으로 로그인
3. 1반~9반 선택
4. 질문 작성 → `새 질문 시작`
5. QR 제시
6. 학생 응답이 실시간으로 표시됨
7. 다음 질문을 시작하면 학생 화면이 즉시 전환됨
8. 수업 마지막에 **수업 종료** 클릭

### 학생

1. QR 접속
2. 로그인 화면 없음
3. 브라우저 내부에서 Firebase Anonymous 인증 자동 생성
4. 현재 수업에 자동 연결
5. 질문이 바뀌면 즉시 화면 전환
6. 답변 제출
7. 수업 종료 이벤트를 받으면 실시간 연결 자동 종료

---

## 6. 자동 연결 종료 동작

### 정상 종료

교사가 `수업 종료`를 누르면 `system/currentSession.active = false`가 실시간으로 전달됩니다.
학생 페이지는 listener를 모두 해제하고 `goOffline(db)`를 호출합니다.

### 학생이 페이지를 그대로 둔 경우

- 화면이 보이는 상태: 수업 종료 이벤트를 받고 즉시 연결 종료
- 다른 앱/탭으로 가서 5분 이상: 자동으로 연결 종료
- 다시 화면으로 돌아오면 서버에서 현재 `sessionId`를 **한 번만 확인**
  - 같은 수업이면 재연결
  - 다른 수업/종료 상태면 재연결하지 않음
- 최대 90분 연결 안전장치도 있음

`firebase-config.js`에서 시간을 바꿀 수 있습니다.

---

## 7. 학생 로그인/권한 요청이 없는 이유

학생 페이지는 `signInAnonymously()`를 호출합니다. 학생에게 이메일, Google 로그인, 계정 선택, 권한 동의 화면을 보여주지 않습니다.
Firebase가 브라우저 내부에 익명 UID를 만들고, 보안 규칙은 그 UID를 이용해 답변 쓰기 권한을 제한합니다.

---

## 8. 보안상 중요한 점

- Firebase 웹 `apiKey`와 `firebaseConfig`는 비밀 비밀번호 역할이 아닙니다. 실제 접근 통제는 Security Rules가 합니다.
- `database.rules.json`의 `PASTE_TEACHER_UID_HERE`를 반드시 실제 교사 UID로 바꾸세요.
- Realtime Database를 `.read: true`, `.write: true` 같은 공개 규칙으로 두지 마세요.
- 교사용 Google 계정 비밀번호는 코드나 GitHub에 저장하지 않습니다.
- 학생은 `questions` 기록과 다른 학생의 `responses`를 읽을 수 없습니다.
- 학생은 현재 활성 수업/현재 질문에 대해서만 자신의 UID 위치에 답변을 쓸 수 있습니다.

---

## 9. V6와 다른 점

V6에서는 Apps Script와 Google Sheet가 데이터 저장소였습니다. V7은 Firebase 자체가 질문/답변 기록 저장소입니다.
따라서 Apps Script의 동시 Spreadsheet 호출 오류가 발생하지 않습니다.

Google Sheet 백업이 필요하면 다음 단계에서 **교사용 `CSV 내보내기` 버튼** 또는 **Google Sheet 자동 백업 기능**을 별도로 추가할 수 있습니다.
