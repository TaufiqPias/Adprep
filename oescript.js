"use strict";

/* ============================================================
   SETTINGS - change these for your tests
   ============================================================ */
const CONFIG = {
  defaultTitle: "Admission Preparation",
  defaultTestFile: "question.json", // or open onlineexam.html?test=physics.json
  durationMinutes: 30, // question.json can override with "durationMinutes"
  correctMark: 1,
  negativeMark: 0.25,
  autoAdvanceMs: 1200, // pause after answering before moving on
  homeUrl: "/Adprep/index.html",
  // Paste the Web App URL you get after deploying Code.gs
  sheetUrl:
    "https://script.google.com/macros/s/AKfycbzzX5n-d5FK8k51gzr_Moo73xN1_lvBtUmOPqDCqsGpcpaYkEA4rACttuew46P2vUa7/exec",
};

/* ============================================================
   State
   ============================================================ */
let questions = [];
let userAnswers = [];
let visited = new Set();
let current = 0;
let testFile = CONFIG.defaultTestFile;
let examTitle = CONFIG.defaultTitle;
let durationSec = CONFIG.durationMinutes * 60;
let startTime = 0;
let endTime = 0;
let timerInterval = null;
let advanceTimer = null;
let notifyTimer = null;
let examActive = false;
let finished = false;
let student = { name: "", class: "" };
let result = null;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const fmt = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/* ============================================================
   Load
   ============================================================ */
function getTestFile() {
  const t = new URLSearchParams(location.search).get("test");
  return t && /^[\w\-]+\.json$/.test(t) ? t : CONFIG.defaultTestFile;
}

async function initExam() {
  testFile = getTestFile();
  bindEvents();

  try {
    const res = await fetch(testFile, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.questions) || data.questions.length === 0) {
      throw new Error("No questions found");
    }

    questions = data.questions;
    examTitle = data.testTitle || CONFIG.defaultTitle;
    durationSec = (Number(data.durationMinutes) || CONFIG.durationMinutes) * 60;
    userAnswers = Array(questions.length).fill(null);

    const n = questions.length;
    const marks = n * CONFIG.correctMark;
    const minutes = Math.round(durationSec / 60);

    document.title = examTitle;
    $("exam-title").textContent = examTitle;
    $("bar-title").textContent = examTitle;
    $("exam-date").textContent =
      data.date ||
      new Date().toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    ["chip-questions", "info-questions", "total-questions"].forEach(
      (id) => ($(id).textContent = n),
    );
    ["chip-marks", "info-marks"].forEach((id) => ($(id).textContent = marks));
    ["chip-minutes", "info-minutes"].forEach(
      (id) => ($(id).textContent = minutes),
    );
    $("info-negative").textContent = CONFIG.negativeMark;
    $("timer-text").textContent = fmt(durationSec);
    $("start-btn").disabled = false;
  } catch (error) {
    console.error("Error loading questions:", error);
    $("start-error").textContent =
      "Could not load the questions. Check your internet connection and refresh the page.";
  }
}

function bindEvents() {
  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startExam();
  });
  $("next-btn").addEventListener("click", nextQuestion);
  $("prev-btn").addEventListener("click", () => goTo(current - 1));
  $("skip-btn").addEventListener("click", skipQuestion);
  $("review-btn").addEventListener("click", goToSkipped);
  $("submit-btn").addEventListener("click", requestSubmit);
  $("confirm-cancel").addEventListener(
    "click",
    () => ($("confirm-modal").hidden = true),
  );
  $("confirm-ok").addEventListener("click", () => finishExam(false));
  $("home-btn").addEventListener(
    "click",
    () => (window.location.href = CONFIG.homeUrl),
  );
  $("retry-btn").addEventListener("click", sendToSheet);
  $("palette").addEventListener("click", (e) => {
    const btn = e.target.closest(".pal");
    if (btn) goTo(Number(btn.dataset.i));
  });
  $("question-container").addEventListener("click", (e) => {
    const opt = e.target.closest(".option");
    if (opt) selectOption(Number(opt.dataset.index));
  });
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", (e) => {
    if (examActive) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

/* ============================================================
   Start / timer
   ============================================================ */
function startExam() {
  const name = $("student-name").value.trim();
  const cls = $("student-class").value.trim();
  if (!name || !cls) {
    $("start-error").textContent = "Please enter both your name and class.";
    return;
  }
  student = { name, class: cls };

  $("start-screen").hidden = true;
  $("exam-screen").hidden = false;
  window.scrollTo(0, 0);

  examActive = true;
  startTime = Date.now();
  endTime = startTime + durationSec * 1000;
  startTimer();
  goTo(0, false);
}

function startTimer() {
  tick();
  timerInterval = setInterval(tick, 500);
}

function tick() {
  const left = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
  $("timer-text").textContent = fmt(left);
  const timer = $("timer");
  timer.classList.toggle("warn", left <= 300 && left > 60);
  timer.classList.toggle("danger", left <= 60);
  if (left <= 0) finishExam(true);
}

/* ============================================================
   Questions
   ============================================================ */
function goTo(i, allowScroll = true) {
  if (i < 0 || i >= questions.length) return;
  clearTimeout(advanceTimer);
  current = i;
  visited.add(i);
  renderQuestion();
  updateChrome();
  if (allowScroll) {
    const box = $("question-container").getBoundingClientRect();
    if (box.top < 90 || box.top > window.innerHeight * 0.6) {
      $("question-container").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }
}

function renderQuestion() {
  const q = questions[current];
  $("question-container").innerHTML = `
    <div class="question">${current + 1}. ${q.question}</div>
    <div class="options">
      ${q.options
        .map(
          (option, index) => `
        <button type="button" class="option" data-index="${index}">
          <span class="option-label">${String.fromCharCode(65 + index)}</span>
          <span class="option-text">${option}</span>
          <span class="answer-feedback"></span>
        </button>`,
        )
        .join("")}
    </div>`;

  // Already answered (e.g. coming back to it): show the locked result
  if (userAnswers[current] !== null) showFeedback(userAnswers[current]);
}

function selectOption(index) {
  if (!examActive || userAnswers[current] !== null) return;

  userAnswers[current] = index;
  showFeedback(index);
  updateChrome();

  const answeredIndex = current;
  advanceTimer = setTimeout(() => {
    if (current !== answeredIndex) return;
    const target = findNext((i) => userAnswers[i] === null);
    if (target !== -1) {
      goTo(target);
    } else {
      showNotification(
        "All questions answered. Press Submit exam when you are ready.",
        true,
      );
      $("submit-btn").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, CONFIG.autoAdvanceMs);
}

function showFeedback(selectedIndex) {
  const correctIndex = questions[current].correct;
  const options = document.querySelectorAll(".option");
  options.forEach((o) => o.classList.add("locked"));

  options[correctIndex].classList.add("correct");
  options[correctIndex].querySelector(".answer-feedback").innerHTML =
    '<i class="fas fa-check"></i>';

  if (selectedIndex !== correctIndex) {
    options[selectedIndex].classList.add("incorrect");
    options[selectedIndex].querySelector(".answer-feedback").innerHTML =
      '<i class="fas fa-times"></i>';
  }
}

// Next index (wrapping around) that satisfies the test, or -1
function findNext(test) {
  const n = questions.length;
  for (let k = 1; k < n; k++) {
    const i = (current + k) % n;
    if (test(i)) return i;
  }
  return -1;
}

function nextQuestion() {
  if (current === questions.length - 1) {
    requestSubmit();
    return;
  }
  if (userAnswers[current] === null) {
    showNotification("Select an answer, or press Skip to come back later.");
    return;
  }
  goTo(current + 1);
}

function skipQuestion() {
  if (userAnswers[current] !== null) return;
  if (current < questions.length - 1) {
    goTo(current + 1);
    return;
  }
  const target = findNext((i) => userAnswers[i] === null);
  if (target === -1) {
    showNotification("No other unanswered questions. Use Submit exam.");
  } else {
    goTo(target);
  }
}

function goToSkipped() {
  const target = findNext((i) => userAnswers[i] === null && visited.has(i));
  if (target !== -1) goTo(target);
}

/* ============================================================
   Navigator + top bar
   ============================================================ */
function updateChrome() {
  const n = questions.length;
  const answeredHere = userAnswers[current] !== null;
  let answered = 0;
  let skipped = 0;

  $("palette").innerHTML = questions
    .map((_, i) => {
      const isAnswered = userAnswers[i] !== null;
      const isSkipped = !isAnswered && visited.has(i) && i !== current;
      if (isAnswered) answered++;
      if (isSkipped) skipped++;
      const state = isAnswered ? "answered" : isSkipped ? "skipped" : "unseen";
      return `<button type="button" class="pal ${state}${i === current ? " current" : ""}" data-i="${i}" aria-label="Question ${i + 1}, ${state}"${i === current ? ' aria-current="true"' : ""}>${i + 1}</button>`;
    })
    .join("");

  $("count-answered").textContent = answered;
  $("count-skipped").textContent = skipped;
  $("count-unseen").textContent = n - answered - skipped;
  $("review-label").textContent = skipped
    ? `Go to skipped (${skipped})`
    : "No skipped questions";
  $("review-btn").disabled = skipped === 0;

  $("q-counter").textContent =
    `Question ${current + 1} of ${n}  \u2022  ${answered} answered`;
  $("progress").style.width = `${(answered / n) * 100}%`;

  $("prev-btn").style.visibility = current === 0 ? "hidden" : "visible";
  $("skip-btn").disabled = answeredHere;

  const next = $("next-btn");
  if (current === n - 1) {
    next.innerHTML = 'Submit <i class="fas fa-paper-plane"></i>';
    next.classList.add("btn-submit");
    next.classList.remove("btn-next");
  } else {
    next.innerHTML = 'Next <i class="fas fa-arrow-right"></i>';
    next.classList.remove("btn-submit");
    next.classList.add("btn-next");
  }
}

function onKeyDown(e) {
  if (e.key === "Escape" && !$("confirm-modal").hidden) {
    $("confirm-modal").hidden = true;
    return;
  }
  if (!examActive || !$("confirm-modal").hidden) return;
  if (e.target.matches("input, textarea") || e.ctrlKey || e.metaKey || e.altKey)
    return;

  const key = e.key.toLowerCase();
  const count = questions[current].options.length;
  const byNumber = "1234".indexOf(key);
  const byLetter = "abcd".indexOf(key);
  const idx = byNumber !== -1 ? byNumber : byLetter;
  if (idx !== -1 && idx < count) {
    selectOption(idx);
  } else if (e.key === "ArrowRight") {
    goTo(current + 1);
  } else if (e.key === "ArrowLeft") {
    goTo(current - 1);
  }
}

/* ============================================================
   Submit + results
   ============================================================ */
function requestSubmit() {
  const left = userAnswers.filter((a) => a === null).length;
  $("confirm-text").textContent = left
    ? `You still have ${left} unanswered question${left > 1 ? "s" : ""}. They will score 0.`
    : "You have answered every question. Ready to submit?";
  $("confirm-modal").hidden = false;
  $("confirm-ok").focus();
}

function computeResult() {
  let correct = 0;
  let wrong = 0;
  userAnswers.forEach((a, i) => {
    if (a === null) return;
    if (a === questions[i].correct) correct++;
    else wrong++;
  });

  const n = questions.length;
  const unanswered = n - correct - wrong;
  const score = Math.max(
    0,
    correct * CONFIG.correctMark - wrong * CONFIG.negativeMark,
  );
  const totalMarks = n * CONFIG.correctMark;
  const percentage = (score / totalMarks) * 100;
  const timeSeconds = Math.min(
    Math.round((Date.now() - startTime) / 1000),
    durationSec,
  );

  return {
    submissionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    test: examTitle,
    name: student.name,
    class: student.class,
    score: Number(score.toFixed(2)),
    totalMarks,
    correct,
    wrong,
    unanswered,
    percentage: Number(percentage.toFixed(1)),
    timeSeconds,
    time: fmt(timeSeconds),
    answers: userAnswers
      .map(
        (a, i) => `${i + 1}:${a === null ? "-" : String.fromCharCode(65 + a)}`,
      )
      .join(" "),
  };
}

function finishExam(timedOut) {
  if (finished) return;
  finished = true;
  examActive = false;
  clearInterval(timerInterval);
  clearTimeout(advanceTimer);
  $("confirm-modal").hidden = true;

  result = computeResult();

  $("score").textContent = `${result.score.toFixed(2)}/${result.totalMarks}`;
  $("res-name").textContent = result.name;
  $("res-class").textContent = result.class;
  $("correct-answers").textContent =
    `${result.correct} (${result.wrong} incorrect)`;
  $("unanswered").textContent = result.unanswered;
  $("percentage").textContent = `${result.percentage.toFixed(1)}%`;
  $("time-taken").textContent = result.time;

  const p = result.percentage;
  $("score-text").textContent =
    p >= 90
      ? "Outstanding performance!"
      : p >= 75
        ? "Excellent work!"
        : p >= 60
          ? "Good job!"
          : p >= 50
            ? "You passed! Keep practicing!"
            : "Keep studying and try again!";

  $("exam-screen").hidden = true;
  $("result-screen").hidden = false;
  window.scrollTo(0, 0);
  if (timedOut)
    showNotification("Time is up. Your exam was submitted automatically.");

  saveLocalLeaderboard();
  renderLeaderboard();
  sendToSheet();
}

/* ============================================================
   Google Sheet
   ============================================================ */
function setSync(state, text) {
  const el = $("sync-status");
  el.className = `sync ${state}`;
  el.textContent = text;
  $("retry-btn").hidden = state !== "error";
}

async function sendToSheet() {
  if (!CONFIG.sheetUrl || CONFIG.sheetUrl.includes("PASTE_")) {
    console.warn("CONFIG.sheetUrl is not set, so the result was not sent.");
    setSync(
      "error",
      "Result not sent: the Google Sheet link has not been set up yet.",
    );
    $("retry-btn").hidden = true;
    return;
  }

  setSync("pending", "Sending your result\u2026");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    // No custom headers, so the browser sends a "simple" request that Apps Script accepts
    const res = await fetch(CONFIG.sheetUrl, {
      method: "POST",
      body: JSON.stringify(result),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.status !== "ok")
      throw new Error(data.message || "Unexpected response");
    setSync("ok", "Your result has been sent to your teacher.");
  } catch (error) {
    console.error("Could not send result:", error);
    setSync(
      "error",
      "Your result could not be sent. Check your internet connection and try again.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/* ============================================================
   Leaderboard (stored in this browser only)
   ============================================================ */
const leaderboardKey = () => `oe_leaderboard:${testFile}`;

function readLeaderboard() {
  try {
    return JSON.parse(localStorage.getItem(leaderboardKey())) || [];
  } catch (e) {
    return [];
  }
}

function saveLocalLeaderboard() {
  const data = readLeaderboard();
  data.push({
    name: result.name,
    class: result.class,
    score: result.score,
    time: result.time,
  });
  data.sort((a, b) => b.score - a.score);
  try {
    localStorage.setItem(leaderboardKey(), JSON.stringify(data.slice(0, 10)));
  } catch (e) {
    /* storage unavailable: ignore */
  }
}

function renderLeaderboard() {
  const body = $("leaderboard-body");
  const data = readLeaderboard().sort((a, b) => b.score - a.score);
  body.innerHTML = data
    .map(
      (s, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.class)}</td>
      <td>${Number(s.score).toFixed(2)}/${questions.length * CONFIG.correctMark}</td>
      <td>${escapeHtml(s.time)}</td>
    </tr>`,
    )
    .join("");
}

/* ============================================================
   Notification
   ============================================================ */
function showNotification(message, isSuccess = false) {
  const box = $("notification");
  $("notification-text").textContent = message;
  box.className = isSuccess ? "notification success" : "notification";
  box.classList.add("show");
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => box.classList.remove("show"), 3500);
}

document.addEventListener("DOMContentLoaded", initExam);
