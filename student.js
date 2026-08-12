import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, serverTimestamp, goOffline, goOnline
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js';
import {
  FIREBASE_CONFIG, BACKGROUND_DISCONNECT_MS, MAX_SESSION_CONNECTION_MS
} from './firebase-config.js';

const app = initializeApp(FIREBASE_CONFIG, 'studentApp');
const auth = getAuth(app);
const db = getDatabase(app);

let uid = '';
let currentSession = null;
let currentQuestion = null;
let selectedAnswer = '';
let sessionUnsub = null;
let questionUnsub = null;
let backgroundTimer = null;
let maxSessionTimer = null;
let offlineReason = '';
let reconnectable = false;

const classBadge = document.getElementById('classBadge');
const modeBadge = document.getElementById('modeBadge');
const questionEl = document.getElementById('question');
const nameSection = document.getElementById('nameSection');
const nameEl = document.getElementById('name');
const answerArea = document.getElementById('answerArea');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('message');

nameEl.value = localStorage.getItem('classOpinionNameV7') || '';
submitBtn.addEventListener('click', submitAnswer);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(backgroundTimer);
    backgroundTimer = setTimeout(() => {
      if (currentSession?.active) {
        disconnectRealtime('background');
      }
    }, BACKGROUND_DISCONNECT_MS);
  } else {
    clearTimeout(backgroundTimer);
    if (offlineReason === 'background') reconnectSameSession();
  }
});

window.addEventListener('pagehide', () => {
  cleanupListeners();
  try { goOffline(db); } catch (_) {}
});

function modeName(mode) {
  return ({ free:'자유 의견', agree:'찬성 · 반대', mcq:'객관식', scale:'5점 척도' })[mode] || mode || '대기';
}

function showMessage(text, type='info') {
  msg.textContent = text || '';
  msg.className = text ? `msg ${type}` : 'msg';
}

function cleanupQuestionListener() {
  if (questionUnsub) questionUnsub();
  questionUnsub = null;
}

function cleanupListeners() {
  cleanupQuestionListener();
  if (sessionUnsub) sessionUnsub();
  sessionUnsub = null;
}

function renderWaiting(title, text) {
  selectedAnswer = '';
  currentQuestion = null;
  answerArea.innerHTML = '';
  nameSection.classList.add('hidden');
  submitBtn.classList.add('hidden');
  modeBadge.textContent = '대기';
  questionEl.textContent = title;

  const box = document.createElement('div');
  box.className = 'waiting-box';
  const cls = document.createElement('div');
  cls.className = 'waiting-class';
  cls.textContent = currentSession?.className || '잠시 기다려주세요';
  const t = document.createElement('div');
  t.className = 'waiting-text';
  t.textContent = text;
  box.append(cls, t);
  answerArea.appendChild(box);
}

function renderDisconnected(title, text, canReconnect=false) {
  selectedAnswer = '';
  currentQuestion = null;
  answerArea.innerHTML = '';
  nameSection.classList.add('hidden');
  submitBtn.classList.add('hidden');
  modeBadge.textContent = '연결 종료';
  classBadge.textContent = currentSession?.className || '수업 종료';
  questionEl.textContent = title;

  const box = document.createElement('div');
  box.className = 'waiting-box';
  const t = document.createElement('div');
  t.className = 'waiting-text';
  t.textContent = text;
  box.appendChild(t);

  if (canReconnect) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.style.marginTop = '14px';
    btn.textContent = '같은 수업 다시 연결';
    btn.addEventListener('click', reconnectSameSession);
    box.appendChild(btn);
  }
  answerArea.appendChild(box);
}

function joinSession(session) {
  currentSession = session;
  offlineReason = '';
  reconnectable = false;
  classBadge.textContent = session.className || '반 미지정';
  renderWaiting(`${session.className} 수업`, '선생님이 첫 질문을 시작하면 이 화면이 자동으로 바뀝니다.');
  subscribeQuestion(session);

  clearTimeout(maxSessionTimer);
  maxSessionTimer = setTimeout(() => disconnectRealtime('timeout'), MAX_SESSION_CONNECTION_MS);
}

function subscribeQuestion(session) {
  cleanupQuestionListener();
  const currentRef = ref(db, `classes/${session.className}/current`);
  questionUnsub = onValue(currentRef, snapshot => {
    const q = snapshot.val();
    if (!q || q.sessionId !== session.sessionId || q.waitingForQuestion) {
      renderWaiting(`${session.className} 수업`, '새 질문을 기다리는 중입니다.');
      return;
    }
    if (!currentQuestion || currentQuestion.questionId !== q.questionId || currentQuestion.version !== q.version) {
      const changed = Boolean(currentQuestion && currentQuestion.questionId !== q.questionId);
      currentQuestion = q;
      renderQuestion();
      if (changed) showMessage('새 질문이 시작되었습니다.', 'info');
    }
  }, error => showMessage(firebaseError(error), 'err'));
}

function listenSession() {
  if (sessionUnsub) sessionUnsub();
  const sessionRef = ref(db, 'system/currentSession');
  sessionUnsub = onValue(sessionRef, snapshot => {
    const session = snapshot.val();

    if (!currentSession) {
      if (session?.active && session.className && session.sessionId) {
        joinSession(session);
      } else {
        classBadge.textContent = '수업 준비 중';
        renderWaiting('현재 진행 중인 수업이 없습니다.', '선생님이 수업을 시작하면 이 화면이 자동으로 연결됩니다.');
      }
      return;
    }

    if (!session?.active || session.sessionId !== currentSession.sessionId) {
      disconnectRealtime('ended');
    }
  }, error => showMessage(firebaseError(error), 'err'));
}

function renderQuestion() {
  const q = currentQuestion;
  selectedAnswer = '';
  answerArea.innerHTML = '';
  showMessage('', '');
  classBadge.textContent = q.className || currentSession?.className || '반 미지정';
  modeBadge.textContent = modeName(q.mode);
  questionEl.textContent = q.question || '질문이 설정되지 않았습니다.';
  nameSection.classList.remove('hidden');
  submitBtn.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = '의견 제출';

  if (q.mode === 'free') {
    const label = document.createElement('label');
    label.textContent = '내 의견';
    label.htmlFor = 'freeOpinion';
    const textarea = document.createElement('textarea');
    textarea.id = 'freeOpinion';
    textarea.maxLength = 800;
    textarea.placeholder = '자신의 생각을 자유롭게 작성하세요.';
    const counter = document.createElement('div');
    counter.className = 'counter';
    counter.innerHTML = '<span id="freeCount">0</span>/800';
    textarea.addEventListener('input', () => {
      document.getElementById('freeCount').textContent = String(textarea.value.length);
    });
    answerArea.append(label, textarea, counter);
    return;
  }

  const label = document.createElement('label');
  label.textContent = q.mode === 'scale' ? '동의 정도를 선택하세요.' : '내 선택';
  answerArea.appendChild(label);

  if (q.mode === 'scale') {
    const labels = document.createElement('div');
    labels.className = 'scale-labels';
    const left = document.createElement('span');
    left.textContent = q.scaleLeftLabel || '전혀 동의하지 않음';
    const right = document.createElement('span');
    right.textContent = q.scaleRightLabel || '매우 동의함';
    labels.append(left, right);
    answerArea.appendChild(labels);

    const grid = document.createElement('div');
    grid.className = 'scale';
    for (let i = Number(q.scaleMin || 1); i <= Number(q.scaleMax || 5); i++) {
      grid.appendChild(choiceButton(String(i)));
    }
    answerArea.appendChild(grid);
  } else {
    const grid = document.createElement('div');
    grid.className = 'choices' + (q.mode === 'mcq' ? ' one' : '');
    (q.options || []).forEach(option => grid.appendChild(choiceButton(option)));
    answerArea.appendChild(grid);
  }

  if (q.additionalEnabled) {
    const label2 = document.createElement('label');
    label2.textContent = '선택 이유 / 추가 의견 (선택)';
    label2.htmlFor = 'additionalOpinion';
    const textarea2 = document.createElement('textarea');
    textarea2.id = 'additionalOpinion';
    textarea2.maxLength = 800;
    textarea2.placeholder = '왜 그렇게 생각했는지 적어도 좋습니다.';
    textarea2.style.minHeight = '115px';
    answerArea.append(label2, textarea2);
  }
}

function choiceButton(value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  button.textContent = value;
  button.addEventListener('click', () => {
    selectedAnswer = value;
    document.querySelectorAll('.choice').forEach(el => el.classList.remove('selected'));
    button.classList.add('selected');
  });
  return button;
}

async function submitAnswer() {
  if (!currentSession?.active || !currentQuestion) {
    showMessage('현재 제출할 질문이 없습니다.', 'err');
    return;
  }

  const name = nameEl.value.trim().slice(0, 30);
  localStorage.setItem('classOpinionNameV7', name);
  let answer = '';
  let opinion = '';

  if (currentQuestion.mode === 'free') {
    const field = document.getElementById('freeOpinion');
    opinion = field?.value.trim() || '';
    if (!opinion) {
      showMessage('의견을 입력해주세요.', 'err');
      field?.focus();
      return;
    }
  } else {
    if (!selectedAnswer) {
      showMessage('답변을 하나 선택해주세요.', 'err');
      return;
    }
    answer = selectedAnswer;
    opinion = document.getElementById('additionalOpinion')?.value.trim() || '';
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '제출 중...';
  showMessage('', '');

  try {
    const responseRef = ref(db, `classes/${currentSession.className}/responses/${currentQuestion.questionId}/${uid}`);
    await set(responseRef, {
      uid,
      name: name || '익명',
      className: currentSession.className,
      sessionId: currentSession.sessionId,
      questionId: currentQuestion.questionId,
      mode: currentQuestion.mode,
      answer,
      opinion: opinion.slice(0, 800),
      submittedAt: serverTimestamp()
    });

    if (currentQuestion.mode === 'free') {
      const field = document.getElementById('freeOpinion');
      if (field) field.value = '';
      const counter = document.getElementById('freeCount');
      if (counter) counter.textContent = '0';
    } else {
      selectedAnswer = '';
      document.querySelectorAll('.choice').forEach(el => el.classList.remove('selected'));
      const extra = document.getElementById('additionalOpinion');
      if (extra) extra.value = '';
    }

    showMessage('제출되었습니다. 다시 제출하면 내 답변이 수정됩니다.', 'ok');
  } catch (error) {
    showMessage(firebaseError(error), 'err');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '의견 제출';
  }
}

function disconnectRealtime(reason) {
  clearTimeout(backgroundTimer);
  clearTimeout(maxSessionTimer);
  cleanupListeners();
  offlineReason = reason;
  reconnectable = reason === 'background' || reason === 'timeout';
  try { goOffline(db); } catch (_) {}

  if (reason === 'ended') {
    renderDisconnected('수업이 종료되었습니다.', '실시간 연결도 자동으로 종료되었습니다. 이 페이지는 닫아도 됩니다.', false);
  } else if (reason === 'background') {
    renderDisconnected('잠시 연결을 쉬고 있습니다.', '페이지를 오래 보지 않아 연결을 자동으로 끊었습니다. 화면으로 돌아오면 같은 수업인지 확인해 다시 연결합니다.', true);
  } else {
    renderDisconnected('연결 시간이 만료되었습니다.', '장시간 열린 페이지의 연결을 자동으로 종료했습니다. 같은 수업이 계속 중이라면 다시 연결할 수 있습니다.', true);
  }
}

async function reconnectSameSession() {
  if (!currentSession || !reconnectable) return;
  try {
    showMessage('같은 수업인지 확인하는 중...', 'info');
    goOnline(db);
    const snapshot = await get(ref(db, 'system/currentSession'));
    const live = snapshot.val();
    if (live?.active && live.sessionId === currentSession.sessionId) {
      offlineReason = '';
      reconnectable = false;
      showMessage('', '');
      listenSession();
      subscribeQuestion(currentSession);
      clearTimeout(maxSessionTimer);
      maxSessionTimer = setTimeout(() => disconnectRealtime('timeout'), MAX_SESSION_CONNECTION_MS);
    } else {
      offlineReason = 'ended';
      reconnectable = false;
      goOffline(db);
      renderDisconnected('수업이 종료되었습니다.', '현재 열린 페이지가 참여했던 수업은 이미 종료되었습니다.', false);
    }
  } catch (error) {
    showMessage(firebaseError(error), 'err');
    try { goOffline(db); } catch (_) {}
  }
}

function firebaseError(error) {
  const code = error?.code || '';
  if (code.includes('permission-denied')) return '접근 권한이 없습니다. Firebase 보안 규칙을 확인해주세요.';
  if (code.includes('network')) return '네트워크 연결을 확인해주세요.';
  return error?.message || String(error);
}

async function boot() {
  try {
    await setPersistence(auth, browserLocalPersistence);
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    goOnline(db);
    listenSession();
  } catch (error) {
    classBadge.textContent = '연결 실패';
    renderDisconnected('수업 연결을 시작하지 못했습니다.', firebaseError(error), false);
  }
}

boot();
