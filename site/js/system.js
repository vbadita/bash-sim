// Machine-wide state: users and groups (from /etc), the process table,
// hostname, boot time, devices and /proc files.

import { nextPid } from './shell.js';

const PKG_HINTS = {
  python: 'python3', python3: 'python3', pip: 'python3-pip', pip3: 'python3-pip', node: 'nodejs', npm: 'npm',
  gcc: 'gcc', 'g++': 'g++', make: 'make', cmake: 'cmake', docker: 'docker.io', java: 'default-jre', javac: 'default-jdk',
  ruby: 'ruby', perl: 'perl', go: 'golang-go', cargo: 'cargo', rustc: 'rustc', php: 'php-cli', emacs: 'emacs',
  htop: 'htop', fortune: 'fortune-mod', cowthink: 'cowsay', zsh: 'zsh', fish: 'fish', tmux: 'tmux', screen: 'screen', jq: 'jq', git: 'git', ssh: 'openssh-client',
  zip: 'zip', unzip: 'unzip', neofetch: 'neofetch', ffmpeg: 'ffmpeg', sl: 'sl', cowsay: 'cowsay', lolcat: 'lolcat',
  figlet: 'figlet', nmap: 'nmap', traceroute: 'traceroute', telnet: 'telnet', mysql: 'mysql-client', psql: 'postgresql-client',
};

export class System {
  constructor(vfs) {
    this.vfs = vfs;
    this.hostname = 'badita';
    this.boot = Date.now() - (3 * 3600 + 17 * 60) * 1000;
    this.procs = new Map();
    this.kernel = '6.8.0-48-generic';
    this.installed = new Set();
    const base = [
      [1, 0, 'root', '/sbin/init splash', '?'],
      [2, 0, 'root', '[kthreadd]', '?'],
      [312, 1, 'root', '/lib/systemd/systemd-journald', '?'],
      [341, 1, 'root', '/lib/systemd/systemd-udevd', '?'],
      [602, 1, 'systemd+', '/lib/systemd/systemd-resolved', '?'],
      [688, 1, 'root', '/usr/sbin/cron -f -P', '?'],
      [691, 1, 'messagebus', '@dbus-daemon --system --address=systemd: --nofork', '?'],
      [705, 1, 'syslog', '/usr/sbin/rsyslogd -n -iNONE', '?'],
      [744, 1, 'root', 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups', '?'],
      [902, 744, 'root', 'sshd: user [priv]', '?'],
      [951, 902, 'user', 'sshd: user@pts/0', '?'],
    ];
    for (const [pid, ppid, user, cmd, tty] of base) this.procs.set(pid, { pid, ppid, user, cmd, tty, start: this.boot + pid * 37, sys: true });
  }

  users() {
    let txt = '';
    try {
      txt = this.vfs.root.children.get('etc').children.get('passwd').data;
    } catch {}
    return txt.split('\n').filter(Boolean).map((l) => {
      const [name, , uid, gid, gecos, home, shell] = l.split(':');
      return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
    });
  }

  groups() {
    let txt = '';
    try {
      txt = this.vfs.root.children.get('etc').children.get('group').data;
    } catch {}
    return txt.split('\n').filter(Boolean).map((l) => {
      const [name, , gid, members] = l.split(':');
      return { name, gid: Number(gid), members: (members || '').split(',').filter(Boolean) };
    });
  }

  userByName(n) {
    return this.users().find((u) => u.name === n);
  }
  userById(id) {
    return this.users().find((u) => u.uid === id);
  }
  groupById(id) {
    return this.groups().find((g) => g.gid === id);
  }
  groupByName(n) {
    return this.groups().find((g) => g.name === n);
  }
  userName(uid) {
    const u = this.userById(uid);
    return u ? u.name : String(uid);
  }
  groupName(gid) {
    const g = this.groupById(gid);
    return g ? g.name : String(gid);
  }
  groupsOf(name) {
    const u = this.userByName(name);
    const out = [];
    if (u) out.push(u.gid);
    for (const g of this.groups()) if (g.members.includes(name) && !out.includes(g.gid)) out.push(g.gid);
    return out;
  }

  spawn(argv, shell, text) {
    const pid = text !== undefined ? shell.pid : nextPid();
    const p = {
      pid,
      ppid: shell.pid,
      user: this.userName(this.vfs.cred.uid),
      cmd: text !== undefined ? 'bash' : argv.map(String).join(' '),
      tty: 'pts/0',
      start: Date.now(),
    };
    this.procs.set(pid, p);
    return p;
  }

  exit(p) {
    if (p) this.procs.delete(p.pid);
  }

  notFoundHint(name) {
    const pkg = PKG_HINTS[name];
    if (!pkg) return '';
    const simulated = ['htop', 'jq', 'cowsay', 'sl', 'figlet', 'cmatrix', 'lolcat', 'neofetch', 'fortune'].includes(name);
    return `Command '${name}' not found, but can be installed with:\n\nsudo apt install ${pkg}\n\n${simulated ? '' : 'Note: this package is not available in this browser simulation.\n\n'}`;
  }

  uptimeSeconds() {
    return (Date.now() - this.boot) / 1000;
  }
}
