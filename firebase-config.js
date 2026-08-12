// Firebase Console > 프로젝트 설정 > 내 앱 > SDK 설정 및 구성에서 복사하세요.
// 이 값들은 웹 클라이언트 식별용 설정이며, 보안은 Realtime Database Security Rules가 담당합니다.
export const firebaseConfig = {
  apiKey: "AIzaSyDdol89kGuvc42Cf3LrrliwTv05Os4FUKo",
  authDomain: "social-studies-class-e5293.firebaseapp.com",
  databaseURL: "https://social-studies-class-e5293-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "social-studies-class-e5293",
  storageBucket: "social-studies-class-e5293.firebasestorage.app",
  messagingSenderId: "764804318850",
  appId: "1:764804318850:web:dd214fd865c52f6a60169b"
};

// 학생 페이지가 백그라운드(다른 앱/탭)로 간 뒤 이 시간이 지나면 실시간 연결을 끊습니다.
export const BACKGROUND_DISCONNECT_MS = 5 * 60 * 1000;

// 교사가 '수업 종료'를 누르지 않은 예외 상황을 위한 안전장치입니다.
export const MAX_SESSION_CONNECTION_MS = 90 * 60 * 1000;
