/* ============================================================
   BI-A 8 BI — 2 NGƯỜI CHƠI QUA P2P (PeerJS / WebRTC)
   Toàn bộ vật lý luật chơi được xử lý bởi "chủ phòng" (host),
   khách (guest) gửi lệnh đánh và nhận trạng thái bàn để hiển thị.
   ============================================================ */

/* ===================== CẤU HÌNH & HẰNG SỐ ===================== */
const CFG = {
  W: 880, H: 440,
  BALL_R: 11,
  POCKET_R: 22,
  FRICTION: 0.994,        // hệ số ma sát mỗi bước mô phỏng (lăn chậm dần)
  MIN_SPEED: 0.045,       // dưới ngưỡng này coi như đứng yên
  WALL_RESTITUTION: 0.86,
  BALL_RESTITUTION: 0.98,
  MAX_SHOT_SPEED: 21,
  SUBSTEPS: 6,
  MAX_DRAG: 170,          // px kéo tối đa để lấy lực tối đa
};

const RAIL = 26; // độ dày viền băng trong canvas để tính vị trí lỗ/băng

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
  {x: (TABLE.x0+TABLE.x1)/2, y: TABLE.y0 - 4},
  {x: TABLE.x1, y: TABLE.y0},
  {x: TABLE.x0, y: TABLE.y1},
  {x: (TABLE.x0+TABLE.x1)/2, y: TABLE.y1 + 4},
  {x: TABLE.x1, y: TABLE.y1},
];

/* ===================== TRẠNG THÁI TOÀN CỤC ===================== */
let myId = null;          // 'p1' (host) hoặc 'p2' (guest)
let isHost = false;
let peer = null;
let conn = null;

let players = {
  p1: { name:'Người chơi 1', group:null },
  p2: { name:'Người chơi 2', group:null },
};

let balls = [];            // mảng bóng {num,x,y,vx,vy,potted}
let turn = 'p1';           // ai đang đánh
let groupsOpen = true;
let ballInHandFor = null;  // 'p1'|'p2'|null — người này cần đặt bi cái
let gameOver = false;
let winner = null;
let isBreakShot = true;
let logMessages = [];

// dữ liệu tạm trong lúc mô phỏng 1 cú đánh (chỉ host dùng)
let shotCtx = null;
let simRunning = false;

// input aiming (cả 2 bên dùng để vẽ hình, chỉ người đang có lượt mới được bắn)
let aiming = false;
let aimStart = {x:0,y:0};
let aimCurrent = {x:0,y:0};
let placingCueBall = false;

/* ===================== KHỞI TẠO BÓNG (RACK) ===================== */
function createInitialBalls(){
  const r = CFG.BALL_R;
  const headX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.25;
  const footX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.75;
  const midY = (TABLE.y0+TABLE.y1)/2;

  const arr = [];
  arr.push({num:0, x:headX, y:midY, vx:0, vy:0, potted:false}); // bi cái = num 0

  const rows = [
    [1],
    [9,2],
    [10,8,3],
    [4,11,5,12],
    [6,13,7,14,15]
  ];
  const dx = r*1.75; // khoảng cách theo hàng (đủ hở nhẹ để không kẹt)
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
function cueBall(){ return balls.find(b=>b.num===0 && !b.potted); }
function ballByNum(n){ return balls.find(b=>b.num===n); }

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
    // di chuyển
    for(const b of balls){
      if(b.potted) continue;
      b.x += b.vx/sub;
      b.y += b.vy/sub;
    }
    // va chạm băng
    for(const b of balls){
      if(b.potted) continue;
      const r = CFG.BALL_R;
      if(b.x - r < TABLE.x0){ b.x = TABLE.x0 + r; b.vx = -b.vx*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.x + r > TABLE.x1){ b.x = TABLE.x1 - r; b.vx = -b.vx*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.y - r < TABLE.y0){ b.y = TABLE.y0 + r; b.vy = -b.vy*CFG.WALL_RESTITUTION; onRailContact(b); }
      if(b.y + r > TABLE.y1){ b.y = TABLE.y1 - r; b.vy = -b.vy*CFG.WALL_RESTITUTION; onRailContact(b); }
    }
    // va chạm giữa các bi
    for(let i=0;i<balls.length;i++){
      const a = balls[i];
      if(a.potted) continue;
      for(let j=i+1;j<balls.length;j++){
        const b = balls[j];
        if(b.potted) continue;
        resolveBallCollision(a,b);
      }
    }
    // kiểm tra rơi lỗ
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
  // ma sát (áp dụng 1 lần mỗi khung hình, không theo substep để ổn định)
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

  // tách vị trí (positional correction)
  const overlap = (r-dist)/2;
  const nx = dx/dist, ny = dy/dist;
  a.x -= nx*overlap; a.y -= ny*overlap;
  b.x += nx*overlap; b.y += ny*overlap;

  // ghi nhận va chạm đầu tiên của bi cái (phục vụ luật)
  if(shotCtx){
    if(a.num===0 && b.num!==0 && shotCtx.firstContact===null) shotCtx.firstContact = b.num;
    if(b.num===0 && a.num!==0 && shotCtx.firstContact===null) shotCtx.firstContact = a.num;
  }

  // vận tốc tương đối theo phương pháp tuyến
  const rvx = b.vx-a.vx, rvy = b.vy-a.vy;
  const velAlongNormal = rvx*nx + rvy*ny;
  if(velAlongNormal > 0) return; // đang tách ra rồi, không cần đẩy thêm

  const restitution = CFG.BALL_RESTITUTION;
  const j = -(1+restitution)*velAlongNormal / 2; // khối lượng bằng nhau, m=1 mỗi bi, tổng nghịch đảo khối lượng=2
  const ix = j*nx, iy = j*ny;
  a.vx -= ix; a.vy -= iy;
  b.vx += ix; b.vy += iy;
}

function onRailContact(ball){
  if(shotCtx && shotCtx.firstContact!==null){
    shotCtx.railAfterContact = true;
  }
  if(shotCtx && shotCtx.isBreak){
    shotCtx.railTouchSet.add(ball.num); // đếm số bi KHÁC NHAU đã chạm băng khi giao bóng
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
  const cb = cueBall();
  if(!cb) return;
  const speed = Math.min(power, 1) * CFG.MAX_SHOT_SPEED;
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

  // gán nhóm bi nếu bàn còn "mở"
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

  // xử lý bi số 8
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
    finalizeAfterShot();
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
  finalizeAfterShot();
}

function finalizeAfterShot(){
  // dọn bi đã rơi lỗ khỏi mảng hiển thị (đặt potted=true, giữ lại để đồng bộ số bi còn/đã mất)
  shotCtx = null;
  simRunning = false;
  broadcastState();
  updateHUD();
  if(gameOver) showEndScreen();
}

/* ===================== VÒNG LẶP CHÍNH (HOST) ===================== */
let lastFrameTime = performance.now();
function hostLoop(now){
  requestAnimationFrame(hostLoop);
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  if(!isHost || gameOver) { renderFrame(); return; }

  if(simRunning){
    stepPhysics();
    if(!anyBallMoving()){
      resolveShotEnd();
    } else {
      broadcastState(true);
    }
  }
  renderFrame();
}

/* ===================== MẠNG (PEERJS) ===================== */
function setupPeerAsHost(){
  peer = new Peer();
  peer.on('open', id=>{
    document.getElementById('room-code-text').textContent = id;
  });
  peer.on('connection', c=>{
    conn = c;
    wireConnection();
    conn.on('open', ()=>{
      goToGameScreen();
      // chờ đối thủ gửi 'hello' kèm tên trước khi khởi tạo ván đấu
    });
  });
  peer.on('error', err=>{
    showMenuError('Lỗi kết nối: ' + err.type);
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
  peer.on('error', err=>{
    showMenuError('Lỗi kết nối: ' + err.type);
    goToMenu();
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
        const cb = cueBall();
        if(cb && isValidCuePlacement(data.x, data.y)){
          cb.x = data.x; cb.y = data.y; cb.vx=0; cb.vy=0;
          ballInHandFor = null;
          broadcastState();
          updateHUD();
        }
      }
      break;
  }
}

function broadcastInit(){
  if(!isHost || !conn || !conn.open) return;
  conn.send({type:'init', players, balls, turn, groupsOpen, ballInHandFor, gameOver, winner, isBreakShot, logMessages});
  updateHUD();
}

function broadcastState(){
  if(!isHost || !conn || !conn.open) return;
  conn.send({type:'state', balls, turn, groupsOpen, ballInHandFor, gameOver, winner, players, logMessages});
}

/* ===================== INPUT: NGẮM & BẮN ===================== */
const canvas = document.getElementById('table');
const ctx2d = canvas.getContext('2d');

function myTurn(){ return turn===myId && !gameOver; }
function iHaveBallInHand(){ return ballInHandFor===myId && !gameOver; }

function canvasPos(evt){
  const rect = canvas.getBoundingClientRect();
  const scaleX = CFG.W/rect.width, scaleY = CFG.H/rect.height;
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  return { x:(clientX-rect.left)*scaleX, y:(clientY-rect.top)*scaleY };
}

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

function pointerDown(evt){
  evt.preventDefault();
  const pos = canvasPos(evt);
  if(iHaveBallInHand()){
    if(isValidCuePlacement(pos.x,pos.y)){
      if(isHost){
        const cb = cueBall();
        cb.x=pos.x; cb.y=pos.y; cb.vx=0; cb.vy=0;
        ballInHandFor = null;
        broadcastState(); updateHUD();
      } else {
        conn && conn.send({type:'placeCueBall', x:pos.x, y:pos.y, from:myId});
      }
    }
    return;
  }
  if(!myTurn() || simRunning) return;
  const cb = cueBall();
  if(!cb) return;
  aiming = true;
  aimStart = pos;
  aimCurrent = pos;
  document.getElementById('power-meter').classList.add('visible');
}
function pointerMove(evt){
  if(!aiming) return;
  evt.preventDefault();
  aimCurrent = canvasPos(evt);
}
function pointerUp(evt){
  if(!aiming) return;
  evt.preventDefault();
  aiming = false;
  document.getElementById('power-meter').classList.remove('visible');
  const cb = cueBall();
  if(!cb) return;
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const dragDist = Math.sqrt(dx*dx+dy*dy);
  if(dragDist < 6) return; // kéo quá ngắn, bỏ qua
  const angle = Math.atan2(dy, dx); // bắn theo hướng kéo ngược (giật cơ)
  const power = Math.min(dragDist, CFG.MAX_DRAG) / CFG.MAX_DRAG;

  if(isHost){
    if(turn===myId && !simRunning) beginShot(angle, power);
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

/* ===================== VẼ (RENDER) ===================== */
function renderFrame(){
  drawTable();
  drawPockets();
  drawBalls();
  drawAimGuide();
  updatePowerMeter();
}

function drawTable(){
  ctx2d.clearRect(0,0,CFG.W,CFG.H);
  // nỉ bàn
  const grad = ctx2d.createRadialGradient(CFG.W/2,CFG.H/2,50,CFG.W/2,CFG.H/2,CFG.W/1.3);
  grad.addColorStop(0,'#0e7a42');
  grad.addColorStop(1,'#0a5029');
  ctx2d.fillStyle = grad;
  ctx2d.fillRect(TABLE.x0,TABLE.y0,TABLE.x1-TABLE.x0,TABLE.y1-TABLE.y0);
  // đường viền giữa bàn (trang trí)
  ctx2d.strokeStyle = '#ffffff22';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo((TABLE.x0+TABLE.x1)/2, TABLE.y0);
  ctx2d.lineTo((TABLE.x0+TABLE.x1)/2, TABLE.y1);
  ctx2d.stroke();
  // chấm đầu bàn
  const headX = TABLE.x0 + (TABLE.x1-TABLE.x0)*0.25;
  ctx2d.fillStyle = '#ffffff55';
  ctx2d.beginPath(); ctx2d.arc(headX, (TABLE.y0+TABLE.y1)/2, 2.5, 0, Math.PI*2); ctx2d.fill();
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

  // bóng đổ
  ctx2d.beginPath();
  ctx2d.ellipse(1.5,3,r*0.9,r*0.5,0,0,Math.PI*2);
  ctx2d.fillStyle = '#00000044';
  ctx2d.fill();

  if(b.num===0){
    // bi cái
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
    // vòng tròn trắng số
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
  // ánh sáng
  ctx2d.beginPath();
  ctx2d.arc(-r*0.35,-r*0.35,r*0.3,0,Math.PI*2);
  ctx2d.fillStyle = '#ffffff55';
  ctx2d.fill();

  ctx2d.restore();
}

function drawAimGuide(){
  if(iHaveBallInHand()){
    canvas.style.cursor = 'copy';
    return;
  }
  canvas.style.cursor = myTurn() && !simRunning ? 'crosshair' : 'default';
  if(!aiming) return;
  const cb = cueBall();
  if(!cb) return;
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const dragDist = Math.sqrt(dx*dx+dy*dy);
  if(dragDist < 4) return;
  const angle = Math.atan2(dy,dx);
  const len = 900;

  // đường ngắm dài (hướng bắn)
  ctx2d.save();
  ctx2d.strokeStyle = '#ffffffaa';
  ctx2d.lineWidth = 1.5;
  ctx2d.setLineDash([6,6]);
  ctx2d.beginPath();
  ctx2d.moveTo(cb.x, cb.y);
  ctx2d.lineTo(cb.x + Math.cos(angle)*len, cb.y + Math.sin(angle)*len);
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  // cây cơ kéo lùi
  const pull = Math.min(dragDist, CFG.MAX_DRAG);
  ctx2d.strokeStyle = '#c99a5b';
  ctx2d.lineWidth = 5;
  ctx2d.lineCap = 'round';
  ctx2d.beginPath();
  ctx2d.moveTo(cb.x - Math.cos(angle)*(pull+18), cb.y - Math.sin(angle)*(pull+18));
  ctx2d.lineTo(cb.x - Math.cos(angle)*(pull+4), cb.y - Math.sin(angle)*(pull+4));
  ctx2d.stroke();
  ctx2d.restore();
}

function updatePowerMeter(){
  const fill = document.getElementById('power-fill');
  if(!aiming){ fill.style.height='0%'; return; }
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const dragDist = Math.min(Math.sqrt(dx*dx+dy*dy), CFG.MAX_DRAG);
  fill.style.height = (dragDist/CFG.MAX_DRAG*100)+'%';
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
}

function renderLog(){
  const el = document.getElementById('game-log');
  el.innerHTML = logMessages.slice(-8).map(m=>'<div>'+escapeHtml(m)+'</div>').join('');
  el.scrollTop = el.scrollHeight;
}
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
  }, 900);
}

/* ===================== ĐIỀU HƯỚNG MÀN HÌNH ===================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function goToMenu(){ showScreen('screen-menu'); }
function goToGameScreen(){ showScreen('screen-game'); updateHUD(); }
function showMenuError(msg){ document.getElementById('menu-error').textContent = msg; }

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
  if(!code){ showMenuError('Vui lòng nhập mã phòng.'); return; }
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
  if(peer){ peer.destroy(); peer=null; conn=null; }
  goToMenu();
});

document.getElementById('btn-rematch').addEventListener('click', ()=>{
  location.reload();
});

/* ===================== KHỞI ĐỘNG ===================== */
requestAnimationFrame(hostLoop);
