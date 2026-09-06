/* ============================================================
   BI-A 8 BI — 2 NGƯỜI CHƠI QUA P2P (PeerJS / WebRTC)
   Vật lý & luật chơi xử lý ở "chủ phòng" (host); khách (guest)
   gửi lệnh đánh/chat/media và nhận trạng thái bàn để hiển thị.
   ============================================================ */

/* ===================== CẤU HÌNH & HẰNG SỐ ===================== */
const CFG = {
  W: 1000, H: 500,
  BALL_R: 14,
  POCKET_R: 27,
  FRICTION: 0.994,
  MIN_SPEED: 0.045,
  WALL_RESTITUTION: 0.86,
  BALL_RESTITUTION: 0.98,
  MAX_SHOT_SPEED: 24,
  SUBSTEPS: 6,
  MAX_DRAG: 190,
};

const RAIL = 30;

const BALL_COLORS = {
  1:'#e6c619', 2:'#1c4fd6', 3:'#d61c1c', 4:'#7a1cd6', 5:'#e0791a',
  6:'#1c8f3d', 7:'#7a3b1c', 8:'#111111',
  9:'#e6c619', 10:'#1c4fd6', 11:'#d61c1c', 12:'#7a1cd6', 13:'#e0791a',
  14:'#1c8f3d', 15:'#7a3b1c'
};
function isStripe(n){ return n>=9 && n<=15; }
function ballGroup(n){ if(n===8) return 'eight'; return isStripe(n) ? 'stripe' : 'solid'; }
function groupLabel(g){
  if(g==='solid') return 'Bi trơn (1-7)';
  if(g==='stripe') return 'Bi sọc (9-15)';
  return 'Chưa xác định';
}

/* ===================== VỊ TRÍ BÀN & LỖ ===================== */
const TABLE = {
  x0: RAIL, y0: RAIL, x1: CFG.W - RAIL, y1: CFG.H - RAIL,
};
const POCKETS = [
  {x: TABLE.x0, y: TABLE.y0},
  {x: (TABLE.x0+TABLE.x1)/2, y: TABLE.y0 - 5},
  {x: TABLE.x1, y: TABLE.y0},
  {x: TABLE.x0, y: TABLE.y1},
  {x: (TABLE.x0+TABLE.x1)/2, y: TABLE.y1 + 5},
  {x: TABLE.x1, y: TABLE.y1},
];

/* ===================== TRẠNG THÁI TOÀN CỤC ===================== */
let myId = null;          // 'p1' (host) hoặc 'p2' (guest)
let isHost = false;
let peer = null;
let conn = null;
let roomCode = null;

let players = {
  p1: { name:'Người chơi 1', group:null },
  p2: { name:'Người chơi 2', group:null },
};

let balls = [];
let turn = 'p1';
let groupsOpen = true;
let ballInHandFor = null;
let gameOver = false;
let winner = null;
let isBreakShot = true;
let logMessages = [];

let shotCtx = null;
let simRunning = false;

let aiming = false;
let aimStart = {x:0,y:0};
let aimCurrent = {x:0,y:0};

let manualAngleDeg = 0;
let manualPowerPct = 50;

/* ===================== MEDIA (MIC/CAM) ===================== */
let micOn = false;
let camOn = false;
let localStream = null;
let outgoingMediaConn = null;
let incomingMediaConn = null;

/* ===================== ÂM THANH ===================== */
let audioCtxRef = null;
function ensureAudioCtx(){
  if(!audioCtxRef){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(AC) audioCtxRef = new AC();
  }
  return audioCtxRef;
}
function playTone(freq, dur, type, vol){
  try{
    const ac = ensureAudioCtx();
    if(!ac) return;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol==null?0.15:vol;
    osc.connect(gain); gain.connect(ac.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    osc.stop(ac.currentTime + dur + 0.02);
  }catch(e){ /* âm thanh không hỗ trợ, bỏ qua */ }
}
function sfxShoot(){ playTone(150,0.06,'square',0.15); }
function sfxHit(){ playTone(280,0.05,'triangle',0.12); }
function sfxPocket(){ playTone(650,0.12,'sine',0.22); setTimeout(()=>playTone(950,0.1,'sine',0.14),60); }
function sfxFoul(){ playTone(130,0.28,'sawtooth',0.18); }
function sfxWin(){ [660,880,1100].forEach((f,i)=>setTimeout(()=>playTone(f,0.25,'sine',0.2), i*140)); }
function sfxLose(){ [440,349,262].forEach((f,i)=>setTimeout(()=>playTone(f,0.3,'sine',0.18), i*160)); }
function playEvents(events){
  if(!events) return;
  if(events.includes('foul')) sfxFoul();
  else if(events.includes('pocket')) sfxPocket();
  if(events.includes('win')) sfxWin();
  if(events.includes('lose')) sfxLose();
}

/* ===================== KHỞI TẠO BÓNG (RACK) ===================== */
function createInitialBalls(){
  const r = CFG.BALL_R;
  const headX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.25;
  const footX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.75;
  const midY = (TABLE.y0+TABLE.y1)/2;

  const arr = [];
  arr.push({num:0, x:headX, y:midY, vx:0, vy:0, potted:false});

  const rows = [
    [1],
    [9,2],
    [10,8,3],
    [4,11,5,12],
    [6,13,7,14,15]
  ];
  const dx = r*1.75;
  const dy = r*2.02;
  for(let row=0; row<rows.length; row++){
    const count = rows[row].length;
    for(let i=0;i<count;i++){
      const num = rows[row][i];
      const x = footX + row*dx;
      const y = midY - row*(dy/2) + i*dy;
      arr.push({num, x, y, vx:0, vy:0, potted:false});
    }
  }
  return arr;
}

function resetGameState(){
  balls = createInitialBalls();
  players.p1.group = null;
  players.p2.group = null;
  groupsOpen = true;
  ballInHandFor = null;
  gameOver = false;
  winner = null;
  isBreakShot = true;
  turn = 'p1';
  logMessages = [];
  addLog('Ván mới bắt đầu. ' + players.p1.name + ' giao bóng.');
}

function addLog(msg){
  logMessages.push(msg);
  if(logMessages.length>50) logMessages.shift();
  renderLog();
}

/* ===================== VẬT LÝ ===================== */
function cueBallOnTable(){ return balls.find(b=>b.num===0 && !b.potted); }
function cueBallAny(){ return balls.find(b=>b.num===0); }

function anyBallMoving(){
  for(const b of balls){
    if(b.potted) continue;
    if(Math.abs(b.vx) > CFG.MIN_SPEED || Math.abs(b.vy) > CFG.MIN_SPEED) return true;
  }
  return false;
}

function stepPhysics(){
  const sub = CFG.SUBSTEPS;
  for(let s=0; s<sub; s++){
    for(const b of balls){
      if(b.potted) continue;
      b.x += b.vx/sub;
      b.y += b.vy/sub;
    }
    for(const b of balls){
      if(b.potted) continue;
      const r = CFG.BALL_R;
      if(b.x - r < TABLE.x0){ b.x = TABLE.x0 + r; b.vx = -b.vx*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.x + r > TABLE.x1){ b.x = TABLE.x1 - r; b.vx = -b.vx*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.y - r < TABLE.y0){ b.y = TABLE.y0 + r; b.vy = -b.vy*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.y + r > TABLE.y1){ b.y = TABLE.y1 - r; b.vy = -b.vy*CFG.WALL_RESTITUTION; onRailContact(b); }
    }
    for(let i=0;i<balls.length;i++){
      const a = balls[i];
      if(a.potted) continue;
      for(let j=i+1;j<balls.length;j++){
        const b = balls[j];
        if(b.potted) continue;
        resolveBallCollision(a,b);
      }
    }
    for(const b of balls){
      if(b.potted) continue;
      for(const p of POCKETS){
        const dx = b.x-p.x, dy = b.y-p.y;
        if(Math.sqrt(dx*dx+dy*dy) < CFG.POCKET_R - 2){
          onBallPotted(b);
          break;
        }
      }
    }
  }
  for(const b of balls){
    if(b.potted) continue;
    b.vx *= CFG.FRICTION;
    b.vy *= CFG.FRICTION;
    if(Math.abs(b.vx) < CFG.MIN_SPEED) b.vx = 0;
    if(Math.abs(b.vy) < CFG.MIN_SPEED) b.vy = 0;
  }
}

function resolveBallCollision(a,b){
  const r = CFG.BALL_R*2;
  const dx = b.x-a.x, dy = b.y-a.y;
  const dist = Math.sqrt(dx*dx+dy*dy);
  if(dist===0 || dist>=r) return;

  const overlap = (r-dist)/2;
  const nx = dx/dist, ny = dy/dist;
  a.x -= nx*overlap; a.y -= ny*overlap;
  b.x += nx*overlap; b.y += ny*overlap;

  if(shotCtx){
    if(a.num===0 && b.num!==0 && shotCtx.firstContact===null) { shotCtx.firstContact = b.num; sfxHit(); }
    if(b.num===0 && a.num!==0 && shotCtx.firstContact===null) { shotCtx.firstContact = a.num; sfxHit(); }
  }

  const rvx = b.vx-a.vx, rvy = b.vy-a.vy;
  const velAlongNormal = rvx*nx + rvy*ny;
  if(velAlongNormal > 0) return;

  const restitution = CFG.BALL_RESTITUTION;
  const j = -(1+restitution)*velAlongNormal / 2;
  const ix = j*nx, iy = j*ny;
  a.vx -= ix; a.vy -= iy;
  b.vx += ix; b.vy += iy;
}

function onRailContact(ball){
  if(shotCtx && shotCtx.firstContact!==null){
    shotCtx.railAfterContact = true;
  }
  if(shotCtx && shotCtx.isBreak){
    shotCtx.railTouchSet.add(ball.num);
  }
}

function onBallPotted(ball){
  ball.potted = true;
  ball.vx = 0; ball.vy = 0;
  if(!shotCtx) return;
  if(ball.num===0){
    shotCtx.scratch = true;
  } else if(ball.num===8){
    shotCtx.eightPotted = true;
  } else {
    shotCtx.pocketed.push(ball.num);
  }
}

/* ===================== BẮT ĐẦU 1 CÚ ĐÁNH (HOST) ===================== */
function beginShot(angle, power){
  const cb = cueBallOnTable();
  if(!cb) return;
  const speed = Math.min(Math.max(power,0), 1) * CFG.MAX_SHOT_SPEED;
  cb.vx = Math.cos(angle)*speed;
  cb.vy = Math.sin(angle)*speed;

  const shooter = turn;
  const shooterGroup = players[shooter].group;
  const shooterHasClearedGroup = shooterGroup && !balls.some(b=>!b.potted && b.num!==0 && b.num!==8 && ballGroup(b.num)===shooterGroup);

  shotCtx = {
    shooter,
    shooterGroupAtStart: shooterGroup,
    shooterClearedAtStart: shooterHasClearedGroup,
    groupsOpenAtStart: groupsOpen,
    isBreak: isBreakShot,
    firstContact: null,
    railAfterContact: false,
    railTouchSet: new Set(),
    pocketed: [],
    scratch: false,
    eightPotted: false,
  };
  simRunning = true;
}

/* ===================== KẾT THÚC CÚ ĐÁNH & ÁP LUẬT (HOST) ===================== */
function resolveShotEnd(){
  const ctx = shotCtx;
  const shooter = ctx.shooter;
  const opponent = shooter==='p1' ? 'p2' : 'p1';
  let foul = false;
  let reasons = [];
  const events = [];

  if(ctx.scratch){ foul = true; reasons.push('bi cái vào lỗ (phạm luật)'); }
  if(ctx.firstContact===null){ foul = true; reasons.push('không chạm bi nào'); }

  if(!foul && !ctx.groupsOpenAtStart){
    const requiredGroup = ctx.shooterClearedAtStart ? 'eight' : ctx.shooterGroupAtStart;
    const contactGroup = ballGroup(ctx.firstContact);
    if(contactGroup !== requiredGroup){
      foul = true;
      reasons.push('chạm sai nhóm bi (phải đánh trúng ' + (requiredGroup==='eight' ? 'bi số 8' : groupLabel(requiredGroup)) + ' trước)');
    }
  }

  if(!foul && ctx.pocketed.length===0 && !ctx.eightPotted){
    if(ctx.isBreak){
      if(ctx.railTouchSet.size < 4){ foul = true; reasons.push('giao bóng không hợp lệ (chưa đủ 4 bi chạm băng)'); }
    } else if(!ctx.railAfterContact){
      foul = true; reasons.push('không có bi/băng nào được chạm sau va chạm');
    }
  }

  if(ctx.pocketed.length>0) events.push('pocket');
  if(foul) events.push('foul');

  if(groupsOpen){
    const potTypes = new Set(ctx.pocketed.map(n=>ballGroup(n)));
    if(potTypes.size===1){
      const g = [...potTypes][0];
      players[shooter].group = g;
      players[opponent].group = g==='solid' ? 'stripe' : 'solid';
      groupsOpen = false;
      addLog(players[shooter].name + ' được xác định nhóm: ' + groupLabel(g));
    }
  }

  if(ctx.eightPotted){
    const shooterGroupFinal = players[shooter].group;
    const groupCleared = shooterGroupFinal && !balls.some(b=>!b.potted && b.num!==0 && b.num!==8 && ballGroup(b.num)===shooterGroupFinal);
    gameOver = true;
    if(!groupCleared){
      winner = opponent;
      addLog('☠️ ' + players[shooter].name + ' đánh bi số 8 vào lỗ quá sớm — thua cuộc!');
    } else if(foul){
      winner = opponent;
      addLog('☠️ ' + players[shooter].name + ' phạm luật khi đánh bi số 8 — thua cuộc!');
    } else {
      winner = shooter;
      addLog('🏆 ' + players[shooter].name + ' thắng cuộc!');
    }
    events.push(winner===myId ? 'win' : 'lose');
    finalizeAfterShot(events);
    return;
  }

  if(foul){
    addLog('⚠️ Phạm luật: ' + reasons.join(', ') + '. ' + players[opponent].name + ' được đặt bi cái tự do.');
    turn = opponent;
    ballInHandFor = opponent;
  } else {
    const pottedOwn = ctx.pocketed.some(n=>{
      const g = players[shooter].group;
      return g && ballGroup(n)===g;
    });
    if(pottedOwn){
      addLog(players[shooter].name + ' đánh trúng bi, tiếp tục lượt.');
      turn = shooter;
    } else {
      if(ctx.pocketed.length>0){
        addLog(players[shooter].name + ' đánh vào bi của đối thủ, chuyển lượt.');
      } else {
        addLog(players[shooter].name + ' không có bi vào lỗ, chuyển lượt.');
      }
      turn = opponent;
    }
    ballInHandFor = null;
  }

  isBreakShot = false;
  finalizeAfterShot(events);
}

function finalizeAfterShot(events){
  shotCtx = null;
  simRunning = false;
  playEvents(events);
  broadcastState(events);
  updateHUD();
  if(gameOver) showEndScreen();
}

/* ===================== VÒNG LẶP CHÍNH ===================== */
function mainLoop(){
  requestAnimationFrame(mainLoop);
  if(isHost && !gameOver){
    if(simRunning){
      stepPhysics();
      if(!anyBallMoving()){
        resolveShotEnd();
      } else {
        broadcastState();
      }
    }
  }
  renderFrame();
}

/* ===================== MÃ PHÒNG NGẮN (3 CHỮ SỐ) ===================== */
function randomRoomCode(){
  return String(Math.floor(Math.random()*1000)).padStart(3,'0');
}

/* ===================== MẠNG (PEERJS) ===================== */
function setupPeerAsHost(attempt){
  attempt = attempt || 0;
  roomCode = randomRoomCode();
  peer = new Peer(roomCode);
  peer.on('open', id=>{
    document.getElementById('room-code-text').textContent = id;
  });
  peer.on('connection', c=>{
    conn = c;
    wireConnection();
    conn.on('open', ()=>{
      goToGameScreen();
      // chờ thông điệp 'hello' của khách (kèm tên) trước khi khởi tạo ván đấu
    });
  });
  registerCallHandler();
  peer.on('error', err=>{
    if(err.type==='unavailable-id' && attempt<10){
      try{ peer.destroy(); }catch(e){}
      setupPeerAsHost(attempt+1);
    } else {
      showMenuError('Lỗi kết nối: ' + err.type);
    }
  });
}

function setupPeerAsGuest(hostId){
  peer = new Peer();
  peer.on('open', ()=>{
    conn = peer.connect(hostId, {reliable:true});
    wireConnection();
    conn.on('open', ()=>{
      conn.send({type:'hello', name: players.p2.name});
      goToGameScreen();
    });
  });
  registerCallHandler();
  peer.on('error', err=>{
    showMenuError('Lỗi kết nối: ' + err.type + ' (kiểm tra lại mã phòng)');
    goToMenu();
  });
}

function registerCallHandler(){
  peer.on('call', call=>{
    if(incomingMediaConn){ try{ incomingMediaConn.close(); }catch(e){} }
    incomingMediaConn = call;
    call.answer(localStream || undefined);
    call.on('stream', remoteStream=>attachRemoteStream(remoteStream));
    call.on('close', ()=>clearRemoteVideo());
  });
}

function wireConnection(){
  conn.on('data', data=>handleData(data));
  conn.on('close', ()=>{
    addLog('⚠️ Đối thủ đã ngắt kết nối.');
  });
  conn.on('error', err=>{
    console.error('conn error', err);
  });
}

function handleData(data){
  if(!data || !data.type) return;
  switch(data.type){
    case 'hello':
      players.p2.name = data.name || players.p2.name;
      resetGameState();
      broadcastInit();
      break;
    case 'init':
      players = data.players;
      balls = data.balls;
      turn = data.turn;
      groupsOpen = data.groupsOpen;
      ballInHandFor = data.ballInHandFor;
      gameOver = data.gameOver;
      winner = data.winner;
      isBreakShot = data.isBreakShot;
      logMessages = data.logMessages;
      renderLog();
      updateHUD();
      goToGameScreen();
      break;
    case 'state':
      balls = data.balls;
      turn = data.turn;
      groupsOpen = data.groupsOpen;
      ballInHandFor = data.ballInHandFor;
      gameOver = data.gameOver;
      winner = data.winner;
      players = data.players;
      if(data.logMessages){ logMessages = data.logMessages; renderLog(); }
      if(data.events && data.events.length) playEvents(data.events);
      updateHUD();
      if(gameOver) showEndScreen();
      break;
    case 'shoot':
      if(isHost && !simRunning && !gameOver && turn===data.from && !ballInHandFor){
        beginShot(data.angle, data.power);
      }
      break;
    case 'placeCueBall':
      if(isHost && !simRunning && !gameOver && ballInHandFor===data.from){
        placeCueBallHost(data.x, data.y);
      }
      break;
    case 'chat':
      appendChatMessage(data.from, data.text, false);
      break;
    case 'requestRematch':
      if(isHost){
        resetGameState();
        broadcastInit();
        goToGameScreen();
      }
      break;
  }
}

function broadcastInit(){
  if(!isHost || !conn || !conn.open) return;
  conn.send({type:'init', players, balls, turn, groupsOpen, ballInHandFor, gameOver, winner, isBreakShot, logMessages});
  updateHUD();
}

function broadcastState(events){
  if(!isHost || !conn || !conn.open) return;
  conn.send({type:'state', balls, turn, groupsOpen, ballInHandFor, gameOver, winner, players, logMessages, events});
}

/* ===================== ĐẶT BI CÁI (BALL-IN-HAND) — ĐÃ SỬA LỖI ===================== */
function isValidCuePlacement(x,y){
  const r = CFG.BALL_R;
  if(x-r<TABLE.x0 || x+r>TABLE.x1 || y-r<TABLE.y0 || y+r>TABLE.y1) return false;
  for(const b of balls){
    if(b.potted || b.num===0) continue;
    const dx=b.x-x, dy=b.y-y;
    if(Math.sqrt(dx*dx+dy*dy) < CFG.BALL_R*2) return false;
  }
  return true;
}
function placeCueBallHost(x,y){
  if(!isValidCuePlacement(x,y)) return false;
  const cb = cueBallAny(); // lấy bi cái BẤT KỂ đã rơi lỗ hay chưa — đây là chỗ sửa lỗi chính
  if(!cb) return false;
  cb.x = x; cb.y = y; cb.vx = 0; cb.vy = 0;
  cb.potted = false; // đưa bi cái trở lại bàn
  ballInHandFor = null;
  broadcastState();
  updateHUD();
  return true;
}

/* ===================== INPUT: NGẮM & BẮN ===================== */
const canvas = document.getElementById('table');
const ctx2d = canvas.getContext('2d');
const angleSlider = document.getElementById('angle-slider');
const powerSlider = document.getElementById('power-slider');
const angleValueEl = document.getElementById('angle-value');
const powerValueEl = document.getElementById('power-value');

function myTurn(){ return turn===myId && !gameOver; }
function iHaveBallInHand(){ return ballInHandFor===myId && !gameOver; }
function canAimNow(){ return myTurn() && !simRunning && !iHaveBallInHand(); }

function canvasPos(evt){
  const rect = canvas.getBoundingClientRect();
  const scaleX = CFG.W/rect.width, scaleY = CFG.H/rect.height;
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  return { x:(clientX-rect.left)*scaleX, y:(clientY-rect.top)*scaleY };
}

function normalizeDeg(d){ return ((d%360)+360)%360; }

function updateSliderReadouts(){
  angleValueEl.textContent = Math.round(manualAngleDeg) + '°';
  powerValueEl.textContent = Math.round(manualPowerPct) + '%';
  const pct = manualPowerPct;
  powerSlider.style.background = 'linear-gradient(0deg, var(--accent) '+pct+'%, #ffffff22 '+pct+'%)';
}

function pointerDown(evt){
  evt.preventDefault();
  const pos = canvasPos(evt);
  if(iHaveBallInHand()){
    if(isValidCuePlacement(pos.x,pos.y)){
      if(isHost){
        placeCueBallHost(pos.x,pos.y);
      } else {
        conn && conn.send({type:'placeCueBall', x:pos.x, y:pos.y, from:myId});
      }
    }
    return;
  }
  if(!canAimNow()) return;
  const cb = cueBallOnTable();
  if(!cb) return;
  aiming = true;
  aimStart = pos;
  aimCurrent = pos;
}
function pointerMove(evt){
  if(!aiming) return;
  evt.preventDefault();
  aimCurrent = canvasPos(evt);
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const dragDist = Math.min(Math.sqrt(dx*dx+dy*dy), CFG.MAX_DRAG);
  const deg = normalizeDeg(Math.atan2(dy,dx)*180/Math.PI);
  manualAngleDeg = deg;
  manualPowerPct = (dragDist/CFG.MAX_DRAG)*100;
  angleSlider.value = Math.round(deg);
  powerSlider.value = Math.round(manualPowerPct);
  updateSliderReadouts();
}
function pointerUp(evt){
  if(!aiming) return;
  evt.preventDefault();
  aiming = false;
  const cb = cueBallOnTable();
  if(!cb) return;
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const dragDist = Math.sqrt(dx*dx+dy*dy);
  if(dragDist < 6) return;
  const angle = Math.atan2(dy, dx);
  const power = Math.min(dragDist, CFG.MAX_DRAG) / CFG.MAX_DRAG;
  fireShot(angle, power);
}

function fireShot(angle, power){
  if(power<=0.02) return;
  sfxShoot();
  if(isHost){
    if(turn===myId && !simRunning && !ballInHandFor) beginShot(angle, power);
  } else {
    conn && conn.send({type:'shoot', angle, power, from:myId});
  }
}

canvas.addEventListener('mousedown', pointerDown);
window.addEventListener('mousemove', pointerMove);
window.addEventListener('mouseup', pointerUp);
canvas.addEventListener('touchstart', pointerDown, {passive:false});
canvas.addEventListener('touchmove', pointerMove, {passive:false});
canvas.addEventListener('touchend', pointerUp, {passive:false});

angleSlider.addEventListener('input', ()=>{
  manualAngleDeg = Number(angleSlider.value);
  updateSliderReadouts();
});
powerSlider.addEventListener('input', ()=>{
  manualPowerPct = Number(powerSlider.value);
  updateSliderReadouts();
});
document.getElementById('btn-shoot').addEventListener('click', ()=>{
  if(!canAimNow()) return;
  const angle = manualAngleDeg * Math.PI/180;
  const power = manualPowerPct/100;
  fireShot(angle, power);
});

/* ===================== VẼ (RENDER) ===================== */
function renderFrame(){
  drawTable();
  drawPockets();
  drawBalls();
  drawAimGuide();
}

function drawTable(){
  ctx2d.clearRect(0,0,CFG.W,CFG.H);
  const grad = ctx2d.createRadialGradient(CFG.W/2,CFG.H/2,60,CFG.W/2,CFG.H/2,CFG.W/1.3);
  grad.addColorStop(0,'#0e7a42');
  grad.addColorStop(1,'#0a5029');
  ctx2d.fillStyle = grad;
  ctx2d.fillRect(TABLE.x0,TABLE.y0,TABLE.x1-TABLE.x0,TABLE.y1-TABLE.y0);
  ctx2d.strokeStyle = '#ffffff22';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo((TABLE.x0+TABLE.x1)/2, TABLE.y0);
  ctx2d.lineTo((TABLE.x0+TABLE.x1)/2, TABLE.y1);
  ctx2d.stroke();
  const headX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.25;
  ctx2d.fillStyle = '#ffffff55';
  ctx2d.beginPath(); ctx2d.arc(headX, (TABLE.y0+TABLE.y1)/2, 3, 0, Math.PI*2); ctx2d.fill();
}

function drawPockets(){
  for(const p of POCKETS){
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, CFG.POCKET_R, 0, Math.PI*2);
    ctx2d.fillStyle = '#000000';
    ctx2d.fill();
    ctx2d.strokeStyle = '#00000088';
    ctx2d.lineWidth = 3;
    ctx2d.stroke();
  }
}

function drawBalls(){
  for(const b of balls){
    if(b.potted) continue;
    drawOneBall(b);
  }
}

function drawOneBall(b){
  const r = CFG.BALL_R;
  ctx2d.save();
  ctx2d.translate(b.x,b.y);

  ctx2d.beginPath();
  ctx2d.ellipse(1.5,3,r*0.9,r*0.5,0,0,Math.PI*2);
  ctx2d.fillStyle = '#00000044';
  ctx2d.fill();

  if(b.num===0){
    ctx2d.beginPath();
    ctx2d.arc(0,0,r,0,Math.PI*2);
    const g = ctx2d.createRadialGradient(-3,-3,1,0,0,r);
    g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#dcdcdc');
    ctx2d.fillStyle = g;
    ctx2d.fill();
    ctx2d.strokeStyle = '#00000022'; ctx2d.lineWidth=1; ctx2d.stroke();
  } else {
    const color = BALL_COLORS[b.num];
    ctx2d.beginPath();
    ctx2d.arc(0,0,r,0,Math.PI*2);
    ctx2d.fillStyle = isStripe(b.num) ? '#f5f0e6' : color;
    ctx2d.fill();

    if(isStripe(b.num)){
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(0,0,r,0,Math.PI*2);
      ctx2d.clip();
      ctx2d.fillStyle = color;
      ctx2d.fillRect(-r, -r*0.55, r*2, r*1.1);
      ctx2d.restore();
    }
    ctx2d.beginPath();
    ctx2d.arc(0,0,r*0.55,0,Math.PI*2);
    ctx2d.fillStyle = '#f5f0e6';
    ctx2d.fill();
    ctx2d.fillStyle = '#111';
    ctx2d.font = 'bold '+(r*0.65)+'px Arial';
    ctx2d.textAlign='center'; ctx2d.textBaseline='middle';
    ctx2d.fillText(b.num, 0, 0.5);

    ctx2d.beginPath();
    ctx2d.arc(0,0,r,0,Math.PI*2);
    ctx2d.strokeStyle = '#00000033'; ctx2d.lineWidth=1; ctx2d.stroke();
  }
  ctx2d.beginPath();
  ctx2d.arc(-r*0.35,-r*0.35,r*0.3,0,Math.PI*2);
  ctx2d.fillStyle = '#ffffff55';
  ctx2d.fill();

  ctx2d.restore();
}

function currentAimAngleRad(){
  if(aiming){
    const dx=aimStart.x-aimCurrent.x, dy=aimStart.y-aimCurrent.y;
    return Math.atan2(dy,dx);
  }
  return manualAngleDeg*Math.PI/180;
}

function drawAimGuide(){
  if(iHaveBallInHand()){
    canvas.style.cursor = 'copy';
    return;
  }
  const active = canAimNow();
  canvas.style.cursor = active ? 'crosshair' : 'default';
  if(!active) return;
  const cb = cueBallOnTable();
  if(!cb) return;

  const angle = currentAimAngleRad();
  const pull = aiming
    ? Math.min(Math.sqrt((aimStart.x-aimCurrent.x)**2 + (aimStart.y-aimCurrent.y)**2), CFG.MAX_DRAG)
    : (manualPowerPct/100)*CFG.MAX_DRAG;
  const len = 1300;

  ctx2d.save();
  ctx2d.strokeStyle = '#ffffffaa';
  ctx2d.lineWidth = 1.5;
  ctx2d.setLineDash([6,6]);
  ctx2d.beginPath();
  ctx2d.moveTo(cb.x, cb.y);
  ctx2d.lineTo(cb.x + Math.cos(angle)*len, cb.y + Math.sin(angle)*len);
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  ctx2d.strokeStyle = '#c99a5b';
  ctx2d.lineWidth = 6;
  ctx2d.lineCap = 'round';
  ctx2d.beginPath();
  ctx2d.moveTo(cb.x - Math.cos(angle)*(pull+22), cb.y - Math.sin(angle)*(pull+22));
  ctx2d.lineTo(cb.x - Math.cos(angle)*(pull+5), cb.y - Math.sin(angle)*(pull+5));
  ctx2d.stroke();
  ctx2d.restore();
}

/* ===================== HUD / GIAO DIỆN ===================== */
function updateHUD(){
  document.getElementById('name-p1').textContent = players.p1.name;
  document.getElementById('name-p2').textContent = players.p2.name;
  document.getElementById('group-p1').textContent = groupLabel(players.p1.group);
  document.getElementById('group-p2').textContent = groupLabel(players.p2.group);

  document.getElementById('badge-p1').classList.toggle('active-turn', turn==='p1' && !gameOver);
  document.getElementById('badge-p2').classList.toggle('active-turn', turn==='p2' && !gameOver);

  const turnEl = document.getElementById('turn-indicator');
  if(gameOver){
    turnEl.textContent = 'Ván đấu đã kết thúc';
  } else {
    const who = turn===myId ? 'Lượt của bạn' : 'Lượt của ' + players[turn].name;
    turnEl.textContent = who + (isBreakShot ? ' — Giao bóng' : '');
  }

  const biih = document.getElementById('ball-in-hand-indicator');
  if(ballInHandFor && !gameOver){
    biih.classList.remove('hidden');
    biih.textContent = ballInHandFor===myId ? '✋ Đến lượt bạn: nhấp vào bàn để đặt bi cái' : '✋ ' + players[ballInHandFor].name + ' đang đặt lại bi cái';
  } else {
    biih.classList.add('hidden');
  }

  const shootBtn = document.getElementById('btn-shoot');
  shootBtn.disabled = !canAimNow();
}

function renderLog(){
  const el = document.getElementById('game-log');
  el.innerHTML = logMessages.slice(-8).map(m=>'<div>'+escapeHtml(m)+'</div>').join('');
  el.scrollTop = el.scrollHeight;
}
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showEndScreen(){
  setTimeout(()=>{
    showScreen('screen-end');
    const title = document.getElementById('end-title');
    const sub = document.getElementById('end-subtitle');
    if(winner===myId){
      title.textContent = '🏆 Bạn đã thắng!';
    } else {
      title.textContent = '😔 Bạn đã thua';
    }
    sub.textContent = (winner ? players[winner].name + ' chiến thắng ván đấu.' : '');

    document.getElementById('btn-rematch-host').classList.toggle('hidden', !isHost);
    document.getElementById('btn-rematch-guest').classList.toggle('hidden', isHost);
    document.getElementById('btn-rematch-guest').disabled = false;
    document.getElementById('rematch-wait-msg').classList.add('hidden');
  }, 900);
}

/* ===================== ĐIỀU HƯỚNG MÀN HÌNH ===================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function goToMenu(){ showScreen('screen-menu'); }
function goToGameScreen(){ showScreen('screen-game'); updateHUD(); updateSliderReadouts(); }
function showMenuError(msg){ document.getElementById('menu-error').textContent = msg; }

/* ===================== CHAT ===================== */
function sendChat(){
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  appendChatMessage(myId, text, true);
  conn && conn.send({type:'chat', from:myId, text});
}
function appendChatMessage(from, text, isMine){
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMine ? ' mine' : '');
  const name = players[from] ? players[from].name : from;
  div.innerHTML = '<b>'+escapeHtml(name)+':</b> '+escapeHtml(text);
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  if(!isMine && document.getElementById('chat-panel').classList.contains('hidden')){
    document.getElementById('chat-badge').classList.remove('hidden');
  }
}

/* ===================== MIC / CAMERA ===================== */
function attachRemoteStream(stream){
  const v = document.getElementById('remote-video');
  v.srcObject = stream;
  v.classList.remove('hidden');
}
function clearRemoteVideo(){
  const v = document.getElementById('remote-video');
  v.srcObject = null;
  v.classList.add('hidden');
}
async function updateLocalMedia(){
  try{
    if(localStream){
      localStream.getTracks().forEach(t=>t.stop());
      localStream = null;
    }
    const localVideoEl = document.getElementById('local-video');
    if(micOn || camOn){
      localStream = await navigator.mediaDevices.getUserMedia({audio:micOn, video:camOn});
      localVideoEl.srcObject = localStream;
      if(camOn){ localVideoEl.classList.remove('hidden'); } else { localVideoEl.classList.add('hidden'); }
    } else {
      localVideoEl.srcObject = null;
      localVideoEl.classList.add('hidden');
    }

    if(conn && conn.open && peer){
      if(outgoingMediaConn){ try{ outgoingMediaConn.close(); }catch(e){} outgoingMediaConn=null; }
      if(localStream){
        outgoingMediaConn = peer.call(conn.peer, localStream);
        outgoingMediaConn.on('stream', remoteStream=>attachRemoteStream(remoteStream));
      }
    }
  }catch(e){
    addLog('⚠️ Không thể truy cập mic/camera: ' + e.message);
    micOn = false; camOn = false;
    updateMicCamButtons();
  }
}
function updateMicCamButtons(){
  document.getElementById('btn-mic').classList.toggle('active', micOn);
  document.getElementById('btn-cam').classList.toggle('active', camOn);
}

/* ===================== XOAY NGANG / TOÀN MÀN HÌNH (BEST-EFFORT) ===================== */
async function tryEnterLandscape(){
  try{
    if(!document.fullscreenElement && document.documentElement.requestFullscreen){
      await document.documentElement.requestFullscreen();
    }
    if(screen.orientation && screen.orientation.lock){
      await screen.orientation.lock('landscape');
    }
  }catch(e){ /* không được hỗ trợ hoặc bị từ chối — bỏ qua, người dùng tự xoay máy */ }
}

/* ===================== SỰ KIỆN GIAO DIỆN MENU ===================== */
document.getElementById('btn-create').addEventListener('click', ()=>{
  const name = document.getElementById('input-name').value.trim() || 'Người chơi 1';
  players.p1.name = name;
  myId = 'p1'; isHost = true;
  showScreen('screen-lobby');
  document.getElementById('lobby-title').textContent = 'Phòng của bạn';
  document.getElementById('lobby-host-box').classList.remove('hidden');
  document.getElementById('lobby-join-box').classList.add('hidden');
  setupPeerAsHost();
});

document.getElementById('btn-join').addEventListener('click', ()=>{
  const name = document.getElementById('input-name').value.trim() || 'Người chơi 2';
  const code = document.getElementById('input-join-code').value.trim();
  if(!/^\d{3}$/.test(code)){ showMenuError('Vui lòng nhập đúng mã phòng gồm 3 chữ số.'); return; }
  players.p2.name = name;
  myId = 'p2'; isHost = false;
  showScreen('screen-lobby');
  document.getElementById('lobby-title').textContent = 'Đang tham gia phòng';
  document.getElementById('lobby-host-box').classList.add('hidden');
  document.getElementById('lobby-join-box').classList.remove('hidden');
  setupPeerAsGuest(code);
});

document.getElementById('btn-copy-code').addEventListener('click', ()=>{
  const code = document.getElementById('room-code-text').textContent;
  navigator.clipboard && navigator.clipboard.writeText(code);
  const btn = document.getElementById('btn-copy-code');
  const old = btn.textContent; btn.textContent = 'Đã sao chép!';
  setTimeout(()=>btn.textContent=old, 1500);
});

document.getElementById('btn-cancel-lobby').addEventListener('click', ()=>{
  if(peer){ try{peer.destroy();}catch(e){} peer=null; conn=null; }
  goToMenu();
});

/* ===== Chat UI ===== */
document.getElementById('btn-chat-toggle').addEventListener('click', ()=>{
  document.getElementById('chat-panel').classList.toggle('hidden');
  document.getElementById('chat-badge').classList.add('hidden');
});
document.getElementById('btn-chat-close').addEventListener('click', ()=>{
  document.getElementById('chat-panel').classList.add('hidden');
});
document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e=>{
  if(e.key==='Enter') sendChat();
});

/* ===== Mic / Cam UI ===== */
document.getElementById('btn-mic').addEventListener('click', ()=>{
  micOn = !micOn; updateMicCamButtons(); updateLocalMedia();
});
document.getElementById('btn-cam').addEventListener('click', ()=>{
  camOn = !camOn; updateMicCamButtons(); updateLocalMedia();
});

/* ===== Xoay ngang / toàn màn hình ===== */
document.getElementById('btn-force-landscape').addEventListener('click', tryEnterLandscape);
document.getElementById('btn-fullscreen-2').addEventListener('click', tryEnterLandscape);

/* ===== Rời phòng / về menu ===== */
function leaveRoomAndReset(){
  if(outgoingMediaConn){ try{outgoingMediaConn.close();}catch(e){} outgoingMediaConn=null; }
  if(incomingMediaConn){ try{incomingMediaConn.close();}catch(e){} incomingMediaConn=null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  if(peer){ try{peer.destroy();}catch(e){} peer=null; conn=null; }
  micOn=false; camOn=false;
  document.getElementById('local-video').classList.add('hidden');
  clearRemoteVideo();
  goToMenu();
}
document.getElementById('btn-leave').addEventListener('click', ()=>{
  if(confirm('Rời phòng và quay lại màn hình chính?')) leaveRoomAndReset();
});
document.getElementById('btn-back-menu').addEventListener('click', leaveRoomAndReset);

/* ===== Chơi lại (không cần tải lại trang) ===== */
document.getElementById('btn-rematch-host').addEventListener('click', ()=>{
  resetGameState();
  broadcastInit();
  goToGameScreen();
});
document.getElementById('btn-rematch-guest').addEventListener('click', ()=>{
  conn && conn.send({type:'requestRematch'});
  document.getElementById('rematch-wait-msg').classList.remove('hidden');
  document.getElementById('btn-rematch-guest').disabled = true;
});

/* ===================== KHỞI ĐỘNG ===================== */
updateSliderReadouts();
requestAnimationFrame(mainLoop);
