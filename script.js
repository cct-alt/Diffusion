const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
canvas.width = 700;
canvas.height = 600;

const els = {
    pType: document.getElementById('particleType'), prType: document.getElementById('proteinType'),
    prCount: document.getElementById('proteinCount'), lCount: document.getElementById('leftCount'),
    rCount: document.getElementById('rightCount'), thick: document.getElementById('thicknessSlider'),
    area: document.getElementById('surfaceAreaSlider'), temp: document.getElementById('tempSlider'),
    statLR: document.getElementById('statLR'), statRL: document.getElementById('statRL'),
    statNet: document.getElementById('statNet'), initRate: document.getElementById('initRateDisplay')
};

const valIds = { lCount: 'leftCountVal', rCount: 'rightCountVal', thick: 'thicknessVal', area: 'surfaceAreaVal', prCount: 'proteinCountVal', temp: 'tempVal' };

let isRunning = false, animationId;
let particles = [];
let floatingTexts = [];
let baseSpeed = 0.8;

let lastTimestamp = 0, chartUpdateAccumulator = 0, simTimeMs = 0;
let crossLR_1s = 0, crossRL_1s = 0, crossLR_5s = 0, crossRL_5s = 0;
let initRateDone = false;
let globalLCount = 0, globalRCount = 0;
let limitWarningTimer = null;

Chart.defaults.font.size = 12;
const qtyChart = new Chart(document.getElementById('qtyChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: [0],
        datasets: [
            { label: '左側數量', data: [0], borderColor: '#3498db', borderWidth: 2, tension: 0.1 },
            { label: '右側數量', data: [0], borderColor: '#f39c12', borderWidth: 2, tension: 0.1 }
        ]
    },
    options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { y: { beginAtZero: true, max: 100 }, x: { title: { display: true, text: '時間 (秒)' } } },
        plugins: { tooltip: { enabled: false } }
    }
});

const typeConfig = {
    'O2': { color: '#ff4757', shape: 'circle', radius: 4, canPassLipid: true, reqChannel: 'none' },
    'CO2': { color: '#2f3542', shape: 'circle', radius: 4, canPassLipid: true, reqChannel: 'none', stroke: '#fff' },
    'H2O': { color: '#00a8ff', shape: 'circle', radius: 3, canPassLipid: false, reqChannel: 'aquaporin' },
    'Na': { color: '#e67e22', shape: 'circle', radius: 5, canPassLipid: false, reqChannel: 'na_channel', text: '+' },
    'Glucose': { color: '#2ecc71', shape: 'hex', radius: 7, canPassLipid: false, reqChannel: 'glucose_carrier' },
    'AminoAcid': { color: '#f1c40f', shape: 'square', radius: 6, canPassLipid: false, reqChannel: 'aa_carrier' },
    'Protein': { color: '#3742fa', shape: 'circle', radius: 14, canPassLipid: false, reqChannel: 'none' }
};

function updateCarrierTip() {
    const tipEl = document.getElementById('carrierTip');
    const pType = els.prType.value;
    const count = parseInt(els.prCount.value);
    if (tipEl) {
        if ((pType === 'glucose_carrier' || pType === 'aa_carrier') && count > 0) {
            tipEl.style.display = 'block';
        } else {
            tipEl.style.display = 'none';
        }
    }
}

function updateProteinLimit() {
    const mHeight = canvas.height * (parseInt(els.area.value) / 100);
    let maxProteinsAllowed = Math.max(0, Math.min(5, Math.floor(mHeight / 70)));
    els.prCount.max = maxProteinsAllowed;

    if (parseInt(els.prCount.value) > maxProteinsAllowed) {
        els.prCount.value = maxProteinsAllowed;
        document.getElementById(valIds.prCount).innerText = maxProteinsAllowed;
        const warningSpan = document.getElementById('proteinLimitWarning');
        if (warningSpan) {
            warningSpan.style.display = 'inline';
            if (limitWarningTimer) clearTimeout(limitWarningTimer);
            limitWarningTimer = setTimeout(() => warningSpan.style.display = 'none', 3000);
        }
    }
    updateCarrierTip();
}

class Particle {
    constructor(side, type) {
        this.type = type; this.cfg = typeConfig[type]; this.currentSide = side;
        this.hasTriggeredText = false;

        const r = this.cfg.radius;
        const totalThick = parseInt(els.thick.value);
        const center = canvas.width / 2;
        const outerLeft = center - totalThick / 2;
        const outerRight = center + totalThick / 2;

        if (side === 'left') this.x = r + Math.random() * (outerLeft - r * 2);
        else this.x = outerRight + r + Math.random() * (canvas.width - outerRight - r * 2);
        this.y = r + Math.random() * (canvas.height - r * 2);

        const angle = Math.random() * Math.PI * 2;
        this.vx = Math.cos(angle); this.vy = Math.sin(angle);
    }

    // 【修改】加入 timeScale 以完美相容 120Hz/60Hz 螢幕
    update(speedMult, timeScale) {
        if (Math.random() < (0.04 * timeScale)) { // 轉向機率也要根據時間調整
            let currentAngle = Math.atan2(this.vy, this.vx);
            let angleOffset = (Math.random() - 0.5) * (Math.PI / 3);
            let newAngle = currentAngle + angleOffset;
            this.vx = Math.cos(newAngle);
            this.vy = Math.sin(newAngle);
        }

        let oldX = this.x;
        this.x += this.vx * baseSpeed * speedMult * timeScale;
        this.y += this.vy * baseSpeed * speedMult * timeScale;

        let hitWall = false;
        if (this.x - this.cfg.radius < 0) { this.x = this.cfg.radius; this.vx *= -1; hitWall = true; }
        if (this.x + this.cfg.radius > canvas.width) { this.x = canvas.width - this.cfg.radius; this.vx *= -1; hitWall = true; }
        if (this.y - this.cfg.radius < 0) { this.y = this.cfg.radius; this.vy *= -1; hitWall = true; }
        if (this.y + this.cfg.radius > canvas.height) { this.y = canvas.height - this.cfg.radius; this.vy *= -1; hitWall = true; }

        if (hitWall && simTimeMs > 10000 && Math.abs(globalLCount - globalRCount) > 5) {
            let highSide = globalLCount > globalRCount ? 'left' : 'right';
            if (this.currentSide === highSide) {
                let targetX = canvas.width / 2;
                let targetY = canvas.height / 2 + (Math.random() * 100 - 50);
                let desiredAngle = Math.atan2(targetY - this.y, targetX - this.x);
                this.vx = this.vx * 0.6 + Math.cos(desiredAngle) * 0.4;
                this.vy = this.vy * 0.6 + Math.sin(desiredAngle) * 0.4;
                let mag = Math.hypot(this.vx, this.vy);
                this.vx /= mag; this.vy /= mag;
            }
        }

        const totalThick = parseInt(els.thick.value), surf = parseInt(els.area.value) / 100;
        const center = canvas.width / 2, memThick = 40;
        const outerLeft = center - totalThick / 2, outerRight = center + totalThick / 2;
        const mLeft = center - memThick / 2, mRight = center + memThick / 2;
        const mHeight = canvas.height * surf, mTop = (canvas.height - mHeight) / 2, mBottom = mTop + mHeight;

        let hitOuterL = (this.x + this.cfg.radius > outerLeft && this.x < outerLeft && this.vx > 0);
        let hitOuterR = (this.x - this.cfg.radius < outerRight && this.x > outerRight && this.vx < 0);

        if ((hitOuterL || hitOuterR) && (this.y < mTop || this.y > mBottom)) {
            this.x = hitOuterL ? outerLeft - this.cfg.radius : outerRight + this.cfg.radius;
            this.vx *= -1;
        } else {
            let hitMemL = (this.x + this.cfg.radius > mLeft && this.x < mLeft && this.vx > 0);
            let hitMemR = (this.x - this.cfg.radius < mRight && this.x > mRight && this.vx < 0);

            if (hitMemL || hitMemR) {
                let bounce = false;
                if (this.y < mTop || this.y > mBottom) bounce = true;
                else {
                    let inChannel = false, pType = els.prType.value, pCount = parseInt(els.prCount.value);
                    if (pCount > 0 && pType !== 'none') {
                        const sp = mHeight / (pCount + 1);
                        for (let i = 1; i <= pCount; i++) {
                            if (Math.abs(this.y - (mTop + sp * i)) <= (24 - this.cfg.radius)) { inChannel = true; break; }
                        }
                    }
                    if (inChannel) { if (this.cfg.reqChannel !== pType && !this.cfg.canPassLipid) bounce = true; }
                    else { if (!this.cfg.canPassLipid) bounce = true; }
                }

                if (!bounce && simTimeMs > 10000 && Math.abs(globalLCount - globalRCount) > 5) {
                    let movingToHigh = (this.currentSide === 'left' && globalLCount < globalRCount) || (this.currentSide === 'right' && globalRCount < globalLCount);
                    if (movingToHigh && Math.random() < 0.5) bounce = true;
                }

                if (bounce) {
                    this.x = hitMemL ? mLeft - this.cfg.radius : mRight + this.cfg.radius;
                    this.vx *= -1;
                }
            } else if (this.x > outerLeft && this.x < outerRight) {
                if (this.y < mTop + this.cfg.radius) { this.y = mTop + this.cfg.radius; this.vy *= -1; }
                if (this.y > mBottom - this.cfg.radius) { this.y = mBottom - this.cfg.radius; this.vy *= -1; }

                if (this.x > mLeft && this.x < mRight && !this.cfg.canPassLipid) {
                    let pType = els.prType.value, pCount = parseInt(els.prCount.value);
                    if (pCount > 0 && pType !== 'none') {
                        const sp = mHeight / (pCount + 1);
                        let closestChannelY = mTop + sp, minDist = Math.abs(this.y - closestChannelY);
                        for (let i = 2; i <= pCount; i++) {
                            let cy = mTop + sp * i, dist = Math.abs(this.y - cy);
                            if (dist < minDist) { minDist = dist; closestChannelY = cy; }
                        }
                        let cTop = closestChannelY - 16 + this.cfg.radius, cBottom = closestChannelY + 16 - this.cfg.radius;
                        if (this.y < cTop) { this.y = cTop; this.vy *= -1; }
                        else if (this.y > cBottom) { this.y = cBottom; this.vy *= -1; }
                    }
                }
            }
        }

        let inMembraneCore = (this.x > mLeft && this.x < mRight);
        if (inMembraneCore && !this.cfg.canPassLipid) {
            if ((oldX <= center && this.x > center) || (oldX >= center && this.x < center)) {
                if (!this.hasTriggeredText && (els.prType.value === 'glucose_carrier' || els.prType.value === 'aa_carrier')) {
                    floatingTexts.push({ x: center, y: this.y - 20, text: '無需 ATP', alpha: 1.0 });
                    this.hasTriggeredText = true;
                }
            }
        }
        if (!inMembraneCore) this.hasTriggeredText = false;

        let sideNow = this.currentSide;
        if (this.x + this.cfg.radius < outerLeft) sideNow = 'left';
        else if (this.x - this.cfg.radius > outerRight) sideNow = 'right';

        if (this.currentSide === 'left' && sideNow === 'right') {
            crossLR_1s++; if (simTimeMs <= 5000) crossLR_5s++; this.currentSide = 'right';
        } else if (this.currentSide === 'right' && sideNow === 'left') {
            crossRL_1s++; if (simTimeMs <= 5000) crossRL_5s++; this.currentSide = 'left';
        }
    }

    draw(ctx) {
        ctx.beginPath(); ctx.fillStyle = this.cfg.color;
        if (this.cfg.shape === 'circle') ctx.arc(this.x, this.y, this.cfg.radius, 0, Math.PI * 2);
        else if (this.cfg.shape === 'square') ctx.rect(this.x - this.cfg.radius, this.y - this.cfg.radius, this.cfg.radius * 2, this.cfg.radius * 2);
        else if (this.cfg.shape === 'hex') for (let i = 0; i < 6; i++) ctx.lineTo(this.x + this.cfg.radius * Math.cos(i * Math.PI / 3), this.y + this.cfg.radius * Math.sin(i * Math.PI / 3));
        ctx.fill();
        if (this.cfg.stroke) { ctx.lineWidth = 1.5; ctx.strokeStyle = this.cfg.stroke; ctx.stroke(); }
        if (this.cfg.text) { ctx.fillStyle = 'white'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(this.cfg.text, this.x, this.y); }
    }
}

function drawBackgroundNumbers() {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.font = 'bold 160px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(globalLCount, canvas.width * 0.25, canvas.height / 2);
    ctx.fillText(globalRCount, canvas.width * 0.75, canvas.height / 2);
}

// 【修改】浮動文字動畫也套用 timeScale 修正
function drawFloatingTexts(timeScale) {
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        let ft = floatingTexts[i];
        ctx.fillStyle = `rgba(46, 204, 113, ${ft.alpha})`;
        ctx.font = 'bold 13px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(ft.text, ft.x, ft.y);
        ft.y -= 0.5 * timeScale;
        ft.alpha -= 0.015 * timeScale;
        if (ft.alpha <= 0) floatingTexts.splice(i, 1);
    }
}

function drawMembrane() {
    const totalThick = parseInt(els.thick.value), surf = parseInt(els.area.value) / 100;
    const center = canvas.width / 2, memThick = 40;
    const outerLeft = center - totalThick / 2, outerRight = center + totalThick / 2;
    const mLeft = center - memThick / 2, mRight = center + memThick / 2;
    const mucusWidth = (totalThick - memThick) / 2;

    const mHeight = canvas.height * surf, mTop = (canvas.height - mHeight) / 2, mBottom = mTop + mHeight;

    ctx.fillStyle = '#576574';
    if (mTop > 0) ctx.fillRect(outerLeft, 0, totalThick, mTop);
    if (mBottom < canvas.height) ctx.fillRect(outerLeft, mBottom, totalThick, canvas.height - mBottom);

    if (mucusWidth > 0) {
        ctx.fillStyle = 'rgba(189, 195, 199, 0.15)';
        ctx.fillRect(outerLeft, mTop, mucusWidth, mHeight);
        ctx.fillRect(mRight, mTop, mucusWidth, mHeight);
    }

    let pType = els.prType.value, pCount = parseInt(els.prCount.value), cy = [];
    if (pCount > 0 && pType !== 'none') { const sp = mHeight / (pCount + 1); for (let i = 1; i <= pCount; i++) cy.push(mTop + sp * i); }

    ctx.strokeStyle = '#c8d6e5'; ctx.lineWidth = 1.5;
    for (let y = mTop + 8; y < mBottom - 8; y += 18) {
        if (cy.some(c => Math.abs(c - y) < 26)) continue;
        ctx.fillStyle = '#feca57';
        ctx.beginPath(); ctx.arc(mLeft, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mLeft + 6, y - 2); ctx.lineTo(center - 2, y - 2); ctx.moveTo(mLeft + 6, y + 2); ctx.lineTo(center - 2, y + 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(mRight, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mRight - 6, y - 2); ctx.lineTo(center + 2, y - 2); ctx.moveTo(mRight - 6, y + 2); ctx.lineTo(center + 2, y + 2); ctx.stroke();
    }

    ctx.lineWidth = 3;
    cy.forEach(y => {
        let hOut = 24, hMidClose = 6, hMidOpen = 16;
        let cx = center, lX = mLeft - 4, rX = mRight + 4;

        if (pType === 'aquaporin' || pType === 'na_channel') {
            ctx.strokeStyle = pType === 'aquaporin' ? '#00a8ff' : '#e67e22';
            ctx.beginPath(); ctx.moveTo(lX, y - hOut); ctx.lineTo(lX, y + hOut); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(rX, y - hOut); ctx.lineTo(rX, y + hOut); ctx.stroke();
            ctx.fillStyle = pType === 'aquaporin' ? 'rgba(0, 168, 255, 0.15)' : 'rgba(230, 126, 34, 0.15)';
            ctx.fillRect(lX, y - hOut, memThick + 8, hOut * 2);
        }
        else if (pType === 'glucose_carrier' || pType === 'aa_carrier') {
            ctx.strokeStyle = pType === 'glucose_carrier' ? '#2ecc71' : '#f1c40f';
            let occupant = particles.find(p => p.cfg.reqChannel === pType && p.x > mLeft && p.x < mRight && Math.abs(p.y - y) < 22);

            if (!occupant) {
                ctx.beginPath(); ctx.moveTo(lX, y - hOut); ctx.lineTo(cx, y - hMidClose); ctx.lineTo(rX, y - hOut); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(lX, y + hOut); ctx.lineTo(cx, y + hMidClose); ctx.lineTo(rX, y + hOut); ctx.stroke();
            } else {
                let progress = (occupant.x - mLeft) / memThick;
                if (progress < 0.35) {
                    ctx.beginPath(); ctx.moveTo(lX, y - hOut); ctx.lineTo(cx, y - hMidOpen); ctx.lineTo(rX, y - hMidOpen); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(lX, y + hOut); ctx.lineTo(cx, y + hMidOpen); ctx.lineTo(rX, y + hMidOpen); ctx.stroke();
                } else if (progress > 0.65) {
                    ctx.beginPath(); ctx.moveTo(lX, y - hMidOpen); ctx.lineTo(cx, y - hMidOpen); ctx.lineTo(rX, y - hOut); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(lX, y + hMidOpen); ctx.lineTo(cx, y + hMidOpen); ctx.lineTo(rX, y + hOut); ctx.stroke();
                } else {
                    ctx.beginPath(); ctx.moveTo(lX, y - hMidOpen); ctx.lineTo(rX, y - hMidOpen); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(lX, y + hMidOpen); ctx.lineTo(rX, y + hMidOpen); ctx.stroke();
                }
            }
        }
    });
}

function updateAnalytics() {
    if (!initRateDone && simTimeMs >= 5000) {
        initRateDone = true;
        let rate = (crossLR_5s - crossRL_5s) / 5;
        els.initRate.innerText = rate.toFixed(1) + " 粒/秒";
        els.initRate.style.color = "#27ae60";
    } else if (!initRateDone) {
        els.initRate.innerText = `計算中... (${Math.floor(simTimeMs / 1000)}/5s)`;
        els.initRate.style.color = "#2980b9";
    }
}

function updateCharts() {
    let tSec = Math.floor(simTimeMs / 1000);
    let net = crossLR_1s - crossRL_1s;

    els.statLR.innerText = crossLR_1s;
    els.statRL.innerText = crossRL_1s;
    els.statNet.innerText = `左至右的淨移動：${net}`;
    els.statNet.style.color = net !== 0 ? '#e74c3c' : '#495057';

    crossLR_1s = 0; crossRL_1s = 0;

    qtyChart.data.labels.push(tSec);
    qtyChart.data.datasets[0].data.push(globalLCount);
    qtyChart.data.datasets[1].data.push(globalRCount);
    qtyChart.update();
}

function animate(timestamp) {
    if (!isRunning) return;
    if (!lastTimestamp) lastTimestamp = timestamp;
    let dt = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // 【修改】計算 TimeScale (標準 60Hz 螢幕每幀約 16.66ms，這可以確保在 120Hz 下速度一致)
    let timeScale = dt / 16.666;

    simTimeMs += dt; chartUpdateAccumulator += dt;

    globalLCount = particles.filter(p => p.currentSide === 'left').length;
    globalRCount = particles.length - globalLCount;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackgroundNumbers();
    drawMembrane();

    const speedMult = 0.1 + (parseInt(els.temp.value) / 100) * 1.9;
    particles.forEach(p => { p.update(speedMult, timeScale); p.draw(ctx); });

    drawFloatingTexts(timeScale);
    updateAnalytics();

    if (chartUpdateAccumulator >= 1000) {
        updateCharts();
        chartUpdateAccumulator -= 1000;
    }
    animationId = requestAnimationFrame(animate);
}

function initSystem(saveGhost = false) {
    let totalParticles = parseInt(els.lCount.value) + parseInt(els.rCount.value);
    qtyChart.options.scales.y.max = totalParticles > 0 ? totalParticles : 10;

    if (saveGhost && simTimeMs > 1000) {
        let ghostQtyL = { ...qtyChart.data.datasets[0] };
        ghostQtyL.label = '前次左側'; ghostQtyL.borderColor = 'rgba(52, 152, 219, 0.3)'; ghostQtyL.borderWidth = 1.5; ghostQtyL.borderDash = [5, 5]; ghostQtyL.data = [...qtyChart.data.datasets[0].data];
        let ghostQtyR = { ...qtyChart.data.datasets[1] };
        ghostQtyR.label = '前次右側'; ghostQtyR.borderColor = 'rgba(243, 156, 18, 0.3)'; ghostQtyR.borderWidth = 1.5; ghostQtyR.borderDash = [5, 5]; ghostQtyR.data = [...qtyChart.data.datasets[1].data];
        qtyChart.data.datasets = [qtyChart.data.datasets[0], qtyChart.data.datasets[1], ghostQtyL, ghostQtyR];
    } else if (!saveGhost) {
        qtyChart.data.datasets = [qtyChart.data.datasets[0], qtyChart.data.datasets[1]];
    }

    particles = [];
    floatingTexts = [];
    for (let i = 0; i < parseInt(els.lCount.value); i++) particles.push(new Particle('left', els.pType.value));
    for (let i = 0; i < parseInt(els.rCount.value); i++) particles.push(new Particle('right', els.pType.value));

    simTimeMs = 0; lastTimestamp = 0; chartUpdateAccumulator = 0;
    crossLR_1s = 0; crossRL_1s = 0; crossLR_5s = 0; crossRL_5s = 0;

    initRateDone = false;
    els.initRate.innerText = "等待開始..."; els.initRate.style.color = "#2980b9";
    els.statLR.innerText = 0; els.statRL.innerText = 0;
    els.statNet.innerText = "左至右的淨移動：0"; els.statNet.style.color = '#495057';

    globalLCount = particles.filter(p => p.currentSide === 'left').length;
    globalRCount = particles.length - globalLCount;

    qtyChart.data.labels = [0];
    qtyChart.data.datasets[0].data = [els.lCount.value];
    qtyChart.data.datasets[1].data = [els.rCount.value];
    qtyChart.update();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackgroundNumbers(); drawMembrane(); particles.forEach(p => p.draw(ctx));
}

['lCount', 'rCount', 'thick', 'area', 'prCount'].forEach(id => els[id].addEventListener('input', (e) => {
    let targetId = valIds[id];
    if (document.getElementById(targetId)) document.getElementById(targetId).innerText = e.target.value;
    if (id === 'area' || id === 'prCount') updateProteinLimit();
    if (!isRunning) {
        if (['thick', 'area', 'prCount'].includes(id)) {
            ctx.clearRect(0, 0, canvas.width, canvas.height); drawBackgroundNumbers(); drawMembrane(); particles.forEach(p => p.draw(ctx));
        } else initSystem(false);
    }
}));

['pType', 'prType'].forEach(id => els[id].addEventListener('change', () => {
    updateCarrierTip();
    if (!isRunning) {
        if (id === 'prType') {
            ctx.clearRect(0, 0, canvas.width, canvas.height); drawBackgroundNumbers(); drawMembrane(); particles.forEach(p => p.draw(ctx));
        } else initSystem(false);
    }
}));

els.temp.addEventListener('input', (e) => document.getElementById(valIds.temp).innerText = e.target.value);

document.getElementById('startBtn').addEventListener('click', () => { if (!isRunning) { isRunning = true; lastTimestamp = performance.now(); animate(performance.now()); } });
document.getElementById('pauseBtn').addEventListener('click', () => { isRunning = false; cancelAnimationFrame(animationId); });
document.getElementById('resetBtn').addEventListener('click', () => { isRunning = false; cancelAnimationFrame(animationId); initSystem(true); });

updateProteinLimit();
initSystem(false);
