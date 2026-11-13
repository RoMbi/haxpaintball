import { ClientMsg, ServerMsg, GameMsg, encode, decode } from '../shared/protocol.js';
import { snapshot } from '../shared/sim.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const DC_OPTIONS = { ordered: false, maxRetransmits: 0 };
const RELAY_FALLBACK_MS = 4000;

function defaultWsUrl() {
  if (typeof location !== 'undefined' && location.host) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }
  return 'ws://localhost:8080';
}

function icePayload(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

export function createNet(handlers) {
  const hooks = handlers && typeof handlers === 'object' ? handlers : {};
  const peers = new Map();
  const pendingIce = new Map();
  const pending = [];

  const state = {
    playerId: null,
    roomCode: null,
    hostId: null,
    isHost: false,
    players: [],
    mapId: '',
    serverHost: false,
  };

  let transport = 'none';
  let ws = null;
  let wsUrl = null;
  let wsGen = 0;
  let epoch = 0;
  let guestStarted = false;
  let webrtcGiveUp = false;
  let fallbackTimer = null;

  function emit(name, ...args) {
    const fn = hooks[name];
    if (typeof fn === 'function') fn(...args);
  }

  function getState() {
    return {
      playerId: state.playerId,
      roomCode: state.roomCode,
      hostId: state.hostId,
      isHost: state.isHost,
      players: state.players.map((p) => ({ id: p.id, nick: p.nick, team: p.team })),
      transport,
      mapId: state.mapId || '',
      serverHost: !!state.serverHost,
    };
  }

  function updateTransport() {
    const next = computeTransport();
    if (next === transport) return;
    transport = next;
    emit('onTransport', next);
  }

  function channelOpen(peerId) {
    const peer = peers.get(peerId);
    return !!(peer && peer.dc && peer.dc.readyState === 'open');
  }

  function computeTransport() {
    if (!state.playerId) return 'none';
    if (state.serverHost) return 'server';
    if (state.isHost) {
      const guests = state.players.filter((p) => p.id !== state.playerId);
      if (guests.length === 0) return 'none';
      return guests.every((p) => channelOpen(p.id)) ? 'webrtc' : 'relay';
    }
    return channelOpen(state.hostId) ? 'webrtc' : 'relay';
  }

  function sendWs(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encode(obj));
      return true;
    } catch {
      return false;
    }
  }

  function flushPending() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const queued = pending.splice(0, pending.length);
    for (const msg of queued) sendWs(msg);
  }

  function enqueue(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs(msg);
      return;
    }
    pending.push(msg);
  }

  function connect(url) {
    const target = url || defaultWsUrl();
    if (
      ws &&
      wsUrl === target &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      if (ws.readyState === WebSocket.OPEN) flushPending();
      return;
    }
    if (typeof WebSocket !== 'function') {
      emit('onError', 'WebSocket niedostępny');
      return;
    }
    wsUrl = target;
    const gen = ++wsGen;
    if (ws) {
      const old = ws;
      ws = null;
      try {
        old.close();
      } catch {
        // already closing
      }
    }
    let sock;
    try {
      sock = new WebSocket(target);
    } catch {
      emit('onError', 'cannotConnect');
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (gen !== wsGen || sock !== ws) return;
      flushPending();
    };
    sock.onmessage = (ev) => {
      if (sock !== ws) return;
      onSocketMessage(ev.data);
    };
    sock.onerror = () => {
      if (gen !== wsGen || sock !== ws) return;
      if (sock.readyState === WebSocket.CONNECTING) {
        emit('onError', 'cannotConnect');
      }
    };
    sock.onclose = () => {
      if (gen !== wsGen || sock !== ws) return;
      const hadRoom = !!state.playerId;
      ws = null;
      pending.splice(0, pending.length);
      if (hadRoom) emit('onClosed', 'connectionLost');
      else emit('onError', 'cannotConnect');
    };
  }

  function reserveCode(code) {
    enqueue({ t: ClientMsg.RESERVE, code: code || '' });
  }

  function createRoom(opts) {
    enqueue({
      t: ClientMsg.CREATE,
      nick: opts && opts.nick,
      team: opts && opts.team,
      mapId: opts && opts.mapId,
      serverHost: !!(opts && opts.serverHost),
      code: opts && opts.code,
    });
  }

  function startMatch() {
    enqueue({ t: ClientMsg.START });
  }

  function pauseMatch() {
    enqueue({ t: ClientMsg.PAUSE });
  }

  function setRules(rules) {
    enqueue({
      t: ClientMsg.RULES,
      roundTime: rules && rules.roundTime,
      winsNeeded: rules && rules.winsNeeded,
    });
  }

  function joinRoom(opts) {
    enqueue({
      t: ClientMsg.JOIN,
      code: opts && opts.code,
      nick: opts && opts.nick,
      team: opts && opts.team,
    });
  }

  function setTeam(team) {
    enqueue({ t: ClientMsg.TEAM, team });
  }

  function shuffleTeams() {
    enqueue({ t: ClientMsg.SHUFFLE });
  }

  function setMap(mapId) {
    state.mapId = typeof mapId === 'string' ? mapId : '';
    enqueue({ t: ClientMsg.MAP, mapId: state.mapId });
  }

  function leaveRoom() {
    enqueue({ t: ClientMsg.LEAVE });
  }

  function onSocketMessage(raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try {
      msg = decode(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case ServerMsg.RESERVED:
        emit('onReserved', typeof msg.code === 'string' ? msg.code : '');
        break;
      case ServerMsg.CREATED:
      case ServerMsg.JOINED:
        applyWelcome(msg);
        break;
      case ServerMsg.ROSTER:
        applyRoster(msg);
        break;
      case ServerMsg.SIGNAL:
        onSignal(msg.from, msg.data);
        break;
      case ServerMsg.RELAY:
        if (msg.from === state.playerId) return;
        deliverGame(msg.payload, msg.from);
        break;
      case ServerMsg.SNAPSHOT:
        deliverGame({ t: GameMsg.SNAPSHOT, snap: msg.snap }, state.hostId);
        break;
      case ServerMsg.CLOSED:
        onRoomClosed(msg.reason);
        break;
      case ServerMsg.ERROR:
        emit('onError', msg.message);
        break;
      default:
        break;
    }
  }

  function applyWelcome(msg) {
    state.playerId = msg.playerId;
    state.hostId = msg.hostId;
    state.roomCode = msg.code;
    state.isHost = msg.playerId === msg.hostId;
    state.serverHost = !!msg.serverHost;
    state.mapId = typeof msg.mapId === 'string' ? msg.mapId : '';
    emit('onWelcome', getState());
    updateTransport();
    maybeStartGuest();
  }

  function applyRoster(msg) {
    state.players = Array.isArray(msg.players)
      ? msg.players.map((p) => ({
        id: p && p.id,
        nick: p && p.nick,
        team: p && p.team,
      }))
      : [];
    if (typeof msg.hostId === 'string') state.hostId = msg.hostId;
    if (typeof msg.mapId === 'string' && msg.mapId) state.mapId = msg.mapId;
    state.isHost = !!state.playerId && state.playerId === state.hostId;
    if (typeof msg.serverHost === 'boolean') state.serverHost = msg.serverHost;
    emit('onRoster', state.players, getState());
    prunePeers();
    updateTransport();
    maybeStartGuest();
  }

  function maybeStartGuest() {
    if (guestStarted || webrtcGiveUp || state.serverHost || state.isHost || !state.playerId || !state.hostId) return;
    guestStarted = true;
    startGuestLink();
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      webrtcGiveUp = true;
      updateTransport();
    }, RELAY_FALLBACK_MS);
  }

  function deliverGame(payload, fromId) {
    let msg = payload;
    if (typeof msg === 'string') {
      try {
        msg = decode(msg);
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === GameMsg.INPUT) {
      if (!state.isHost) return;
      emit('onGame', msg, fromId);
      return;
    }
    if (msg.t === GameMsg.SNAPSHOT) {
      if (state.isHost && !state.serverHost) return;
      emit('onGame', msg, fromId);
    }
  }

  function sendSignal(to, data) {
    sendWs({ t: ClientMsg.SIGNAL, to, data });
  }

  function ensurePeer(peerId) {
    let peer = peers.get(peerId);
    if (peer) return peer;
    const pc = new RTCPeerConnection(ICE);
    peer = { pc, dc: null };
    peers.set(peerId, peer);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      sendSignal(peerId, { type: 'candidate', candidate: icePayload(ev.candidate) });
    };
    pc.onconnectionstatechange = () => updateTransport();
    return peer;
  }

  function attachChannel(peerId, dc) {
    const peer = peers.get(peerId);
    if (!peer || !dc) return;
    peer.dc = dc;
    dc.onopen = () => updateTransport();
    dc.onclose = () => updateTransport();
    dc.onerror = () => updateTransport();
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      deliverGame(ev.data, peerId);
    };
    if (dc.readyState === 'open') updateTransport();
  }

  function queueIce(peerId, candidate) {
    const peer = peers.get(peerId);
    if (peer && peer.pc.remoteDescription) {
      peer.pc.addIceCandidate(candidate).catch(() => {});
      return;
    }
    const list = pendingIce.get(peerId);
    if (list) list.push(candidate);
    else pendingIce.set(peerId, [candidate]);
  }

  function flushIce(peerId) {
    const list = pendingIce.get(peerId);
    pendingIce.delete(peerId);
    const peer = peers.get(peerId);
    if (!list || !peer) return;
    for (const candidate of list) {
      peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async function startGuestLink() {
    const myEpoch = epoch;
    const hostId = state.hostId;
    if (!hostId || typeof RTCPeerConnection !== 'function') {
      webrtcGiveUp = true;
      updateTransport();
      return;
    }
    try {
      const peer = ensurePeer(hostId);
      const dc = peer.pc.createDataChannel('game', DC_OPTIONS);
      attachChannel(hostId, dc);
      const offer = await peer.pc.createOffer();
      if (myEpoch !== epoch) return;
      await peer.pc.setLocalDescription(offer);
      if (myEpoch !== epoch) return;
      sendSignal(hostId, { type: 'offer', sdp: peer.pc.localDescription.sdp });
    } catch {
      updateTransport();
    }
  }

  async function handleOffer(from, data) {
    if (!data.sdp || peers.has(from) || typeof RTCPeerConnection !== 'function') return;
    const myEpoch = epoch;
    try {
      const peer = ensurePeer(from);
      peer.pc.ondatachannel = (ev) => {
        if (ev.channel && ev.channel.label && ev.channel.label !== 'game') return;
        attachChannel(from, ev.channel);
      };
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      if (myEpoch !== epoch) return;
      flushIce(from);
      const answer = await peer.pc.createAnswer();
      if (myEpoch !== epoch) return;
      await peer.pc.setLocalDescription(answer);
      if (myEpoch !== epoch) return;
      sendSignal(from, { type: 'answer', sdp: peer.pc.localDescription.sdp });
    } catch {
      updateTransport();
    }
  }

  async function handleAnswer(from, data) {
    const peer = peers.get(from);
    if (!peer || !data.sdp) return;
    const myEpoch = epoch;
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      if (myEpoch !== epoch) return;
      flushIce(from);
    } catch {
      updateTransport();
    }
  }

  function onSignal(from, data) {
    if (!state.playerId || !from || !data || typeof data !== 'object') return;
    if (state.isHost) {
      if (data.type === 'offer') {
        handleOffer(from, data);
        return;
      }
      if (data.type === 'candidate') {
        if (data.candidate == null) return;
        queueIce(from, data.candidate);
      }
      return;
    }
    if (from !== state.hostId) return;
    if (data.type === 'answer') {
      handleAnswer(from, data);
      return;
    }
    if (data.type === 'candidate') {
      if (data.candidate == null) return;
      queueIce(from, data.candidate);
    }
  }

  function prunePeers() {
    const live = new Set(state.players.map((p) => p.id));
    for (const id of [...peers.keys()]) {
      if (live.has(id)) continue;
      dropPeer(id);
    }
  }

  function dropPeer(id) {
    const peer = peers.get(id);
    peers.delete(id);
    pendingIce.delete(id);
    if (!peer) return;
    try {
      if (peer.dc) peer.dc.close();
    } catch {
      // already closed
    }
    try {
      peer.pc.close();
    } catch {
      // already closed
    }
  }

  function closePeers() {
    for (const id of [...peers.keys()]) dropPeer(id);
    pendingIce.clear();
  }

  function sendInput(seq, mask, ack, shot) {
    if (state.serverHost) {
      const msg = { t: ClientMsg.INPUT, seq, mask };
      if (ack != null) msg.ack = ack | 0;
      if (shot != null) msg.shot = shot | 0;
      sendWs(msg);
      return;
    }
    if (state.isHost) return;
    const packet = { t: GameMsg.INPUT, seq, mask };
    if (ack != null) packet.ack = ack | 0;
    if (shot != null) packet.shot = shot | 0;
    if (channelOpen(state.hostId)) {
      const peer = peers.get(state.hostId);
      try {
        peer.dc.send(encode(packet));
        return;
      } catch {
        // Channel died between the check and send. This packet goes by relay.
      }
    }
    sendWs({ t: ClientMsg.RELAY, to: state.hostId, payload: packet });
  }

  function sendSnapshot(match, sinceById) {
    if (!state.isHost || state.serverHost || !match) return;
    const guests = state.players.filter((p) => p.id !== state.playerId);
    if (guests.length === 0) return;
    const acks = sinceById || {};
    for (const guest of guests) {
      const snap = snapshot(match, { sinceEvent: acks[guest.id] || 0 });
      const packet = encode({ t: GameMsg.SNAPSHOT, snap });
      if (channelOpen(guest.id)) {
        try {
          peers.get(guest.id).dc.send(packet);
          continue;
        } catch {
          // This guest missed the datachannel copy. Relay this tick only.
        }
      }
      sendWs({ t: ClientMsg.RELAY, to: guest.id, payload: { t: GameMsg.SNAPSHOT, snap } });
    }
  }

  function resetRoom() {
    epoch += 1;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    guestStarted = false;
    webrtcGiveUp = false;
    closePeers();
    state.playerId = null;
    state.roomCode = null;
    state.hostId = null;
    state.isHost = false;
    state.players = [];
    state.mapId = '';
    state.serverHost = false;
    updateTransport();
  }

  function onRoomClosed(reason) {
    closePeers();
    emit('onClosed', reason);
    resetRoom();
  }

  function close() {
    pending.splice(0, pending.length);
    resetRoom();
    if (ws) {
      const sock = ws;
      ws = null;
      try {
        sock.close();
      } catch {
        // already closed
      }
    }
  }

  return {
    connect,
    reserveCode,
    createRoom,
    joinRoom,
    setTeam,
    shuffleTeams,
    setMap,
    startMatch,
    pauseMatch,
    setRules,
    leaveRoom,
    sendInput,
    sendSnapshot,
    close,
    getState,
  };
}
