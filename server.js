const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });


// ═══════════════════════════════════════
//  GAME ENGINE
// ═══════════════════════════════════════

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RV = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));
const TRUMP = 'S';

function makeDeck() {
  const d = [];
  for (const s of ['S','H','D','C'])
    for (const r of RANKS) d.push({ id: r+s, r, s });
  return d;
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length-1; i > 0; i--) {
    const j = 0 | Math.random()*(i+1);
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function deal(d) {
  const h = [[],[],[],[]];
  for (let i = 0; i < 52; i++) h[i%4].push(d[i]);
  return h;
}
function sortHand(h) {
  const o = {D:0,C:1,H:2,S:3};
  return [...h].sort((a,b) => o[a.s]!==o[b.s] ? o[a.s]-o[b.s] : RV[b.r]-RV[a.r]);
}
function isValidHand(hand) {
  const FACES = ['J','Q','K','A'];
  return hand.some(c => FACES.includes(c.r)) && hand.some(c => c.s===TRUMP);
}
function dealValid() {
  for (let i = 0; i < 100; i++) {
    const deck = shuffle(makeDeck());
    const hands = deal(deck);
    if (hands.every(h => isValidHand(h))) return hands;
  }
  return deal(shuffle(makeDeck()));
}
function beats(ch, cu, led) {
  const ct=ch.s===TRUMP, wt=cu.s===TRUMP;
  if(ct&&wt) return RV[ch.r]>RV[cu.r];
  if(ct) return true; if(wt) return false;
  if(ch.s!==led) return false;
  if(cu.s!==led) return true;
  return RV[ch.r]>RV[cu.r];
}
function legal(hand, led, trick) {
  if(!led) return [...hand];
  const inSuit = hand.filter(c=>c.s===led);
  if(inSuit.length) {
    let win=trick[0].card;
    for(let i=1;i<trick.length;i++) if(beats(trick[i].card,win,led)) win=trick[i].card;
    const canBeat=inSuit.filter(c=>beats(c,win,led));
    return canBeat.length ? canBeat : inSuit;
  }
  const trumps=hand.filter(c=>c.s===TRUMP);
  if(trumps.length) {
    let win=trick[0].card;
    for(let i=1;i<trick.length;i++) if(beats(trick[i].card,win,led)) win=trick[i].card;
    if(win.s===TRUMP) {
      const canBeat=trumps.filter(c=>beats(c,win,led));
      if(canBeat.length) return canBeat;
      return [...hand];
    }
    return trumps;
  }
  return [...hand];
}
function resolveTrick(plays) {
  const led=plays[0].card.s;
  let w=plays[0];
  for(let i=1;i<plays.length;i++) if(beats(plays[i].card,w.card,led)) w=plays[i];
  return w.pi;
}
function roundScore(bid, won) {
  if(won>=bid) return parseFloat((bid+(won-bid)*0.1).toFixed(1));
  return -bid;
}

// ═══════════════════════════════════════
//  ROOM MANAGEMENT
// ═══════════════════════════════════════

const rooms = {};
const RECONNECT_MS = 2 * 60 * 1000; // 2 minutes

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0;i<4;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for(let i=0;i<32;i++) token += chars[Math.floor(Math.random()*chars.length)];
  return token;
}

function createRoom(totalRounds=5) {
  let code;
  do { code = generateCode(); } while(rooms[code]);
  rooms[code] = {
    code, totalRounds,
    players: [],
    state: null,
    phase: 'lobby',
    pausedFor: null,
  };
  return rooms[code];
}

function getRoomBySocket(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id===socketId));
}

function getRoomByToken(token) {
  for(const room of Object.values(rooms)) {
    const player = room.players.find(p => p.token===token);
    if(player) return { room, player };
  }
  return null;
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby_update', {
    code: room.code,
    players: room.players.map(p => ({ name: p.name, seat: p.seat, connected: p.connected })),
    totalRounds: room.totalRounds,
  });
}

function broadcastGameState(room) {
  const G = room.state;
  room.players.forEach(p => {
    if(!p.connected || p.isBot) return;
    io.to(p.id).emit('game_state', {
      round: G.round, totalRounds: room.totalRounds,
      dealer: G.dealer, scores: G.scores,
      bids: G.bids, won: G.won, trick: G.trick,
      trickNum: G.trickNum, cur: G.cur, phase: G.phase,
      names: room.players.map(p => p.name),
      handCounts: G.hands.map(h => h.length),
      roundHistory: G.roundHistory,
      myHand: G.hands[p.seat],
      mySeat: p.seat,
      pausedFor: room.pausedFor,
    });
  });
}

// ═══════════════════════════════════════
//  GAME FLOW
// ═══════════════════════════════════════

function startGame(room) {
  room.phase = 'playing';
  room.state = {
    round: 1, dealer: 3,
    scores: [0,0,0,0], hands: [[],[],[],[]],
    bids: [null,null,null,null], won: [0,0,0,0],
    trick: [], trickNum: 1, cur: 0, firstOfRound: 0,
    phase: 'bidding', roundHistory: [],
  };
  startRound(room);
}

function startRound(room) {
  const G = room.state;
  if(G.round>1) G.dealer=(G.dealer+1)%4;
  G.firstOfRound=(G.dealer+1)%4;
  const raw=dealValid();
  G.hands=raw.map(h=>sortHand(h));
  G.bids=[null,null,null,null];
  G.won=[0,0,0,0];
  G.trick=[]; G.trickNum=1;
  G.phase='bidding'; G.cur=G.firstOfRound;
  broadcastGameState(room);
}

function handleBid(room, seat, bid) {
  const G = room.state;
  if(G.phase!=='bidding'||G.cur!==seat||G.bids[seat]!==null) return;
  const bidNum=parseInt(bid);
  if(isNaN(bidNum)||bidNum<2||bidNum>13) return;
  G.bids[seat]=bidNum;

  let next=-1;
  for(let offset=1;offset<=4;offset++){
    const pi=(G.firstOfRound+((seat-G.firstOfRound+offset+4)%4))%4;
    if(G.bids[pi]===null){ next=pi; break; }
  }
  if(next!==-1){ G.cur=next; broadcastGameState(room); return; }

  const totalBid=G.bids.reduce((s,b)=>s+b,0);
  if(totalBid<10){
    io.to(room.code).emit('redeal',{reason:'Total bids under 10'});
    setTimeout(()=>{
      G.bids=[null,null,null,null]; G.won=[0,0,0,0];
      G.trick=[]; G.trickNum=1; G.phase='bidding';
      const raw=dealValid(); G.hands=raw.map(h=>sortHand(h));
      G.cur=G.firstOfRound; broadcastGameState(room);
    },1000);
    return;
  }
  G.phase='playing'; G.cur=G.firstOfRound;
  broadcastGameState(room);
}

function handlePlay(room, seat, cardId) {
  const G = room.state;
  if(G.phase!=='playing'||G.cur!==seat) return;
  if(room.pausedFor!==null) return;

  const hand=G.hands[seat];
  const cardIdx=hand.findIndex(c=>c.id===cardId);
  if(cardIdx===-1) return;

  const led=G.trick.length?G.trick[0].card.s:null;
  const legalCards=legal(hand,led,G.trick);
  const card=hand[cardIdx];
  if(!legalCards.find(c=>c.id===cardId)){
    const p=room.players.find(p=>p.seat===seat);
    if(p) io.to(p.id).emit('illegal_move');
    return;
  }

  G.hands[seat].splice(cardIdx,1);
  G.trick.push({pi:seat,card});
  io.to(room.code).emit('card_played',{seat,card});

  if(G.trick.length<4){
    G.cur=(seat+1)%4;
    broadcastGameState(room);
    return;
  }

  setTimeout(()=>{
    const winner=resolveTrick(G.trick);
    G.won[winner]++;
    const winnerName=room.players.find(p=>p.seat===winner)?.name||`P${winner}`;
    io.to(room.code).emit('trick_won',{winner,winnerName,trick:G.trick});
    G.trick=[]; G.trickNum++; G.cur=winner;
    if(G.trickNum>13){
      setTimeout(()=>endRound(room),1400);
    } else {
      // Wait for client animation to finish (900ms pause + 380ms sweep) before sending next state
      setTimeout(()=>broadcastGameState(room), 1400);
    }
  },800);
}

function endRound(room) {
  const G=room.state;
  const scores=[0,1,2,3].map(i=>roundScore(G.bids[i],G.won[i]));
  G.roundHistory=G.roundHistory||[];
  G.roundHistory.push({
    round:G.round,
    roundScores:[0,1,2,3].map(i=>({playerIndex:i,bid:G.bids[i],won:G.won[i],score:scores[i]})),
  });
  [0,1,2,3].forEach(i=>{G.scores[i]=parseFloat((G.scores[i]+scores[i]).toFixed(1));});

  io.to(room.code).emit('round_end',{
    round:G.round, bids:G.bids, won:G.won,
    scores, totals:G.scores,
    names:room.players.map(p=>p.name),
    roundHistory:G.roundHistory,
  });

  if(G.round>=room.totalRounds){
    const sorted=[0,1,2,3].map(i=>({i,s:G.scores[i]})).sort((a,b)=>b.s-a.s);
    io.to(room.code).emit('game_over',{
      scores:G.scores, winner:sorted[0].i,
      names:room.players.map(p=>p.name), sorted,
      roundHistory:G.roundHistory,
    });
    room.phase='lobby'; room.state=null;
    return;
  }
  G.round++;
  setTimeout(()=>startRound(room),3000);
}

// ═══════════════════════════════════════
//  RECONNECTION
// ═══════════════════════════════════════

function startReconnectTimer(room, player) {
  if(player.reconnectTimer) clearTimeout(player.reconnectTimer);
  room.pausedFor=player.seat;

  io.to(room.code).emit('player_disconnected',{
    name: player.name,
    seat: player.seat,
    timeoutMs: RECONNECT_MS,
  });

  player.reconnectTimer=setTimeout(()=>{
    io.to(room.code).emit('reconnect_failed',{name:player.name});
    delete rooms[room.code];
  }, RECONNECT_MS);
}

// ═══════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════

io.on('connection', socket => {
  console.log('connect', socket.id);

  // Auto-reconnect with token
  socket.on('reconnect_with_token', ({ token }) => {
    const result=getRoomByToken(token);
    if(!result){ socket.emit('reconnect_failed_token'); return; }
    const {room, player}=result;

    if(player.reconnectTimer){ clearTimeout(player.reconnectTimer); player.reconnectTimer=null; }
    player.id=socket.id;
    player.connected=true;
    room.pausedFor=null;
    socket.join(room.code);

    console.log(`${player.name} reconnected to ${room.code}`);
    io.to(room.code).emit('player_reconnected',{name:player.name, seat:player.seat});

    if(room.state){
      const G=room.state;
      socket.emit('game_state',{
        round:G.round, totalRounds:room.totalRounds,
        dealer:G.dealer, scores:G.scores,
        bids:G.bids, won:G.won, trick:G.trick,
        trickNum:G.trickNum, cur:G.cur, phase:G.phase,
        names:room.players.map(p=>p.name),
        handCounts:G.hands.map(h=>h.length),
        roundHistory:G.roundHistory,
        myHand:G.hands[player.seat],
        mySeat:player.seat, pausedFor:null,
      });
      // Resume game for everyone
      broadcastGameState(room);
    } else {
      broadcastLobby(room);
    }
  });

  // Create room
  socket.on('create_room', ({name, totalRounds}) => {
    const room=createRoom(totalRounds||5);
    const token=generateToken();
    room.players.push({id:socket.id, name:name||'Player', seat:0, token, connected:true});
    socket.join(room.code);
    socket.emit('room_created',{code:room.code, seat:0, token});
    broadcastLobby(room);
  });

  // Join room
  socket.on('join_room', ({name, code}) => {
    const room=rooms[code?.toUpperCase()];
    if(!room){ socket.emit('error','Room not found'); return; }
    if(room.phase!=='lobby'){ socket.emit('error','Game already started'); return; }
    if(room.players.length>=4){ socket.emit('error','Room is full'); return; }
    const seat=room.players.length;
    const token=generateToken();
    room.players.push({id:socket.id, name:name||'Player', seat, token, connected:true});
    socket.join(room.code);
    socket.emit('room_joined',{code:room.code, seat, token});
    broadcastLobby(room);
  });

  // Start game
  socket.on('start_game', () => {
    const room=getRoomBySocket(socket.id);
    if(!room) return;
    const me=room.players.find(p=>p.id===socket.id);
    if(!me||me.seat!==0){ socket.emit('error','Only host can start'); return; }
    if(room.players.length<2){ socket.emit('error','Need at least 2 players'); return; }
    while(room.players.length<4){
      const seat=room.players.length;
      room.players.push({id:`bot-${seat}`, name:['West','North','East'][seat-1], seat, token:null, connected:true, isBot:true});
    }
    startGame(room);
  });

  // Place bid
  socket.on('place_bid', ({bid}) => {
    const room=getRoomBySocket(socket.id);
    if(!room) return;
    const seat=room.players.find(p=>p.id===socket.id)?.seat??-1;
    handleBid(room,seat,bid);
  });

  // Play card
  socket.on('play_card', ({cardId}) => {
    const room=getRoomBySocket(socket.id);
    if(!room) return;
    const seat=room.players.find(p=>p.id===socket.id)?.seat??-1;
    handlePlay(room,seat,cardId);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const room=getRoomBySocket(socket.id);
    if(!room) return;
    const player=room.players.find(p=>p.id===socket.id);
    if(!player) return;
    player.connected=false;

    if(room.phase==='lobby'){
      room.players=room.players.filter(p=>p.id!==socket.id);
      room.players.forEach((p,i)=>p.seat=i);
      if(room.players.length===0) delete rooms[room.code];
      else broadcastLobby(room);
    } else {
      startReconnectTimer(room,player);
    }
  });
});

// ═══════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Callbreak server running on port ${PORT}`));
