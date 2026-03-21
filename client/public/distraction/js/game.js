/* ===================================
   DUNGEON DEFENSE - The Game
   Command the Beholder's Gaze
   =================================== */

(function () {
    'use strict';

    // --- Config ---
    const INTRUDER_TYPES = {
        rogue: {
            name: 'Rogue',
            emoji: '🗡️',
            size: 22,
            speed: 0.44,
            hp: 1,
            points: 20,
            color: '#88cc44',
            spawnWeight: 4,
            messages: [
                'A Rogue sneaks through the shadows!',
                'Thieves in the dungeon? How dare they!',
                'The little sneak thinks it can hide!',
            ],
        },
        fighter: {
            name: 'Fighter',
            emoji: '⚔️',
            size: 26,
            speed: 0.77,
            hp: 2,
            points: 15,
            color: '#6688aa',
            spawnWeight: 3,
            messages: [
                'A Fighter charges in, sword drawn!',
                'Armored scum at the gates!',
                'A warrior dares enter the dungeon!',
            ],
        },
        ranger: {
            name: 'Ranger',
            emoji: '🏹',
            size: 24,
            speed: 1.1,
            hp: 1,
            points: 25,
            color: '#44aaff',
            spawnWeight: 2,
            messages: [
                'A Ranger! Swift and deadly!',
                'An archer on the move — stop them!',
                'The Ranger moves like the wind!',
            ],
        },
        wizard: {
            name: 'Wizard',
            emoji: '🧙',
            size: 30,
            speed: 0.385,
            hp: 4,
            points: 40,
            color: '#cc88ff',
            spawnWeight: 1,
            messages: [
                'A Wizard approaches! Beware their power!',
                'Spellcaster! Do not let them pass!',
                'Sorcery! A Wizard breaches the perimeter!',
            ],
        },
    };

    const BASE_SPAWN_INTERVAL = 1800;
    const MIN_SPAWN_INTERVAL = 360;
    const WAVE_DURATION = 30000; // 30 seconds per wave
    const MAX_LIVES = 5;

    // --- Game State ---
    let canvas, ctx;
    let gameRunning = false;
    let gamePaused = false;
    let pauseTimeRemaining = { spawn: 0, wave: 0 };
    let score = 0;
    let highScore = parseInt(localStorage.getItem('dungeon_highscore') || '0', 10);
    let lives = MAX_LIVES;
    let wave = 1;
    let intruders = [];
    let particles = [];
    let spawnTimer = null;
    let waveTimer = null;
    let animationId = null;
    let lastTime = 0;
    let comboCount = 0;
    let comboTimer = null;
    let floatingTexts = [];

    // Treasure Hoard target zone (bottom center of canvas)
    let targetX, targetY, targetRadius;

    // --- DOM refs ---
    let scoreEl, waveEl, livesEl, highScoreEl;
    let overlay, overlayTitle, overlayText, startBtn;
    let pauseBtn, pauseIcon, pausedOverlay;
    let gameLog;

    // --- Initialize ---
    function init() {
        canvas = document.getElementById('game-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');

        scoreEl = document.getElementById('game-score');
        waveEl = document.getElementById('game-wave');
        livesEl = document.getElementById('game-lives');
        highScoreEl = document.getElementById('game-highscore');
        overlay = document.getElementById('game-overlay');
        overlayTitle = document.getElementById('overlay-title');
        overlayText = document.getElementById('overlay-text');
        startBtn = document.getElementById('game-start-btn');
        gameLog = document.getElementById('game-log');

        highScoreEl.textContent = highScore;

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        canvas.addEventListener('click', handleClick);
        canvas.addEventListener('touchstart', handleTouch, { passive: false });

        pauseBtn = document.getElementById('game-pause-btn');
        pauseIcon = document.getElementById('pause-icon');

        startBtn.addEventListener('click', startGame);
        pauseBtn.addEventListener('click', togglePause);

        // Keyboard shortcut: Escape or P to pause
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Escape' || e.key === 'p' || e.key === 'P') && gameRunning) {
                togglePause();
            }
        });

        // Draw idle state
        drawIdle();
    }

    function resizeCanvas() {
        const arena = document.getElementById('game-arena');
        if (!arena) return;
        canvas.width = arena.clientWidth;
        canvas.height = arena.clientHeight;
        targetX = canvas.width / 2;
        targetY = canvas.height - 40;
        targetRadius = 30;
        if (!gameRunning) drawIdle();
    }

    // --- Drawing ---
    function drawIdle() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawBackground();
        drawTreasureHoard();
    }

    function drawBackground() {
        // Dark gradient
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#0d0500');
        grad.addColorStop(0.6, '#1a0800');
        grad.addColorStop(1, '#2a0e00');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid lines for atmosphere
        ctx.strokeStyle = 'rgba(255, 69, 0, 0.03)';
        ctx.lineWidth = 1;
        for (let y = 0; y < canvas.height; y += 40) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // Dungeon wall silhouettes at edges
        ctx.fillStyle = '#1a0a00';
        ctx.beginPath();
        ctx.moveTo(0, canvas.height * 0.3);
        ctx.lineTo(0, canvas.height);
        ctx.lineTo(canvas.width * 0.15, canvas.height);
        ctx.lineTo(canvas.width * 0.1, canvas.height * 0.5);
        ctx.lineTo(canvas.width * 0.05, canvas.height * 0.35);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(canvas.width, canvas.height * 0.3);
        ctx.lineTo(canvas.width, canvas.height);
        ctx.lineTo(canvas.width * 0.85, canvas.height);
        ctx.lineTo(canvas.width * 0.9, canvas.height * 0.5);
        ctx.lineTo(canvas.width * 0.95, canvas.height * 0.35);
        ctx.closePath();
        ctx.fill();
    }

    function drawTreasureHoard() {
        // Treasure pile shape
        ctx.fillStyle = '#2a0e00';
        ctx.beginPath();
        ctx.moveTo(targetX - 60, canvas.height);
        ctx.lineTo(targetX - 15, targetY - 30);
        ctx.lineTo(targetX, targetY - 45);
        ctx.lineTo(targetX + 15, targetY - 30);
        ctx.lineTo(targetX + 60, canvas.height);
        ctx.closePath();
        ctx.fill();

        // Gold glow at top
        const glowSize = 15 + Math.sin(Date.now() / 500) * 5;
        const glow = ctx.createRadialGradient(targetX, targetY - 40, 2, targetX, targetY - 40, glowSize);
        glow.addColorStop(0, 'rgba(255, 200, 0, 0.8)');
        glow.addColorStop(0.5, 'rgba(255, 150, 0, 0.3)');
        glow.addColorStop(1, 'rgba(255, 150, 0, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(targetX - glowSize, targetY - 40 - glowSize, glowSize * 2, glowSize * 2);

        // Target zone indicator
        ctx.strokeStyle = `rgba(255, 200, 0, ${0.2 + Math.sin(Date.now() / 1000) * 0.1})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(targetX, targetY, targetRadius + 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        ctx.fillStyle = 'rgba(255, 200, 0, 0.5)';
        ctx.font = '10px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillText('TREASURE HOARD', targetX, canvas.height - 8);
    }

    function drawIntruder(intruder) {
        const { x, y, type, hp, maxHp, size, hitFlash } = intruder;
        const config = INTRUDER_TYPES[type];

        // Glow
        const glowAlpha = hitFlash > 0 ? 0.6 : 0.2;
        const glowColor = hitFlash > 0 ? 'rgba(255, 255, 255,' : `rgba(${hexToRgb(config.color)},`;
        ctx.shadowColor = config.color;
        ctx.shadowBlur = hitFlash > 0 ? 20 : 8;

        // Body circle
        ctx.fillStyle = hitFlash > 0 ? '#ffffff' : config.color;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.shadowBlur = 0;

        // Emoji
        ctx.font = `${size}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(config.emoji, x, y);

        // HP bar (if > 1 max hp)
        if (maxHp > 1) {
            const barWidth = size * 1.2;
            const barHeight = 3;
            const barX = x - barWidth / 2;
            const barY = y - size * 0.7 - 6;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(barX, barY, barWidth, barHeight);

            ctx.fillStyle = hp / maxHp > 0.5 ? config.color : '#ff4444';
            ctx.fillRect(barX, barY, barWidth * (hp / maxHp), barHeight);
        }

        // Name tag
        ctx.fillStyle = config.color;
        ctx.font = '9px Cinzel, serif';
        ctx.globalAlpha = 0.7;
        ctx.fillText(config.name, x, y + size * 0.7 + 10);
        ctx.globalAlpha = 1;
    }

    function drawParticles() {
        particles.forEach(p => {
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    }

    function drawFloatingTexts() {
        floatingTexts.forEach(ft => {
            ctx.globalAlpha = ft.alpha;
            ctx.fillStyle = ft.color;
            ctx.font = `bold ${ft.fontSize}px Cinzel, serif`;
            ctx.textAlign = 'center';
            ctx.fillText(ft.text, ft.x, ft.y);
        });
        ctx.globalAlpha = 1;
    }

    function drawEyeBeam(x, y) {
        // Draw a brief beam from top center to the click point
        const grad = ctx.createLinearGradient(canvas.width / 2, 0, x, y);
        grad.addColorStop(0, 'rgba(255, 69, 0, 0.4)');
        grad.addColorStop(1, 'rgba(255, 69, 0, 0)');

        ctx.strokeStyle = grad;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(canvas.width / 2, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    // --- Spawning ---
    function spawnIntruder() {
        if (!gameRunning) return;

        // Pick type based on wave and weights
        const types = Object.keys(INTRUDER_TYPES);
        const weights = types.map(t => {
            let w = INTRUDER_TYPES[t].spawnWeight;
            // Increase rarer types in later waves
            if (wave >= 3 && t === 'wizard') w += 1;
            if (wave >= 2 && t === 'ranger') w += 1;
            return w;
        });
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let roll = Math.random() * totalWeight;
        let type = types[0];
        for (let i = 0; i < types.length; i++) {
            roll -= weights[i];
            if (roll <= 0) { type = types[i]; break; }
        }

        const config = INTRUDER_TYPES[type];
        const speedMult = 1 + (wave - 1) * 0.15;

        // Spawn from edges (top, left, right)
        let x, y, angle;
        const edge = Math.random();
        if (edge < 0.5) {
            // Top
            x = Math.random() * canvas.width * 0.6 + canvas.width * 0.2;
            y = -config.size;
        } else if (edge < 0.75) {
            // Left
            x = -config.size;
            y = Math.random() * canvas.height * 0.4 + canvas.height * 0.1;
        } else {
            // Right
            x = canvas.width + config.size;
            y = Math.random() * canvas.height * 0.4 + canvas.height * 0.1;
        }

        // Angle toward Treasure Hoard with some randomness
        angle = Math.atan2(targetY - y, targetX - x) + (Math.random() - 0.5) * 0.5;

        const intruder = {
            type,
            x,
            y,
            angle,
            speed: config.speed * speedMult,
            size: config.size,
            hp: config.hp + (wave > 4 ? Math.floor((wave - 4) / 3) : 0),
            maxHp: config.hp + (wave > 4 ? Math.floor((wave - 4) / 3) : 0),
            points: config.points,
            hitFlash: 0,
            wobble: Math.random() * Math.PI * 2,
            wobbleSpeed: 0.02 + Math.random() * 0.02,
            wobbleAmount: 0.3 + Math.random() * 0.3,
        };

        intruders.push(intruder);

        // Schedule next spawn
        const interval = Math.max(
            MIN_SPAWN_INTERVAL,
            BASE_SPAWN_INTERVAL - wave * 150 + Math.random() * 500
        );
        spawnTimer = setTimeout(spawnIntruder, interval);
    }

    // --- Game Logic ---
    function startGame() {
        score = 0;
        lives = MAX_LIVES;
        wave = 1;
        intruders = [];
        particles = [];
        floatingTexts = [];
        comboCount = 0;
        gameRunning = true;

        gamePaused = false;
        updateHUD();
        overlay.style.display = 'none';
        removePausedOverlay();
        pauseBtn.disabled = false;
        pauseIcon.textContent = '❚❚';
        logMessage('The Beholder opens its eye. The dungeon is watching.');

        spawnIntruder();
        startWaveTimer();
        lastTime = performance.now();
        animationId = requestAnimationFrame(gameLoop);
    }

    function startWaveTimer() {
        waveTimer = setTimeout(() => {
            if (!gameRunning) return;
            wave++;
            waveEl.textContent = wave;
            logMessage(`Wave ${wave} begins! The adventurers grow bolder.`);
            createFloatingText(canvas.width / 2, canvas.height / 2, `WAVE ${wave}`, '#ff4500', 28);
            startWaveTimer();
        }, WAVE_DURATION);
    }

    function gameLoop(timestamp) {
        if (!gameRunning) return;

        const dt = Math.min(timestamp - lastTime, 50); // cap delta
        lastTime = timestamp;

        update(dt);
        draw();

        animationId = requestAnimationFrame(gameLoop);
    }

    function update(dt) {
        // Update intruders
        for (let i = intruders.length - 1; i >= 0; i--) {
            const intruder = intruders[i];

            // Wobble movement
            intruder.wobble += intruder.wobbleSpeed * dt;
            const wobbleX = Math.sin(intruder.wobble) * intruder.wobbleAmount;

            intruder.x += (Math.cos(intruder.angle) + wobbleX * 0.1) * intruder.speed * dt * 0.06;
            intruder.y += Math.sin(intruder.angle) * intruder.speed * dt * 0.06;

            // Hit flash decay
            if (intruder.hitFlash > 0) intruder.hitFlash -= dt * 0.005;

            // Check if reached Treasure Hoard
            const dist = Math.hypot(intruder.x - targetX, intruder.y - targetY);
            if (dist < targetRadius + intruder.size * 0.5) {
                intruders.splice(i, 1);
                loseLife(intruder);
            }

            // Remove if way off screen (shouldn't happen, but safety)
            if (intruder.y > canvas.height + 100 || intruder.x < -200 || intruder.x > canvas.width + 200) {
                intruders.splice(i, 1);
            }
        }

        // Update particles
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx * dt * 0.06;
            p.y += p.vy * dt * 0.06;
            p.alpha -= p.decay * dt * 0.06;
            p.size *= 0.99;
            if (p.alpha <= 0) particles.splice(i, 1);
        }

        // Update floating texts
        for (let i = floatingTexts.length - 1; i >= 0; i--) {
            const ft = floatingTexts[i];
            ft.y -= 0.5 * dt * 0.06;
            ft.alpha -= 0.008 * dt * 0.06;
            if (ft.alpha <= 0) floatingTexts.splice(i, 1);
        }
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawBackground();

        // Draw eye beam to nearest intruder (subtle)
        if (intruders.length > 0) {
            const nearest = intruders.reduce((a, b) =>
                Math.hypot(a.x - targetX, a.y - targetY) < Math.hypot(b.x - targetX, b.y - targetY) ? a : b
            );
            ctx.globalAlpha = 0.15;
            drawEyeBeam(nearest.x, nearest.y);
            ctx.globalAlpha = 1;
        }

        drawParticles();
        intruders.forEach(drawIntruder);
        drawTreasureHoard();
        drawFloatingTexts();
    }

    // --- Interaction ---
    function handleClick(e) {
        if (!gameRunning || gamePaused) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        checkHit(x, y);
    }

    function handleTouch(e) {
        if (!gameRunning || gamePaused) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        checkHit(x, y);
    }

    function checkHit(x, y) {
        // Draw eye beam
        drawEyeBeam(x, y);

        // Check intruders (reverse order so top-drawn are checked first)
        for (let i = intruders.length - 1; i >= 0; i--) {
            const intruder = intruders[i];
            const dist = Math.hypot(x - intruder.x, y - intruder.y);
            const hitRadius = intruder.size * 0.8;

            if (dist < hitRadius) {
                intruder.hp--;
                intruder.hitFlash = 1;

                // Spawn hit particles
                spawnHitParticles(intruder.x, intruder.y, INTRUDER_TYPES[intruder.type].color, 5);

                if (intruder.hp <= 0) {
                    destroyIntruder(intruder, i);
                }
                return; // Only hit one intruder per click
            }
        }

        // Miss - small penalty feedback
        comboCount = 0;
        spawnHitParticles(x, y, '#333333', 3);
    }

    function destroyIntruder(intruder, index) {
        // Combo system
        comboCount++;
        clearTimeout(comboTimer);
        comboTimer = setTimeout(() => { comboCount = 0; }, 3000);

        const comboMultiplier = Math.min(comboCount, 5);
        const points = intruder.points * comboMultiplier;
        score += points;

        // Effects
        spawnHitParticles(intruder.x, intruder.y, INTRUDER_TYPES[intruder.type].color, 15);

        let text = `+${points}`;
        if (comboCount > 1) text += ` x${comboMultiplier}`;
        createFloatingText(intruder.x, intruder.y - 20, text, INTRUDER_TYPES[intruder.type].color, 16 + comboCount * 2);

        // Log message
        const msgs = INTRUDER_TYPES[intruder.type].messages;
        if (Math.random() < 0.3) {
            logMessage(msgs[Math.floor(Math.random() * msgs.length)] + ' Destroyed!');
        }

        intruders.splice(index, 1);
        updateHUD();
    }

    function loseLife(intruder) {
        lives--;
        updateHUD();

        createFloatingText(targetX, targetY - 60, `${INTRUDER_TYPES[intruder.type].name} reached the Treasure Hoard!`, '#ff2200', 14);
        logMessage(`A ${INTRUDER_TYPES[intruder.type].name} breached the defenses!`);

        // Screen shake effect
        const arena = document.getElementById('game-arena');
        arena.style.animation = 'none';
        arena.offsetHeight; // reflow
        arena.style.animation = 'screenShake 0.3s ease-out';

        spawnHitParticles(targetX, targetY, '#ff2200', 20);

        if (lives <= 0) {
            gameOver();
        }
    }

    function gameOver() {
        gameRunning = false;
        gamePaused = false;
        clearTimeout(spawnTimer);
        clearTimeout(waveTimer);
        cancelAnimationFrame(animationId);
        pauseBtn.disabled = true;
        pauseIcon.textContent = '❚❚';
        removePausedOverlay();

        if (score > highScore) {
            highScore = score;
            localStorage.setItem('dungeon_highscore', String(highScore));
            highScoreEl.textContent = highScore;
            logMessage(`New high score: ${highScore}!`);
        }

        overlayTitle.textContent = 'The Dungeon Has Fallen';
        overlayText.innerHTML = `The adventurers have reached the Treasure Hoard.<br><br>
            <strong>Final Score:</strong> ${score}<br>
            <strong>Waves Survived:</strong> ${wave}<br>
            <strong>High Score:</strong> ${highScore}`;
        startBtn.querySelector('span').textContent = 'Try Again';
        overlay.style.display = 'flex';
    }

    // --- Pause ---
    function togglePause() {
        if (!gameRunning) return;

        if (!gamePaused) {
            // Pause
            gamePaused = true;
            clearTimeout(spawnTimer);
            clearTimeout(waveTimer);
            cancelAnimationFrame(animationId);
            pauseIcon.textContent = '▶';
            logMessage('The Beholder rests... Game paused.');

            // Show paused overlay on canvas
            const arena = document.getElementById('game-arena');
            const el = document.createElement('div');
            el.className = 'game-paused-overlay';
            el.id = 'game-paused-overlay';
            el.innerHTML = '<h3>PAUSED</h3><p>Press P, Esc, or click ▶ to resume</p>';
            arena.appendChild(el);
        } else {
            // Resume
            gamePaused = false;
            pauseIcon.textContent = '❚❚';
            removePausedOverlay();
            logMessage('The Beholder reopens its eye. Resume the hunt!');

            // Restart timers & loop
            lastTime = performance.now();
            spawnIntruder();
            startWaveTimer();
            animationId = requestAnimationFrame(gameLoop);
        }
    }

    function removePausedOverlay() {
        const el = document.getElementById('game-paused-overlay');
        if (el) el.remove();
    }

    // --- Effects ---
    function spawnHitParticles(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 3 + 1;
            particles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() * 3 + 1,
                color,
                alpha: 1,
                decay: 0.02 + Math.random() * 0.02,
            });
        }
    }

    function createFloatingText(x, y, text, color, fontSize) {
        floatingTexts.push({ x, y, text, color, fontSize, alpha: 1 });
    }

    // --- HUD ---
    function updateHUD() {
        scoreEl.textContent = score;
        waveEl.textContent = wave;

        let livesHTML = '';
        for (let i = 0; i < MAX_LIVES; i++) {
            livesHTML += `<span class="life${i < lives ? '' : ' lost'}">${i < lives ? '🔥' : '💀'}</span>`;
        }
        livesEl.innerHTML = livesHTML;
    }

    function logMessage(msg) {
        if (!gameLog) return;
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.textContent = `> ${msg}`;
        gameLog.appendChild(entry);
        gameLog.scrollTop = gameLog.scrollHeight;

        // Keep only last 20 messages
        while (gameLog.children.length > 20) {
            gameLog.removeChild(gameLog.firstChild);
        }
    }

    // --- Helpers ---
    function hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `${r}, ${g}, ${b}`;
    }

    // --- Boot ---
    document.addEventListener('DOMContentLoaded', init);
})();
