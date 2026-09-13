const express = require('express');
require('dotenv').config();
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http = require('http');
const socketIO = require('socket.io');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 6867;
const IS_WINDOWS = os.platform() === 'win32';
const SHELL = IS_WINDOWS ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash';
const HOME_DIR = IS_WINDOWS ? os.homedir() : os.homedir();
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const FRIENDSHIP_FILE = path.join(DATA_DIR, 'friends.json');

fs.ensureDirSync(DATA_DIR);

const app = express();
const server = http.createServer(app);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'aurex-ai-panel-super-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});

const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────────────────────
// DATA STORE
// ─────────────────────────────────────────────

function loadDB(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('DB load error:', e); }
  return fallback;
}

function saveDB(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.error('DB save error:', e); }
}

let users = loadDB(USERS_FILE, {});
let friendships = loadDB(FRIENDSHIP_FILE, {});

function saveUsers() { saveDB(USERS_FILE, users); }
function saveFriends() { saveDB(FRIENDSHIP_FILE, friendships); }

// ─────────────────────────────────────────────
// PASSPORT / GOOGLE OAUTH
// ─────────────────────────────────────────────

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = users[id];
  done(null, user || null);
});

const HAS_GOOGLE = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (HAS_GOOGLE) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let user = Object.values(users).find(u => u.googleId === profile.id);
      if (!user) {
        const existing = Object.values(users).find(u => u.email === profile.emails[0].value);
        if (existing) {
          existing.googleId = profile.id;
          existing.name = profile.displayName || existing.name;
          existing.avatar = profile.photos?.[0]?.value || existing.avatar;
          user = existing;
          saveUsers();
        } else {
          const id = uuidv4();
          let username = (profile.displayName || profile.emails[0].value.split('@')[0]).replace(/\s+/g, '.').toLowerCase();
          let base = username;
          let counter = 1;
          while (Object.values(users).find(u => u.username === username)) {
            username = `${base}${counter++}`;
          }
          user = {
            id,
            googleId: profile.id,
            username,
            email: profile.emails[0].value.toLowerCase(),
            name: profile.displayName,
            avatar: profile.photos?.[0]?.value,
            friends: [],
            createdAt: new Date().toISOString()
          };
          users[id] = user;
          friendships[id] = [];
          saveUsers();
          saveFriends();
        }
      }
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  }));
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────

function isAuthed(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// Google OAuth routes (only when configured)
if (HAS_GOOGLE) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
  );
} else {
  // No Google configured: demo login is the only path. Warn once.
  console.log('  [i] Google OAuth not configured - running in demo mode.');
  console.log('      Set GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET in .env to enable Google login.');
}

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ authed: false });
  const u = users[req.user.id];
  res.json({
    authed: true,
    user: {
      id: u.id,
      username: u.username,
      email: u.email,
      name: u.name,
      avatar: u.avatar,
      friends: u.friends || []
    }
  });
});

app.get('/api/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ─────────────────────────────────────────────
// API: FRIENDS
// ─────────────────────────────────────────────

app.get('/api/friends', isAuthed, (req, res) => {
  const u = users[req.user.id];
  const friendList = (u.friends || []).map(id => {
    const f = users[id];
    if (!f) return null;
    return { id: f.id, username: f.username, name: f.name, avatar: f.avatar, email: f.email };
  }).filter(Boolean);
  res.json({ friends: friendList });
});

app.post('/api/friends/add', isAuthed, (req, res) => {
  const { usernameOrEmail } = req.body;
  if (!usernameOrEmail) return res.status(400).json({ error: 'Enter a username or email' });

  const query = usernameOrEmail.trim().toLowerCase();
  const target = Object.values(users).find(u =>
    u.username.toLowerCase() === query || u.email.toLowerCase() === query
  );

  if (!target) return res.status(404).json({ error: `No user found with "${query}"` });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });

  const me = users[req.user.id];
  if ((me.friends || []).includes(target.id)) {
    return res.status(400).json({ error: `${target.username} is already your friend` });
  }

  me.friends = me.friends || [];
  me.friends.push(target.id);
  target.friends = target.friends || [];
  target.friends.push(req.user.id);
  saveUsers();

  friendships[req.user.id] = friendships[req.user.id] || [];
  friendships[req.user.id].push({
    friendId: target.id,
    addedAt: new Date().toISOString(),
    by: req.user.id
  });
  saveFriends();

  res.json({
    success: true,
    message: `${target.username} added! They now have access to your panel.`,
    friend: { id: target.id, username: target.username, name: target.name, avatar: target.avatar }
  });
});

app.post('/api/friends/remove', isAuthed, (req, res) => {
  const { id } = req.body;
  const me = users[req.user.id];
  me.friends = (me.friends || []).filter(f => f !== id);
  if (users[id]) {
    users[id].friends = (users[id].friends || []).filter(f => f !== req.user.id);
  }
  saveUsers();
  res.json({ success: true });
});

app.post('/api/friends/grant', isAuthed, (req, res) => {
  // friend auto gets access - this endpoint confirms
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// API: FILE MANAGER
// ─────────────────────────────────────────────

function safeResolve(base, rel) {
  const target = path.resolve(base, rel || '.');
  if (!target.startsWith(base)) return null;
  return target;
}

app.get('/api/fs', isAuthed, (req, res) => {
  const targetDir = req.query.path || os.homedir();
  const base = os.homedir();
  let root;
  try {
    root = safeResolve(base, targetDir) || targetDir;
    if (!fs.existsSync(root)) return res.status(404).json({ error: 'Path not found' });

    const stats = fs.statSync(root);
    if (!stats.isDirectory()) {
      return res.json({
        type: 'file',
        path: root,
        name: path.basename(root),
        size: stats.size,
        modified: stats.mtime
      });
    }

    const items = fs.readdirSync(root).map(name => {
      const full = path.join(root, name);
      try {
        const s = fs.statSync(full);
        return {
          name,
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.isDirectory() ? null : s.size,
          modified: s.mtime,
          path: full
        };
      } catch (e) { return null; }
    }).filter(Boolean);

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ type: 'dir', path: root, name: path.basename(root), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/mkdir', isAuthed, (req, res) => {
  const { path: p } = req.body;
  try {
    fs.ensureDirSync(p);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/rm', isAuthed, (req, res) => {
  const { path: p } = req.body;
  try {
    fs.removeSync(p);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/read', isAuthed, (req, res) => {
  const { path: p } = req.body;
  try {
    if (fs.statSync(p).size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large to preview (>5MB)' });
    }
    const content = fs.readFileSync(p, 'utf8');
    res.json({ content, path: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/write', isAuthed, (req, res) => {
  const { path: p, content } = req.body;
  try {
    fs.writeFileSync(p, content, 'utf8');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/upload', isAuthed, (req, res) => {
  const { path: p, name, content } = req.body;
  try {
    const target = path.join(p, name);
    fs.writeFileSync(target, Buffer.from(content, 'base64'));
    res.json({ success: true, file: target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fs/download', isAuthed, (req, res) => {
  const p = req.query.path;
  try {
    res.download(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/rename', isAuthed, (req, res) => {
  const { oldPath, newName } = req.body;
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    fs.renameSync(oldPath, newPath);
    res.json({ success: true, path: newPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// API: SYSTEM INFO
// ─────────────────────────────────────────────

app.get('/api/system', isAuthed, (req, res) => {
  try {
    const mem = os.totalmem() / (1024 ** 3);
    const freemem = os.freemem() / (1024 ** 3);
    const cpuModel = os.cpus()[0]?.model || 'unknown';
    const cpuCount = os.cpus().length;

    let disk = { total: 0, used: 0, free: 0, percent: 0 };
    try {
      if (IS_WINDOWS) {
        const wmicOut = execSync('wmic logicaldisk get size,freespace /value 2>nul').toString();
        const match = wmicOut.match(/Size=(\d+)[\s\S]*?FreeSpace=(\d+)/i) || wmicOut.match(/FreeSpace=(\d+)[\s\S]*?Size=(\d+)/i);
        if (match) {
          const total = parseInt(match[2] ? match[2] : match[1]) / (1024 ** 4);
          const free = parseInt(match[1] ? match[1] : match[2]) / (1024 ** 4);
          disk.total = Math.round(total);
          disk.free = Math.round(free);
          disk.used = Math.round(total - free);
          disk.percent = total > 0 ? Math.round((total - free) / total * 100) : 0;
        }
      } else {
        const dfOut = execSync('df -m / 2>/dev/null || true').toString();
        const lines = dfOut.split('\n');
        if (lines[1]) {
          const parts = lines[1].split(/\s+/);
          disk.total = Math.round(parseInt(parts[1]) / 1024);
          disk.used = Math.round(parseInt(parts[2]) / 1024);
          disk.free = Math.round(parseInt(parts[3]) / 1024);
          disk.percent = parseInt(parts[4]);
        }
      }
    } catch (e) {}

    let load = [0, 0, 0];
    try { load = os.loadavg(); } catch (e) {}

    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osType: os.type(),
      osRelease: os.release(),
      uptime: os.uptime(),
      cpu: { model: cpuModel, cores: cpuCount, load1: load[0], load5: load[1], load15: load[2] },
      memory: {
        total: mem.toFixed(2), free: freemem.toFixed(2),
        used: (mem - freemem).toFixed(2),
        percent: Math.round((mem - freemem) / mem * 100)
      },
      disk,
      nodeVersion: process.version,
      pid: process.pid
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', isAuthed, (req, res) => {
  const u = users[req.user.id];
  res.json({
    files: (u.files |= 0),
    chats: (u.requests |= 0),
    commands: (u.commands |= 0),
    friends: (u.friends || []).length
  });
});

// ─────────────────────────────────────────────
// AI ENGINE
// ─────────────────────────────────────────────

const ACTIVE_SESSIONS = {};

function getAIResponse(prompt, systemPrompt) {
  return new Promise(async (resolve, reject) => {
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    const apiKey = process.env.AI_API_KEY || '';
    const baseURL = process.env.AI_API_URL || 'https://api.openai.com/v1';

    if (!apiKey) {
      // Fallback: rule-based smart assistant
      const low = prompt.toLowerCase();
      if (low.includes('ls') || low.includes('list file') || low.includes('show file')) {
        return resolve('To list files: run `ls -lah` in the terminal, or use the File Manager tab above.');
      }
      if (low.includes('install')) {
        return resolve('To install software, tell me the package name. For example: "install nginx" or "install python3".');
      }
      if (low.includes('memory') || low.includes('ram')) {
        return resolve('Run `free -h` in the terminal to see memory usage.');
      }
      if (low.includes('disk') || low.includes('storage')) {
        return resolve('Run `df -h` to check disk space.');
      }
      return resolve('I am running in demo mode. Add an AI_API_KEY in the .env file to unlock full AI capabilities. Meanwhile, I can still help: ask me to install something, list files, check system info, or run commands in the terminal.');
    }

    try {
      const response = await fetch(baseURL + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: Math.min(parseInt(process.env.AI_MAX_TOKENS || '2000'), 4096)
        })
      });

      const data = await response.json();
      if (!response.ok) {
        reject(new Error(data.error?.message || 'AI API error'));
        return;
      }
      resolve(data.choices[0].message.content);
    } catch (e) {
      reject(e);
    }
  });
}

function executeCommand(cmd, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ output: '⚠ Command timed out after ' + (timeoutMs / 1000) + 's', code: null, timedOut: true });
    }, timeoutMs);

    const child = exec(cmd, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, shell: SHELL }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      resolve({
        output: (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : ''),
        code: error ? error.code : 0
      });
    });

    child.stdout?.on('data', d => {});
    child.stdin?.end();
  });
}

function parseAICommands(aiText) {
  // Extract command blocks like ```bash\n...\n``` or lines starting with $
  const commands = [];
  const codeBlockRegex = /```(?:bash|sh|shell|terminal)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = codeBlockRegex.exec(aiText)) !== null) {
    m[1].split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
    });
  }
  return commands;
}

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.passport
    ? socket.request.session.passport.user
    : null;
  if (userId && users[userId]) {
    socket.user = users[userId];
    return next();
  }
  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[•] ${user.username} connected | ${socket.id}`);

  socket.emit('connected', { message: 'Connected to Aurex AI Panel' });

  // ── Terminals ──
  socket.on('terminal:intro', () => {
    socket.emit('terminal:output', {
      id: 'shell',
      data: `\x1b[1;36m AUREX AI Panel v1.0\x1b[0m | \x1b[1;32mWelcome ${user.username}!\x1b[0m\nType \x1b[1;33mhelp\x1b[0m for available commands\n\n\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ `
    });
  });

  socket.on('terminal:input', async (payload) => {
    const { id, data } = payload;
    const line = String(data || '').trim();
    if (!line) {
      socket.emit('terminal:output', { id, data: `\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ ` });
      return;
    }
    if (line.toLowerCase() === 'help') {
      socket.emit('terminal:output', { id, data: `\x1b[1;33mAvailable commands:\x1b[0m\n  \x1b[1;32mhelp\x1b[0m        show this help\n  \x1b[1;32mclear\x1b[0m       clear terminal\n  \x1b[1;32mls\x1b[0m / \x1b[1;32mcd\x1b[0m / \x1b[1;32mcat\x1b[0m  file operations\n  \x1b[1;32msysinfo\x1b[0m    system information\n\nAny other command runs directly on the server via shell.\n\n\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ ` });
      return;
    }
    if (line.toLowerCase() === 'clear') {
      socket.emit('terminal:clear', { id });
      socket.emit('terminal:output', { id, data: `\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ ` });
      return;
    }
    if (line.toLowerCase() === 'sysinfo') {
      let info;
      try {
        if (IS_WINDOWS) {
          info = execSync('ver & hostname & wmic CPU get name /value 2>nul & echo. & systeminfo ^| findstr /C:"Total Physical" /C:"Available Physical"').toString();
        } else {
          info = execSync('uname -a 2>/dev/null; echo; free -h 2>/dev/null; echo; df -h 2>/dev/null | head -5').toString();
        }
      } catch (e) { info = e.message; }
      socket.emit('terminal:output', { id, data: info + `\n\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ ` });
      return;
    }
    if (line.toLowerCase() === 'exit' || line.toLowerCase() === 'logout') {
      socket.emit('terminal:output', { id, data: `\x1b[1;31mGoodbye ${user.username}!\x1b[0m\n` });
      return;
    }
    if (line.startsWith('cd ')) {
      const dir = line.slice(3).trim().replace(/^~/, os.homedir());
      try {
        process.chdir(dir);
        socket.emit('terminal:output', { id, data: `\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m${process.cwd()}\x1b[0m$ ` });
      } catch (e) {
        socket.emit('terminal:output', { id, data: `\x1b[1;31mbash: cd: ${dir}: No such file or directory\x1b[0m\n\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m${process.cwd()}\x1b[0m$ ` });
      }
      return;
    }
    exec(line, { cwd: process.cwd(), shell: SHELL, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const final = (out || (error ? `\x1b[1;31m${error.message}\x1b[0m` : '')).replace(/\n/g, '\r\n');
      socket.emit('terminal:output', { id, data: (final ? final + '\r\n' : '') + `\x1b[1;32m${user.username}@aurex\x1b[0m:\x1b[1;34m~\x1b[0m$ ` });
    });
  });

  // ── AI Chat ──
  socket.on('chat:send', async (payload) => {
    const { message } = payload;
    if (!message || !message.trim()) return;

    user.requests = user.requests || 0;
    user.requests += 1;
    saveUsers();

    const localIp = getUserIP();
    const username = user.username;

    const systemPrompt = `You are AUREX AI, an expert Linux/VPS system assistant embedded in a server management panel.
USER CONTEXT:
- Username: ${username}
- Server: ${os.hostname()} (${os.platform()} ${os.arch()})
- Home: ${os.homedir()}
- Current Date: ${new Date().toDateString()}

Your role:
1. Help the user manage their VPS: install software, configure services, analyze files, monitor system health.
2. When the user asks you to DO something on the server (install, create files, run commands), respond with clear bash commands inside a markdown code block like \`\`\`bash ... \`\`\`. The panel will detect these and offer to run them.
3. When asked to CREATE CODE (websites, bots, scripts, etc.), write the complete code inside a code block with the appropriate language tag.
4. Be concise but complete. Use friendly Hinglish occasionally but default to clear English.
5. NEVER ask for confirmation before something trivial; suggest the exact command to run.

IMPORTANT: When the user says things like "make a website", "create a bot", "install nginx", "install anything", "bana de", "kuch bhi bna de" — provide full working code or exact install commands, and mention the files you create so the panel can save them.`;

    try {
      const aiResponse = await getAIResponse(message, systemPrompt);
      const commands = parseAICommands(aiResponse);

      socket.emit('chat:response', {
        message: aiResponse,
        commands,
        suggestion: commands.length > 0
      });

      if (commands.length > 0) {
        const execId = uuidv4();
        io.to(socket.id).emit('chat:execution-request', {
          execId,
          commands,
          title: 'Aurex AI wants to run commands on your server'
        });
      }
    } catch (e) {
      socket.emit('chat:error', { message: 'Error contacting AI: ' + e.message });
    }
  });

  socket.on('chat:execute', async (payload) => {
    const { commands, execId } = payload;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      socket.emit('chat:execution', { execId, index: i, total: commands.length, status: 'running', command: cmd });
      try {
        const result = await executeCommand(cmd, os.homedir());
        user.commands = user.commands || 0;
        user.commands += 1;
        saveUsers();
        socket.emit('chat:execution', { execId, index: i, total: commands.length, status: 'done', command: cmd, output: result.output, code: result.code });
      } catch (e) {
        socket.emit('chat:execution', { execId, index: i, total: commands.length, status: 'error', command: cmd, output: e.message });
      }
    }
    socket.emit('chat:execution', { execId, total: commands.length, status: 'finished' });
  });

  socket.on('chat:save-file', async (payload) => {
    const { filename, content } = payload;
    try {
      // Determine the folder based on file extension
      const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = path.join(os.homedir(), safeName);
      fs.writeFileSync(target, content, 'utf8');
      socket.emit('chat:file-saved', { path: target, name: safeName });
    } catch (e) {
      socket.emit('chat:error', { message: 'Failed to save file: ' + e.message });
    }
  });

  // ── Friends (online presence) ──
  socket.on('friends:list-request', () => {
    const friendList = (user.friends || []).map(id => {
      const f = users[id];
      if (!f) return null;
      const friendSockets = [...io.sockets.sockets.values()].filter(s => s.user && s.user.id === id);
      return { id: f.id, username: f.username, name: f.name, avatar: f.avatar, online: friendSockets.length > 0 };
    }).filter(Boolean);
    socket.emit('friends:list', { friends: friendList });
  });

  socket.on('disconnect', () => {
    console.log(`[•] ${user.username} disconnected`);
  });
});

function getUserIP() {
  try {
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const details of iface) {
        if (details.family === 'IPv4' && !details.internal) return details.address;
      }
    }
  } catch (e) {}
  return '127.0.0.1';
}

// ─────────────────────────────────────────────
// DEMO ACCOUNT (if no Google creds configured)
// ─────────────────────────────────────────────

async function ensureDemoUser() {
  if (!Object.keys(users).length) {
    const demoId = uuidv4();
    users[demoId] = {
      id: demoId,
      googleId: null,
      username: 'demo',
      email: 'demo@aurex.ai',
      name: 'Demo User',
      avatar: null,
      isDemo: true,
      friends: [],
      createdAt: new Date().toISOString()
    };
    friendships[demoId] = [];
    saveUsers();
    saveFriends();
    console.log('[•] Demo user created: demo@aurex.ai');
  }
}

// ─────────────────────────────────────────────
// PAGES
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html'));
});

app.get('/dashboard', isAuthed, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html'));
});

// Demo login (when no google creds configured or user clicks demo)
app.get('/auth/demo', (req, res) => {
  const demo = Object.values(users).find(u => u.email === 'demo@aurex.ai');
  if (demo) {
    req.login(demo, (err) => {
      if (err) return res.redirect('/');
      res.redirect('/dashboard');
    });
  } else {
    res.redirect('/');
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

ensureDemoUser();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ═══════════════════════════════════════════');
  console.log('       AUREX AI PANEL v1.0');
  console.log('  ═══════════════════════════════════════════');
  console.log(`   Running on port: ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);
  console.log(`   System: ${os.hostname()} (${os.platform()}/${os.arch()})`);
  console.log('  ═══════════════════════════════════════════');
  console.log('');
});