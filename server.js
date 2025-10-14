const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Путь к статике и данным
const rootDir = __dirname;
const dataPath = path.join(rootDir, 'data.json');
const firewallPy = path.join(rootDir, 'firewall.py');
const firewallConf = path.join(rootDir, 'firewall.conf');
let firewallProc = null;

// Справочник популярных портов (тот же, что на фронте)
const wellKnownPorts = {
  20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  67: 'DHCP-Server', 68: 'DHCP-Client', 69: 'TFTP', 80: 'HTTP', 110: 'POP3',
  123: 'NTP', 137: 'NetBIOS-NS', 138: 'NetBIOS-DGM', 139: 'NetBIOS-SSN',
  143: 'IMAP', 161: 'SNMP', 389: 'LDAP', 443: 'HTTPS', 465: 'SMTPS',
  587: 'SMTP-Submission', 993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL',
  1521: 'Oracle DB', 2049: 'NFS', 2181: 'Zookeeper', 2379: 'etcd',
  2380: 'etcd-peer', 27017: 'MongoDB', 3000: 'Node Dev (Dont off)', 3306: 'MySQL',
  3389: 'RDP', 5432: 'PostgreSQL', 56379: 'Redis-Sentinel', 5672: 'RabbitMQ',
  5900: 'VNC', 6379: 'Redis', 8000: 'HTTP-Alt', 8080: 'HTTP-Alt', 9000: 'App',
  9200: 'Elasticsearch', 9300: 'ES-Transport'
};

function readState() {
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    const state = { ports: [80, 443, 22, 25, 53], lastUpdateTs: Date.now() };
    fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
    return state;
  }
}

function writeState(state) {
  fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
}

// Чтение актуального списка портов из firewall.conf
function readFirewallPorts() {
  try {
    const raw = fs.readFileSync(firewallConf, 'utf8');
    const customLine = raw.split('\n').find(l => l.trim().startsWith('custom_ports')) || '';
    const defaultLine = raw.split('\n').find(l => l.trim().startsWith('default_ports')) || '';
    const parsePorts = (line) => line.split('=')[1] ? line.split('=')[1].split(',').map(s => s.trim()).filter(Boolean).map(Number) : [];
    const custom = parsePorts(customLine);
    const defaults = parsePorts(defaultLine);
    const merged = Array.from(new Set([...(defaults||[]), ...(custom||[])])).filter(n => Number.isInteger(n)).sort((a,b)=>a-b);
    return merged;
  } catch (e) {
    return null;
  }
}

function execFirewall(args) {
  return new Promise((resolve, reject) => {
    // Команды --add, --del, --run требуют sudo для работы с eBPF/XDP
    const cmd = args.includes('--add') || args.includes('--del') || args.includes('--run') ? 'sudo' : 'python3';
    const cmdArgs = cmd === 'sudo' ? ['python3', firewallPy, ...args] : [firewallPy, ...args];
    
    execFile(cmd, cmdArgs, { cwd: rootDir }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getFirewallStatus() {
  try {
    const { stdout } = await execFirewall(['--status']);
    const status = (stdout || '').toString().trim();
    return status === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
  } catch {
    return 'OFFLINE';
  }
}

// API
app.get('/api/state', async (req, res) => {
  const fileState = readState();
  const fwPorts = readFirewallPorts();
  const status = await getFirewallStatus();
  res.json({
    ports: Array.isArray(fwPorts) ? fwPorts : fileState.ports,
    lastUpdateTs: fileState.lastUpdateTs,
    status
  });
});

app.get('/api/well-known', (req, res) => {
  res.json(wellKnownPorts);
});

app.post('/api/ports', async (req, res) => {
  const port = Number(req.body && req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  
  // Проверяем статус firewall - нельзя менять порты во время работы
  const status = await getFirewallStatus();
  if (status === 'ONLINE') {
    return res.status(409).json({ error: 'Cannot modify ports while firewall is running' });
  }
  
  try {
    await execFirewall(['--add', String(port)]);
    const state = readState();
    state.lastUpdateTs = Date.now();
    writeState(state);
    const ports = readFirewallPorts() || state.ports;
    res.json({ ports, lastUpdateTs: state.lastUpdateTs, status: await getFirewallStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ports/:port', async (req, res) => {
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  
  // Проверяем статус firewall - нельзя менять порты во время работы
  const status = await getFirewallStatus();
  if (status === 'ONLINE') {
    return res.status(409).json({ error: 'Cannot modify ports while firewall is running' });
  }
  
  try {
    await execFirewall(['--del', String(port)]);
    const state = readState();
    state.lastUpdateTs = Date.now();
    writeState(state);
    const ports = readFirewallPorts() || state.ports;
    res.json({ ports, lastUpdateTs: state.lastUpdateTs, status: await getFirewallStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  res.json({ status: await getFirewallStatus() });
});

// Запуск/остановка firewall-процесса (Linux/Unix)
app.post('/api/firewall/start', async (req, res) => {
  try {
    // Проверяем, не запущен ли уже firewall
    const currentStatus = await getFirewallStatus();
    if (currentStatus === 'ONLINE') {
      return res.status(409).json({ error: 'Firewall already running' });
    }
    
    const iface = (req.body && req.body.iface) ? String(req.body.iface) : 'lo';
    
    // Запуск через execFile с sudo
    const { stdout, stderr } = await execFirewall(['--run', iface]);
    
    // Дадим время на инициализацию
    setTimeout(async () => {
      const status = await getFirewallStatus();
      res.json({ status, message: 'Firewall started' });
    }, 1000);
    
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/firewall/stop', async (req, res) => {
  try {
    // Останавливаем через SIGTERM всем процессам python3 firewall.py
    const { exec } = require('child_process');
    exec('sudo pkill -f "python3.*firewall.py.*--run"', (error, stdout, stderr) => {
      setTimeout(async () => {
        const status = await getFirewallStatus();
        res.json({ status, message: 'Firewall stopped' });
      }, 500);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API для получения логов
app.get('/api/logs', (req, res) => {
  try {
    const logPath = path.join(rootDir, 'firewall.log');
    const logs = fs.readFileSync(logPath, 'utf8');
    const lines = logs.split('\n').filter(line => line.trim()).slice(-100); // Последние 100 строк
    res.json({ logs: lines });
  } catch (e) {
    res.json({ logs: [], error: 'Log file not found or empty' });
  }
});

// Отдаём статические файлы (fd.html как индекс)
app.use(express.static(rootDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(rootDir, 'fd.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});


