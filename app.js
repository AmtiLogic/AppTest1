(() => {
  "use strict";

  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  const CENTERS = [54, 150, 246];
  const cellPos = (i) => ({ x: CENTERS[i % 3], y: CENTERS[Math.floor(i / 3)] });

  const boardEl = document.getElementById("board");
  const cellEls = Array.from(document.querySelectorAll(".cell"));
  const statusEl = document.getElementById("status");
  const winLineEl = document.getElementById("winLineEl");
  const newGameBtn = document.getElementById("newGameBtn");
  const menuBtn = document.getElementById("menuBtn");
  const menuPanel = document.getElementById("menuPanel");
  const difficultyRow = document.getElementById("difficultyRow");
  const fxToggle = document.getElementById("fxToggle");
  const resetScoreBtn = document.getElementById("resetScoreBtn");
  const oLabelEl = document.getElementById("oLabel");
  const scoreXCard = document.getElementById("scoreX");
  const scoreOCard = document.getElementById("scoreO");
  const scoreXVal = document.getElementById("scoreXVal");
  const scoreOVal = document.getElementById("scoreOVal");
  const scoreDrawVal = document.getElementById("scoreDrawVal");

  const STORAGE_KEY = "ttt-state-v1";

  let state = {
    mode: "cpu",       // "cpu" | "pvp"
    difficulty: "hard", // "easy" | "hard"
    fx: true,
    scores: { X: 0, O: 0, D: 0 },
  };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state = { ...state, ...saved, scores: { ...state.scores, ...(saved.scores || {}) } };
  } catch (e) { /* ignore corrupt storage */ }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }

  let board = Array(9).fill(null);
  let current = "X";
  let gameOver = false;
  let cpuThinking = false;

  function applySettingsUI() {
    document.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === state.mode));
    document.querySelectorAll("[data-diff]").forEach((b) =>
      b.classList.toggle("active", b.dataset.diff === state.difficulty));
    difficultyRow.style.display = state.mode === "cpu" ? "flex" : "none";
    fxToggle.checked = state.fx;
    oLabelEl.textContent = state.mode === "cpu" ? "CPU" : "O";
    scoreXVal.textContent = state.scores.X;
    scoreOVal.textContent = state.scores.O;
    scoreDrawVal.textContent = state.scores.D;
  }

  function vibrate(ms) {
    if (state.fx && navigator.vibrate) navigator.vibrate(ms);
  }

  let audioCtx = null;
  function beep(freq, dur) {
    if (!state.fx) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t);
      osc.stop(t + dur);
    } catch (e) { /* audio unavailable */ }
  }

  function checkWinner(b) {
    for (const line of WIN_LINES) {
      const [a, c, d] = line;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { player: b[a], line };
    }
    if (b.every((v) => v)) return { player: "draw", line: null };
    return null;
  }

  function updateStatus() {
    if (gameOver) return;
    if (state.mode === "cpu" && current === "O") {
      statusEl.textContent = "CPU is thinking…";
    } else {
      statusEl.textContent = `${current}'s turn`;
    }
    scoreXCard.classList.toggle("turn", current === "X");
    scoreOCard.classList.toggle("turn", current === "O");
  }

  function render() {
    cellEls.forEach((cell, i) => {
      const mark = board[i];
      if (mark) {
        cell.textContent = mark;
        cell.dataset.mark = mark;
        cell.dataset.filled = "true";
      } else {
        cell.textContent = "";
        delete cell.dataset.mark;
        delete cell.dataset.filled;
        cell.classList.remove("win", "pop");
      }
    });
  }

  function newGame() {
    board = Array(9).fill(null);
    current = "X";
    gameOver = false;
    cpuThinking = false;
    winLineEl.classList.remove("show");
    scoreXCard.classList.remove("turn");
    scoreOCard.classList.remove("turn");
    render();
    updateStatus();
  }

  function drawWinLine(line) {
    const a = cellPos(line[0]);
    const c = cellPos(line[2]);
    const dx = c.x - a.x, dy = c.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ext = 22;
    const x1 = a.x - (dx / len) * ext, y1 = a.y - (dy / len) * ext;
    const x2 = c.x + (dx / len) * ext, y2 = c.y + (dy / len) * ext;
    winLineEl.setAttribute("x1", x1);
    winLineEl.setAttribute("y1", y1);
    winLineEl.setAttribute("x2", x2);
    winLineEl.setAttribute("y2", y2);
    const lineColor = board[line[0]] === "X" ? "var(--accent-x)" : "var(--accent-o)";
    winLineEl.style.stroke = lineColor;
    winLineEl.style.color = lineColor;
    void winLineEl.getBoundingClientRect();
    winLineEl.classList.add("show");
  }

  function endGame(result) {
    gameOver = true;
    scoreXCard.classList.remove("turn");
    scoreOCard.classList.remove("turn");
    if (result.player === "draw") {
      statusEl.textContent = "It's a draw!";
      state.scores.D++;
      vibrate(30);
    } else {
      const winnerName = state.mode === "cpu" && result.player === "O" ? "CPU" : result.player;
      statusEl.textContent = `${winnerName} wins!`;
      result.line.forEach((i) => cellEls[i].classList.add("win"));
      drawWinLine(result.line);
      state.scores[result.player]++;
      vibrate([20, 40, 20]);
      beep(result.player === "X" ? 660 : 520, 0.18);
    }
    scoreXVal.textContent = state.scores.X;
    scoreOVal.textContent = state.scores.O;
    scoreDrawVal.textContent = state.scores.D;
    persist();
  }

  function place(index, player) {
    board[index] = player;
    const cell = cellEls[index];
    cell.dataset.mark = player;
    cell.dataset.filled = "true";
    cell.textContent = player;
    cell.classList.add("pop");
    vibrate(10);
    beep(player === "X" ? 440 : 340, 0.09);
  }

  function afterMove() {
    const result = checkWinner(board);
    if (result) {
      endGame(result);
      return;
    }
    current = current === "X" ? "O" : "X";
    updateStatus();
    if (!gameOver && state.mode === "cpu" && current === "O") {
      cpuThinking = true;
      setTimeout(cpuMove, 380);
    }
  }

  function handleCellClick(e) {
    const cell = e.currentTarget;
    const index = Number(cell.dataset.index);
    if (gameOver || board[index] || cpuThinking) return;
    if (state.mode === "cpu" && current === "O") return;
    place(index, current);
    afterMove();
  }

  // --- CPU logic ---
  function availableMoves(b) {
    return b.reduce((acc, v, i) => { if (!v) acc.push(i); return acc; }, []);
  }

  function minimax(b, player, depth) {
    const result = checkWinner(b);
    if (result) {
      if (result.player === "draw") return 0;
      if (result.player === "O") return 10 - depth;
      return depth - 10;
    }
    const moves = availableMoves(b);
    if (player === "O") {
      let best = -Infinity;
      for (const m of moves) {
        b[m] = "O";
        best = Math.max(best, minimax(b, "X", depth + 1));
        b[m] = null;
      }
      return best;
    } else {
      let best = Infinity;
      for (const m of moves) {
        b[m] = "X";
        best = Math.min(best, minimax(b, "O", depth + 1));
        b[m] = null;
      }
      return best;
    }
  }

  function bestMove() {
    const moves = availableMoves(board);
    let best = -Infinity;
    let bestMoves = [];
    for (const m of moves) {
      board[m] = "O";
      const score = minimax(board, "X", 0);
      board[m] = null;
      if (score > best) { best = score; bestMoves = [m]; }
      else if (score === best) bestMoves.push(m);
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  function cpuMove() {
    cpuThinking = false;
    if (gameOver) return;
    const moves = availableMoves(board);
    if (!moves.length) return;
    let index;
    if (state.difficulty === "easy" && Math.random() < 0.65) {
      index = moves[Math.floor(Math.random() * moves.length)];
    } else {
      index = bestMove();
    }
    place(index, "O");
    afterMove();
  }

  // --- Menu wiring ---
  menuBtn.addEventListener("click", () => {
    const isHidden = menuPanel.hidden;
    menuPanel.hidden = !isHidden;
    menuBtn.setAttribute("aria-expanded", String(isHidden));
  });

  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      applySettingsUI();
      persist();
      newGame();
    });
  });

  document.querySelectorAll("[data-diff]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.difficulty = btn.dataset.diff;
      applySettingsUI();
      persist();
    });
  });

  fxToggle.addEventListener("change", () => {
    state.fx = fxToggle.checked;
    persist();
  });

  resetScoreBtn.addEventListener("click", () => {
    state.scores = { X: 0, O: 0, D: 0 };
    applySettingsUI();
    persist();
  });

  newGameBtn.addEventListener("click", newGame);
  cellEls.forEach((cell) => cell.addEventListener("click", handleCellClick));

  applySettingsUI();
  newGame();
})();
