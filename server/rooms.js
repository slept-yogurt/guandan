'use strict';

/**
 * 房间与协议中心。
 *
 * - 1~4 名真人联机，开始游戏时用 NPC 补齐 4 个座位
 * - 掉线进入宽限期：座位保留、对局继续（由 NPC 托管），带 token 可无缝续连
 * - 服务端权威：发牌、轮次、判定、升级全部在服务端完成，前端只负责渲染
 */

const crypto = require('crypto');
const { Game } = require('./game');
const { cardLabel, createDeck } = require('./cards');
const { randomInt } = require('./cards');
const { PROTOCOL } = require('./version');

const NPC_NAMES = ['老张', '小李', '阿珍', '大熊', '阿May', '老王', '丁丁', '阿福'];

function newToken() {
  return crypto.randomBytes(18).toString('hex');
}

function newRoomId(taken) {
  for (let i = 0; i < 200; i++) {
    const id = String(randomInt(9000) + 1000);
    if (!taken.has(id)) return id;
  }
  return String(Date.now()).slice(-6);
}

/** 令牌桶：capacity 个令牌，按 ratePerSec 恢复。 */
class Bucket {
  constructor(capacity, ratePerSec) {
    this.capacity = capacity;
    this.rate = ratePerSec;
    this.tokens = capacity;
    this.ts = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.ts) / 1000) * this.rate);
    this.ts = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class Client {
  constructor(conn) {
    this.conn = conn;
    this.token = newToken();
    this.name = '';
    this.roomId = null;
    this.seat = -1;
    // 观战者：seat 恒为 -1，roomId 指向被观战的房间，watchSeat 是选定要看的座位。
    // watchSeat 一旦选定就不再允许更改（需求⑥），所以这里只在 watch 消息里赋值一次。
    this.spectating = false;
    this.watchSeat = -1;
    this.offline = false;
    this.graceTimer = null;
    // 兜底桶挡原始洪泛；放大桶只管会让服务端向其他人广播的消息
    this.flood = new Bucket(400, 150);
    this.amp = new Bucket(20, 5);
  }
  send(obj) {
    if (!this.conn || this.conn.closed) return;
    this.conn.send(JSON.stringify(obj));
  }
}

class Room {
  constructor(id, host, opts) {
    opts = opts || {};
    this.id = id;
    this.createdAt = Date.now();
    this.seats = [null, null, null, null]; // {type:'human'|'npc', name, client, offline}
    this.game = null;
    this.chats = [];
    this.hostSeat = 0;
    this.timer = null;
    this.lastActivity = Date.now();
    this.ended = false;
    // 建房时由房主决定：是否允许观战、从哪一级打起。
    // 两者都只在建房那一刻生效，中途不可改（改级牌会让进行中的对局失去意义）。
    this.allowSpectate = !!opts.allowSpectate;
    const lv = Number(opts.level);
    this.startLevel = Number.isInteger(lv) && lv >= 2 && lv <= 14 ? lv : 2;
    this.spectators = new Set();
    this.place(host, 0);
  }

  place(client, seat) {
    this.seats[seat] = { type: 'human', name: client.name || '玩家', client, offline: false };
    client.roomId = this.id;
    client.seat = seat;
    this.lastActivity = Date.now();
  }

  freeSeat(seat) {
    this.seats[seat] = null;
  }

  humans() {
    return this.seats.map((s, i) => ({ s, i })).filter(x => x.s && x.s.type === 'human' && x.s.client);
  }

  allHumansIncludingOffline() {
    return this.seats.map((s, i) => ({ s, i })).filter(x => x.s && x.s.type === 'human');
  }

  /** 观战者也算房间成员，房间广播必须带上他们，否则他们看到的画面永远是静止的。 */
  spectatorsAlive() {
    const out = [];
    for (const c of this.spectators) {
      if (c.conn && !c.conn.closed) out.push(c);
    }
    return out;
  }

  broadcast() {
    for (const { s } of this.humans()) this.pushRoom(s.client);
    for (const c of this.spectatorsAlive()) this.pushRoom(c);
    if (this.game) {
      for (const { s, i } of this.humans()) {
        s.client.send({ t: 'game', ...this.game.viewFor(i), spectating: false });
      }
      for (const c of this.spectatorsAlive()) {
        // 还没选人时不发对局视图：让前端停在「选一位玩家观战」这一步
        if (c.watchSeat >= 0) {
          c.send({ t: 'game', ...this.game.viewFor(c.watchSeat), spectating: true, watchSeat: c.watchSeat });
        }
      }
    }
  }

  pushRoom(client) {
    client.send({
      t: 'room', ...this.view(),
      you: client.seat,
      spectating: !!client.spectating,
      watchSeat: client.watchSeat,
    });
  }

  view() {
    return {
      id: this.id,
      hostSeat: this.hostSeat,
      started: !!this.game && this.game.phase !== 'gameEnd',
      phase: this.game ? this.game.phase : 'waiting',
      allowSpectate: this.allowSpectate,
      level: this.game ? this.game.level : this.startLevel,
      spectators: this.spectators.size,
      seats: this.seats.map((s, i) => (s ? {
        name: s.name,
        type: s.type,
        offline: !!s.offline,
        auto: !!(this.game && this.game.isAuto(i)),
        manualAuto: !!(this.game && this.game.seats[i] && this.game.seats[i].manualAuto),
        isHost: i === this.hostSeat,
      } : null)),
      chats: this.chats.slice(-30),
    };
  }
}

class Hub {
  constructor(opts) {
    opts = opts || {};
    this.rooms = new Map();
    this.clients = new Set();
    this.byToken = new Map();
    this.graceMs = Number(process.env.WS_DISCONNECT_GRACE || opts.graceMs || 45000);
    this.npcDelay = opts.npcDelay != null ? opts.npcDelay : Number(process.env.NPC_DELAY || 800);
    // 一局结束后停顿一下再开下一局，让「第 N 局结束」的结果提示能被看见
    this.roundDelay = opts.roundDelay != null ? opts.roundDelay : Number(process.env.ROUND_DELAY || 2200);
    this.log = opts.log || (() => {});
  }

  attach(wss) {
    wss.on('connection', (conn, req) => this._onConnection(conn, req));
    this.sweep = setInterval(() => this._gc(), 30000);
    if (this.sweep.unref) this.sweep.unref();
  }

  // ------------------------------------------------------------- 连接管理

  /**
   * 统一发 welcome。首次连接 / 续连 / hello 三处都走这里。
   *
   * 带上 `protocol` 是关键：前端拿它和自己期望的版本比对，对不上就报警。
   * 旧服务端不会有这个字段 → 前端立刻能判断出"对面是旧代码"，
   * 而不是让玩家对着一个点了没反应的按钮发呆。
   */
  _sendWelcome(client, resumed, name) {
    const msg = {
      t: 'welcome',
      token: client.token,
      id: client.token.slice(0, 8),
      resumed: !!resumed,
      protocol: PROTOCOL,
    };
    if (name) msg.name = name;
    client.send(msg);
  }

  _onConnection(conn, req) {
    let token = '';
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('resume') || '';
    } catch (e) { token = ''; }

    // token 标识的是「会话」，不是「连接」：同一个 token 再来就把旧连接顶掉。
    // 否则刷新页面时新旧连接一旦错序到达（新连接先到、旧连接的 close 还没处理），
    // 旧会话会被当成"全新客户端"，座位随后被 NPC 接管 —— 玩家回来就没了操作权。
    const old = token ? this.byToken.get(token) : null;
    if (old) { this._resume(old, conn); return; }

    const client = new Client(conn);
    this.clients.add(client);
    this.byToken.set(client.token, client);

    conn.on('message', raw => this._onMessage(client, raw));
    conn.on('close', () => this._onDisconnect(client, conn));
    conn.on('error', () => this._onDisconnect(client, conn));

    this._sendWelcome(client, false);
    this._pushRooms(client);
  }

  _resume(client, conn) {
    /**
     * ⚠️ 这里的**顺序是有讲究的，不能随手调换**。
     *
     * 自写的 WS 实现里 `close()` 会**同步** `emit('close')`（见 `server/ws.js` 的
     * `close()` → `_destroy()`），于是下面那句 `prev.close()` 会**同步重入**
     * `_onDisconnect(client, prev)`。如果那时 `client.conn` 还指着 `prev`，
     * `_onDisconnect` 里那句守卫 `client.conn !== conn` 就不成立，它会真的往下跑：
     *
     *   - 不在房间里 → `this.clients.delete(client)` + `this.byToken.delete(token)`，
     *     而 `_resume` 之后再也不会把 client 注册回去 → 这个页面从此收不到大厅房间列表
     *     更新，刷新还会拿到一个**全新会话**（实测就是这么发现问题的）；
     *   - 在房间里 → 顺手给座位打上掉线托管、再起一个宽限定时器
     *     （现在只是靠下面那句 clearTimeout 凑巧兜住，顺序一改就漏）。
     *
     * 所以：**先把 `client.conn` 换成新连接，再去关旧连接**。
     * 这样 `_onDisconnect` 一进门就被守卫挡掉 —— 旧连接的关闭本来也不该
     * 把已经被新连接接管的会话标记成掉线。
     */
    const prev = client.conn;
    client.offline = false;
    client.conn = conn;
    if (prev && prev !== conn && !prev.closed) {
      // 4001 是给客户端的明确信号：「这个会话被新连接顶掉了，别自动重连」。
      // 用 1000（正常关闭）的话，前端分不清"网络抖动"和"被顶号"，
      // 于是两个页面会互相抢 token，无限顶号。
      try { prev.close(4001, 'replaced by new connection'); } catch (e) { /* ignore */ }
    }
    if (client.graceTimer) { clearTimeout(client.graceTimer); client.graceTimer = null; }
    conn.on('message', raw => this._onMessage(client, raw));
    conn.on('close', () => this._onDisconnect(client, conn));
    conn.on('error', () => this._onDisconnect(client, conn));

    // 只有座位还在、且仍然是这个客户端的，才算续连成功。
    // 已经离开 / 座位被别人坐了的，直接当新会话，别把别人的座位抢过来。
    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    let restored = false;
    let asSpectator = false;
    if (room) {
      if (client.spectating) {
        // 观战者续连：只要还在观战名单里，就恢复原来看的那位玩家。
        // watchSeat 不动 —— 需求⑥要求选定后不能更改，刷新也不该重置它。
        if (room.spectators.has(client)) { restored = true; asSpectator = true; }
      } else {
        const seatEntry = room.seats[client.seat];
        if (seatEntry && seatEntry.type === 'human' &&
            (seatEntry.client === client || seatEntry.offline)) {
          seatEntry.client = client;
          seatEntry.offline = false;
          if (room.game) {
            const gs = room.game.seats[client.seat];
            // 只清掉「掉线」这种临时托管；玩家自己勾的 manualAuto 必须保留
            if (gs) { gs.auto = false; gs.offline = false; }
          }
          restored = true;
        }
      }
    }
    if (!restored) {
      if (room && client.spectating) room.spectators.delete(client);
      client.roomId = null; client.seat = -1;
      client.spectating = false; client.watchSeat = -1;
    }

    this._sendWelcome(client, restored);
    if (restored && asSpectator) {
      room.pushRoom(client);
      if (room.game && client.watchSeat >= 0) {
        client.send({ t: 'game', ...room.game.viewFor(client.watchSeat), spectating: true, watchSeat: client.watchSeat });
      }
      room.broadcast();
    } else if (restored) {
      room.pushRoom(client);
      if (room.game) client.send({ t: 'game', ...room.game.viewFor(client.seat), spectating: false });
      room.broadcast();
      this._pump(room);
    } else {
      this._pushRooms(client);
    }
    this.log('resume ' + client.name + ' room=' + (restored ? room.id : '-') + (asSpectator ? ' (spectator)' : ''));
  }

  _onDisconnect(client, conn) {
    // 自写 WS 服务端的 destroy() 在已关闭时会再 emit 一次 close；
    // 续连后旧连接迟到的 close 也必须忽略，否则会把新连接误判成掉线。
    if (conn && client.conn !== conn) return;
    if (client.offline) return;
    client.offline = true;
    client.conn = null;

    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.clients.delete(client);
      this.byToken.delete(client.token);
      return;
    }
    const seatEntry = room.seats[client.seat];
    if (seatEntry) seatEntry.offline = true;

    const playing = room.game && (room.game.phase === 'play' || room.game.phase === 'tribute');
    if (playing) {
      const gs = room.game.seats[client.seat];
      if (gs) { gs.auto = true; gs.offline = true; }
    }
    room.broadcast();
    this._pump(room);
    client.graceTimer = setTimeout(() => this._expireGrace(client), this.graceMs);
    if (client.graceTimer.unref) client.graceTimer.unref();
    this.log('offline(grace ' + (playing ? 'playing' : 'waiting') + ') ' + client.name + ' room=' + room.id);
  }

  _expireGrace(client) {
    client.graceTimer = null;
    try {
      this._expireGraceInner(client);
    } catch (e) {
      this.log('grace expire error: ' + (e && e.stack || e));
    }
  }

  _expireGraceInner(client) {
    // 已经主动离开的人不该在这里被当成掉线处理（_leave 会清掉 graceTimer，
    // 这里再兜一层，免得把还连着的玩家从 clients 里删掉）
    if (!client.roomId) return;
    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.clients.delete(client);
      this.byToken.delete(client.token);
      return;
    }

    // 观战者宽限期到点：从观战名单里摘掉。房间本身不受影响（没人在打的话另有 GC 收）。
    if (client.spectating) {
      room.spectators.delete(client);
      client.spectating = false;
      client.watchSeat = -1;
      client.roomId = null;
      client.seat = -1;
      this.clients.delete(client);
      this.byToken.delete(client.token);
      room.broadcast();
      this._broadcastRooms();
      this.log('spectator gone from room ' + room.id);
      return;
    }

    const playing = room.game && (room.game.phase === 'play' || room.game.phase === 'tribute');
    if (playing) {
      // 对局中：座位转为常驻托管，对局继续，人回来还能接管
      const gs = room.game.seats[client.seat];
      if (gs) { gs.auto = true; gs.offline = true; }
      this.log('grace expired, auto-play seat ' + client.seat + ' in room ' + room.id);
      room.broadcast();
      this._pump(room);
      return;
    }
    // 还没开局：释放座位，避免僵尸座位堆积
    const seat = client.seat;
    room.freeSeat(seat);
    client.roomId = null;
    client.seat = -1;
    if (room.hostSeat === seat) {
      const next = room.seats.findIndex(s => s && s.type === 'human');
      room.hostSeat = next < 0 ? 0 : next;
    }
    if (room.humans().length === 0) this._destroyRoom(room);
    else room.broadcast();
    this._broadcastRooms();
    this.log('grace expired, released seat ' + seat + ' in room ' + room.id);
  }

  // ---------------------------------------------------------------- 协议

  _onMessage(client, raw) {
    if (!client.flood.take()) return; // JSON.parse 之前先挡洪泛
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    const AMP = ['list', 'create', 'join', 'quick', 'solo', 'again'];
    if (AMP.includes(msg.t) && !client.amp.take()) {
      client.send({ t: 'error', msg: '操作太频繁，稍等一下' });
      return;
    }

    try {
      this._dispatch(client, msg);
    } catch (e) {
      this.log('handler error: ' + (e && e.stack || e));
      client.send({ t: 'error', msg: '服务端处理出错' });
    }
  }

  _dispatch(client, msg) {
    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    switch (msg.t) {
      case 'hello': {
        client.name = cleanName(msg.name) || client.name || '玩家';
        this._sendWelcome(client, !!room, client.name);
        if (room) {
          const s = room.seats[client.seat];
          if (s) s.name = client.name;
          room.broadcast();
        }
        return;
      }
      case 'list':
        this._pushRooms(client);
        return;

      case 'create': {
        client.name = cleanName(msg.name) || client.name || '玩家';
        if (room) this._leave(client);
        const id = newRoomId(this.rooms);
        const r = new Room(id, client, { allowSpectate: msg.allowSpectate, level: msg.level });
        this.rooms.set(id, r);
        r.pushRoom(client);
        this._broadcastRooms();
        return;
      }

      case 'quick': {
        client.name = cleanName(msg.name) || client.name || '玩家';
        if (room) {
          if (client.spectating) this._leave(client);
          else { room.pushRoom(client); return; }
        }
        let target = null;
        for (const r of this.rooms.values()) {
          // 这句 `r.game` 在当前实现下是**防御性**的：_start() 会把空位补成 NPC，
          // 于是「已开局」必然「满员」，下一行的空位检查已经能把它排除掉。
          // 但一旦 _start 改成懒补位（开局时保留空位），它就是唯一防线 —— 留着。
          // （tools/test-ws.js 里用白盒挖空位的方式专门盯住这条分支。）
          if (r.game) continue;
          if (r.seats.some(s => !s)) { target = r; break; }
        }
        if (!target) {
          const id = newRoomId(this.rooms);
          target = new Room(id, client);
          this.rooms.set(id, target);
        } else {
          const idx = target.seats.findIndex(s => !s);
          target.place(client, idx);
        }
        target.broadcast();
        this._broadcastRooms();
        return;
      }

      case 'solo': {
        client.name = cleanName(msg.name) || client.name || '玩家';
        if (room) this._leave(client);
        const id = newRoomId(this.rooms);
        const r = new Room(id, client, { allowSpectate: msg.allowSpectate, level: msg.level });
        this.rooms.set(id, r);
        this._start(r, client);
        this._broadcastRooms();
        return;
      }

      case 'join': {
        client.name = cleanName(msg.name) || client.name || '玩家';
        const target = this.rooms.get(String(msg.roomId || '').trim());
        if (!target) { client.send({ t: 'error', msg: '房间不存在' }); return; }
        if (target.game) { client.send({ t: 'error', msg: '这局已经开始了' }); return; }
        if (client.roomId && (client.spectating || client.roomId !== target.id)) this._leave(client);
        if (target.seats[client.seat] && target.seats[client.seat].client === client) { target.pushRoom(client); return; }
        const idx = target.seats.findIndex(s => !s);
        if (idx < 0) { client.send({ t: 'error', msg: '房间满了' }); return; }
        target.place(client, idx);
        target.broadcast();
        this._broadcastRooms();
        return;
      }

      /**
       * 进入观战。观战者不占座位，roomId 指向房间、seat 恒为 -1。
       * 只有房主建房时勾了「允许观战」的房间才能进 —— 否则拒绝。
       */
      case 'spectate': {
        const target = this.rooms.get(String(msg.roomId || '').trim());
        if (!target) { client.send({ t: 'error', msg: '房间不存在' }); return; }
        if (!target.allowSpectate) { client.send({ t: 'error', msg: '这个房间不允许观战' }); return; }
        if (client.spectating && client.roomId === target.id) { target.pushRoom(client); return; }
        if (client.roomId) this._leave(client);
        client.name = cleanName(msg.name) || client.name || '观众';
        client.spectating = true;
        client.watchSeat = -1;
        client.seat = -1;
        client.roomId = target.id;
        client.offline = false;
        target.spectators.add(client);
        target.pushRoom(client);
        this._broadcastRooms();
        return;
      }

      /**
       * 选定要观战的那位玩家。需求⑥：选定后不可更改 —— 已经选过就直接拒绝，
       * 想换只能退出观战重新进来。
       */
      case 'watch': {
        if (!client.spectating || !room) return;
        if (client.watchSeat >= 0) { client.send({ t: 'error', msg: '观战对象选定后不能更改' }); return; }
        const seat = Number(msg.seat);
        if (!(seat >= 0 && seat < 4)) return;
        if (!room.seats[seat]) { client.send({ t: 'error', msg: '这个座位还没有人' }); return; }
        client.watchSeat = seat;
        room.pushRoom(client);
        if (room.game) {
          client.send({ t: 'game', ...room.game.viewFor(seat), spectating: true, watchSeat: seat });
        }
        return;
      }

      case 'sit': {
        if (!room || room.game) return;
        if (client.seat < 0) return;
        const seat = Number(msg.seat);
        if (!(seat >= 0 && seat < 4)) return;
        if (room.seats[seat]) { client.send({ t: 'error', msg: '这个座位有人了' }); return; }
        const from = client.seat;
        room.freeSeat(from);
        room.place(client, seat);
        if (room.hostSeat === from) room.hostSeat = seat;
        room.broadcast();
        return;
      }

      case 'start': {
        if (!room) return;
        if (client.seat !== room.hostSeat) { client.send({ t: 'error', msg: '只有房主能开始' }); return; }
        this._start(room, client);
        return;
      }

      /** 玩家主动开关托管（需求④）：交给 NPC AI 代打，随时可以拿回来。 */
      case 'auto': {
        if (!room || !room.game) return;
        if (client.seat < 0) return;
        room.game.setAuto(client.seat, !!msg.on);
        room.broadcast();
        this._pump(room);
        return;
      }

      case 'play': {
        if (!room || !room.game || client.seat < 0) return;
        const r = room.game.play(client.seat, msg.cards || []);
        if (r.error) { client.send({ t: 'error', msg: r.error }); return; }
        room.broadcast();
        this._pump(room);
        return;
      }

      case 'pass': {
        if (!room || !room.game || client.seat < 0) return;
        const r = room.game.pass(client.seat);
        if (r.error) { client.send({ t: 'error', msg: r.error }); return; }
        room.broadcast();
        this._pump(room);
        return;
      }

      case 'return': {
        if (!room || !room.game || client.seat < 0) return;
        const r = room.game.returnTribute(client.seat, String(msg.card || ''));
        if (r.error) { client.send({ t: 'error', msg: r.error }); return; }
        room.broadcast();
        this._pump(room);
        return;
      }

      case 'hint': {
        if (!room || !room.game || client.seat < 0) return;
        const list = room.game.hint(client.seat);
        client.send({ t: 'hint', options: list });
        return;
      }

      case 'chat': {
        if (!room) return;
        // 只接受字符串：早期写法 `String(msg.text || '')` 会把 `{text:{}}` 变成
        // "[object Object]" 当聊天内容广播出去（和 cleanName 同一类输入校验缺失）。
        if (typeof msg.text !== 'string') return;
        const text = msg.text.slice(0, 120).trim();
        if (!text) return;
        room.chats.push({ seat: client.seat, name: client.name, text, ts: Date.now() });
        if (room.chats.length > 100) room.chats.splice(0, room.chats.length - 100);
        room.broadcast();
        return;
      }

      case 'again': {
        if (!room) return;
        // 观战者没有重开房间的资格（他没坐在任何座位上）
        if (client.seat < 0) return;
        if (!room.game || room.game.phase !== 'gameEnd') { client.send({ t: 'error', msg: '当前不能重开' }); return; }
        room.game = null;
        room.ended = false;
        room.seats = room.seats.map(s => (s && s.type === 'npc' ? null : s));
        room.broadcast();
        this._broadcastRooms();
        return;
      }

      case 'leave':
        this._leave(client);
        return;

      default:
        return;
    }
  }

  /**
   * 主动离开房间。
   *
   * 关键：离开 ≠ 掉线。这里绝不能走 _onDisconnect —— 那会把 client.conn 置空，
   * 之后 client.send() 静默丢弃所有消息，玩家回大厅后点创建/加入/匹配全都"没反应"。
   * 连接必须保持可用，只是把人从座位上摘下来。
   */
  _leave(client) {
    const room = client.roomId ? this.rooms.get(client.roomId) : null;

    if (client.graceTimer) { clearTimeout(client.graceTimer); client.graceTimer = null; }

    // 观战者离开：只从观战名单里摘掉，房间本身（座位/对局）完全不受影响。
    if (client.spectating) {
      if (room) { room.spectators.delete(client); room.broadcast(); this._broadcastRooms(); }
      client.spectating = false;
      client.watchSeat = -1;
      client.roomId = null;
      client.seat = -1;
      client.offline = false;
      this._pushRooms(client);
      return;
    }

    if (!room) {
      client.roomId = null;
      client.seat = -1;
      client.offline = false;
      this._pushRooms(client);
      return;
    }

    const seat = client.seat;
    const entry = room.seats[seat];
    // 只要这一局已经存在（不管在 play / tribute / roundEnd / gameEnd），
    // 离开者的游戏座位都必须转成 NPC —— 否则游戏里的座位成了"无主 human"，
    // isAuto() 判 false，轮到它时没人驱动，整局就卡死在那儿了。
    const hasGame = !!room.game;

    if (entry) {
      if (hasGame) {
        room.seats[seat] = { type: 'npc', name: entry.name, client: null, offline: false };
        const gs = room.game.seats[seat];
        if (gs) {
          gs.auto = true;
          gs.offline = false;
          gs.isNPC = true;
          gs.name = entry.name;
        }
        room.game.pushLog(entry.name + ' 离开了，座位由 NPC 接管');
      } else {
        room.freeSeat(seat);
      }
    }

    client.roomId = null;
    client.seat = -1;
    client.offline = false;

    if (room.hostSeat === seat) {
      const next = room.seats.findIndex(s => s && s.type === 'human');
      room.hostSeat = next < 0 ? 0 : next;
    }

    if (room.humans().length === 0) {
      this._destroyRoom(room);
    } else {
      room.broadcast();
      this._pump(room);
    }
    this._broadcastRooms();
    this._pushRooms(client);
  }

  _start(room, byClient) {
    if (room.game) { if (byClient) byClient.send({ t: 'error', msg: '对局已经开始了' }); return; }
    const used = new Set();
    for (const s of room.seats) if (s) used.add(s.name);

    const players = [];
    for (let i = 0; i < 4; i++) {
      const s = room.seats[i];
      if (s) {
        players.push({ name: s.name, isNPC: s.type === 'npc', auto: s.type === 'npc' || !!s.offline });
      } else {
        const name = pickNpcName(used);
        used.add(name);
        room.seats[i] = { type: 'npc', name, client: null, offline: false };
        players.push({ name, isNPC: true, auto: true });
      }
    }
    room.game = new Game(players, { level: room.startLevel });
    room.ended = false;
    room.game.startRound();
    room.broadcast();
    this._broadcastRooms();
    this._pump(room);
  }

  /** 推动自动座位（NPC / 托管）行动。 */
  _pump(room) {
    if (!room.game) return;
    if (room.timer) return;
    const g = room.game;

    if (g.phase === 'roundEnd') {
      room.timer = setTimeout(() => {
        room.timer = null;
        if (!this.rooms.has(room.id)) return;
        try {
          g.nextRound();
          room.broadcast();
        } catch (e) {
          // 定时器回调里抛异常 = 整个服务进程崩掉，这里必须兜住
          this.log('nextRound error in room ' + room.id + ': ' + (e && e.stack || e));
        }
        this._pump(room);
      }, this.roundDelay);
      if (room.timer.unref) room.timer.unref();
      return;
    }
    if (g.phase === 'gameEnd') return;

    const isTribute = g.phase === 'tribute';
    const seat = g.turn;
    const needsAction = isTribute
      ? (g.tribute && g.tribute.pending.some(p => g.isAuto(p.seat)))
      : g.isAuto(seat);
    if (!needsAction) return;

    room.timer = setTimeout(() => {
      room.timer = null;
      if (!this.rooms.has(room.id) || room.game !== g) return;
      try {
        const moved = g.stepAuto();
        if (moved) room.broadcast();
      } catch (e) {
        // 一个房间出问题不能把整个服务进程带走（定时器里抛异常 = 全局崩溃）
        this.log('stepAuto error in room ' + room.id + ': ' + (e && e.stack || e));
      }
      this._pump(room);
    }, this.npcDelay);
    if (room.timer.unref) room.timer.unref();
  }

  _pushRooms(client) {
    client.send({ t: 'rooms', rooms: this.roomList() });
  }

  _broadcastRooms() {
    const payload = { t: 'rooms', rooms: this.roomList() };
    for (const c of this.clients) {
      if (c.roomId) continue;
      if (!c.conn || c.conn.closed) continue;
      c.send(payload);
    }
  }

  roomList() {
    const out = [];
    for (const r of this.rooms.values()) {
      const humanCount = r.seats.filter(s => s && s.type === 'human').length;
      out.push({
        id: r.id,
        humans: humanCount,
        open: r.seats.filter(s => !s).length,
        started: !!r.game,
        level: r.game ? r.game.level : r.startLevel,
        round: r.game ? r.game.round : 0,
        allowSpectate: !!r.allowSpectate,
        spectators: r.spectators.size,
      });
    }
    return out.sort((a, b) => (a.started === b.started ? a.id.localeCompare(b.id) : a.started ? 1 : -1));
  }

  _destroyRoom(room) {
    if (room.timer) clearTimeout(room.timer);
    // 房间没了，还在观战的人要回到大厅，否则他们的界面会停在一个已经不存在的房间上
    for (const c of room.spectators) {
      c.spectating = false;
      c.watchSeat = -1;
      if (c.roomId === room.id) { c.roomId = null; c.seat = -1; }
      this._pushRooms(c);
    }
    room.spectators.clear();
    this.rooms.delete(room.id);
    this._broadcastRooms();
  }

  _gc() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      try {
        const idle = now - room.lastActivity;
        const alive = room.humans().length > 0;
        if (!alive && idle > 60000) { this._destroyRoom(room); continue; }
        if (room.game && room.game.phase === 'gameEnd' && idle > 30 * 60000) this._destroyRoom(room);
      } catch (e) {
        // 定时器里抛异常会把整个进程带走；一个房间坏了不该影响别的房间
        this.log('gc error on room ' + room.id + ': ' + (e && e.stack || e));
      }
    }
  }

  stats() {
    return { rooms: this.rooms.size, clients: this.clients.size };
  }
}

function pickNpcName(used) {
  const pool = NPC_NAMES.filter(n => !used.has(n));
  const list = pool.length ? pool : NPC_NAMES;
  return list[randomInt(list.length)];
}

/**
 * 昵称清洗。**只接受字符串** —— 早期写法是 `String(name || '')`，
 * 于是 `{name: {}}` 这类畸形输入会被 String() 成 "[object Obje"（截断后）
 * 直接挂在座位上。非字符串一律当空处理，交给调用方回退到原名 / '玩家'。
 */
function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12);
}

module.exports = { Hub, Room, Client, Bucket };
