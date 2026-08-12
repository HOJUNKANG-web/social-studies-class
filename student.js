import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, push, remove, serverTimestamp, goOffline, goOnline
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
let peerResponsesUnsub = null;
let peerCommentsUnsub = null;
let backgroundTimer = null;
let maxSessionTimer = null;
let offlineReason = '';
let reconnectable = false;
let peerResponses = [];
let peerComments = {};
const expandedComments = new Set();
const commentDrafts = new Map();

const classBadge = document.getElementById('classBadge');
const modeBadge = document.getElementById('modeBadge');
const questionEl = document.getElementById('question');
const nameSection = document.getElementById('nameSection');
const nameEl = document.getElementById('name');
const answerArea = document.getElementById('answerArea');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('message');
const peerSection = document.getElementById('peerSection');
const peerResponsesEl = document.getElementById('peerResponses');
const peerCountEl = document.getElementById('peerCount');

nameEl.value = localStorage.getItem('classOpinionNameV7') || '';
submitBtn.addEventListener('click', submitAnswer);

nameEl.addEventListener('input', () => {
  localStorage.setItem('classOpinionNameV7', nameEl.value.trim().slice(0, 30));
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(backgroundTimer);
    backgroundTimer = setTimeout(() => {
      if (currentSession?.active) disconnectRealtime('background');
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

function cleanupPeerListeners() {
  if (peerResponsesUnsub) peerResponsesUnsub();
  if (peerCommentsUnsub) peerCommentsUnsub();
  peerResponsesUnsub = null;
  peerCommentsUnsub = null;
  peerResponses = [];
  peerComments = {};
  expandedComments.clear();
  commentDrafts.clear();
  peerSection.classList.add('hidden');
  peerResponsesEl.innerHTML = '';
  peerCountEl.textContent = '0개 의견';
}

function cleanupListeners() {
  cleanupQuestionListener();
  cleanupPeerListeners();
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
  cleanupPeerListeners();

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
  cleanupPeerListeners();

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

    const changed = !currentQuestion || currentQuestion.questionId !== q.questionId;
    const versionChanged = !currentQuestion || currentQuestion.version !== q.version;
    currentQuestion = q;

    if (changed || versionChanged) {
      renderQuestion();
      if (changed) {
        attachPeerDiscussion(q);
        if (peerResponses.length) showMessage('새 질문이 시작되었습니다.', 'info');
      }
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
  peerSection.classList.remove('hidden');

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

function attachPeerDiscussion(question) {
  cleanupPeerListeners();
  peerSection.classList.remove('hidden');

  const responsesRef = ref(db, `classes/${question.className}/responses/${question.questionId}`);
  peerResponsesUnsub = onValue(responsesRef, snapshot => {
    const raw = snapshot.val() || {};
    peerResponses = Object.entries(raw)
      .map(([responseUid, value]) => ({ responseUid, ...value }))
      .sort((a,b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
    renderPeerDiscussion();
  }, error => renderPeerError(firebaseError(error)));

  const commentsRef = ref(db, `classes/${question.className}/comments/${question.questionId}`);
  peerCommentsUnsub = onValue(commentsRef, snapshot => {
    peerComments = snapshot.val() || {};
    renderPeerDiscussion();
  }, error => renderPeerError(firebaseError(error)));
}

function renderPeerError(text) {
  peerResponsesEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'peer-empty';
  box.textContent = text;
  peerResponsesEl.appendChild(box);
}

function renderPeerDiscussion() {
  if (!currentQuestion) return;
  captureCommentDrafts();
  peerSection.classList.remove('hidden');
  peerCountEl.textContent = `${peerResponses.length}개 의견`;
  peerResponsesEl.innerHTML = '';

  if (!peerResponses.length) {
    peerResponsesEl.innerHTML = '<div class="peer-empty">아직 친구 의견이 없습니다. 첫 의견을 남겨보세요.</div>';
    return;
  }

  peerResponses.forEach(item => peerResponsesEl.appendChild(createPeerResponseCard(item)));
}

function createPeerResponseCard(item) {
  const card = document.createElement('article');
  card.className = 'peer-response-card';
  card.dataset.responseUid = item.responseUid;
  if (item.responseUid === uid) card.classList.add('mine');

  const meta = document.createElement('div');
  meta.className = 'peer-meta';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'peer-name-wrap';
  const name = document.createElement('span');
  name.className = 'peer-name';
  name.textContent = item.name || '익명';
  nameWrap.appendChild(name);
  if (item.responseUid === uid) {
    const mine = document.createElement('span');
    mine.className = 'mine-badge';
    mine.textContent = '내 의견';
    nameWrap.appendChild(mine);
  }
  const time = document.createElement('span');
  time.className = 'peer-time';
  time.textContent = formatTime(item.submittedAt);
  meta.append(nameWrap, time);
  card.appendChild(meta);

  if (currentQuestion.mode !== 'free') {
    const tag = document.createElement('div');
    tag.className = 'answer-tag';
    tag.textContent = currentQuestion.mode === 'scale' ? `${item.answer}점` : (item.answer || '선택 없음');
    card.appendChild(tag);
  }

  const opinion = document.createElement('div');
  opinion.className = 'peer-opinion';
  opinion.textContent = item.opinion || (currentQuestion.mode === 'free' ? '(내용 없음)' : '추가 의견 없음');
  if (!item.opinion) opinion.classList.add('no-extra');
  card.appendChild(opinion);

  const comments = commentsFor(item.responseUid);
  const footer = document.createElement('div');
  footer.className = 'peer-card-footer';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'comment-toggle';
  toggle.textContent = `댓글 ${comments.length}`;
  toggle.addEventListener('click', () => {
    if (expandedComments.has(item.responseUid)) expandedComments.delete(item.responseUid);
    else expandedComments.add(item.responseUid);
    renderPeerDiscussion();
  });
  footer.appendChild(toggle);
  card.appendChild(footer);

  if (expandedComments.has(item.responseUid)) {
    card.appendChild(createCommentArea(item.responseUid, comments));
  }

  return card;
}

function commentsFor(responseUid) {
  const raw = peerComments?.[responseUid] || {};
  return Object.entries(raw)
    .map(([commentId, value]) => ({ commentId, ...value }))
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

function createCommentArea(responseUid, comments) {
  const area = document.createElement('div');
  area.className = 'comment-area';

  const list = document.createElement('div');
  list.className = 'comment-list';
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = '아직 댓글이 없습니다.';
    list.appendChild(empty);
  } else {
    comments.forEach(comment => list.appendChild(createCommentItem(responseUid, comment)));
  }
  area.appendChild(list);

  const form = document.createElement('div');
  form.className = 'comment-form';
  const input = document.createElement('textarea');
  input.className = 'comment-input';
  input.maxLength = 200;
  input.rows = 2;
  input.placeholder = '질문·동의·반론을 200자 이내로 남겨보세요.';
  input.value = commentDrafts.get(responseUid) || '';
  input.addEventListener('input', () => commentDrafts.set(responseUid, input.value));
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitComment(responseUid, input);
    }
  });
  const actionRow = document.createElement('div');
  actionRow.className = 'comment-form-actions';
  const hint = document.createElement('span');
  hint.textContent = 'Ctrl+Enter로 등록';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'comment-submit';
  send.textContent = '댓글 등록';
  send.addEventListener('click', () => submitComment(responseUid, input));
  actionRow.append(hint, send);
  form.append(input, actionRow);
  area.appendChild(form);
  return area;
}

function createCommentItem(responseUid, comment) {
  const item = document.createElement('div');
  item.className = 'comment-item';
  const top = document.createElement('div');
  top.className = 'comment-meta';
  const left = document.createElement('div');
  const author = document.createElement('span');
  author.className = 'comment-author';
  author.textContent = comment.name || '익명';
  left.appendChild(author);
  if (comment.uid === uid) {
    const mine = document.createElement('span');
    mine.className = 'comment-mine';
    mine.textContent = '나';
    left.appendChild(mine);
  }
  const time = document.createElement('span');
  time.textContent = formatTime(comment.createdAt);
  top.append(left, time);
  item.appendChild(top);

  const text = document.createElement('div');
  text.className = 'comment-text';
  text.textContent = comment.text || '';
  item.appendChild(text);

  if (comment.uid === uid) {
    const actions = document.createElement('div');
    actions.className = 'comment-item-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'comment-delete';
    del.textContent = '내 댓글 삭제';
    del.addEventListener('click', () => deleteOwnComment(responseUid, comment.commentId));
    actions.appendChild(del);
    item.appendChild(actions);
  }
  return item;
}

async function submitComment(responseUid, input) {
  if (!currentSession?.active || !currentQuestion) return;
  const text = String(input?.value || '').trim().slice(0, 200);
  if (!text) {
    input?.focus();
    return;
  }

  const name = nameEl.value.trim().slice(0, 30) || '익명';
  localStorage.setItem('classOpinionNameV7', nameEl.value.trim().slice(0, 30));
  const target = ref(db, `classes/${currentSession.className}/comments/${currentQuestion.questionId}/${responseUid}`);
  const commentRef = push(target);

  input.disabled = true;
  try {
    await set(commentRef, {
      uid,
      name,
      text,
      className: currentSession.className,
      sessionId: currentSession.sessionId,
      questionId: currentQuestion.questionId,
      responseUid,
      createdAt: serverTimestamp()
    });
    commentDrafts.delete(responseUid);
    input.value = '';
  } catch (error) {
    showMessage(firebaseError(error), 'err');
  } finally {
    input.disabled = false;
  }
}

async function deleteOwnComment(responseUid, commentId) {
  if (!currentQuestion || !commentId) return;
  try {
    await remove(ref(db, `classes/${currentSession.className}/comments/${currentQuestion.questionId}/${responseUid}/${commentId}`));
  } catch (error) {
    showMessage(firebaseError(error), 'err');
  }
}

function captureCommentDrafts() {
  document.querySelectorAll('.comment-input').forEach(input => {
    const card = input.closest('.peer-response-card');
    const responseUid = card?.dataset?.responseUid;
    if (responseUid) commentDrafts.set(responseUid, input.value);
  });
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

function formatTime(value) {
  const n = Number(value || 0);
  if (!n) return '';
  return new Date(n).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
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
