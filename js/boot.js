// Builds the command registry, the default filesystem and a login session.
// Shared by the browser (main.js) and the Node test harness.

import { VFS } from './vfs.js';
import { Shell } from './shell.js';
import { System } from './system.js';
import { install as installBuiltins } from './cmds/builtins.js';
import { install_ as installFiles } from './cmds/files.js';
import { install as installText } from './cmds/text.js';
import { install as installSed } from './cmds/sed.js';
import { install as installAwk } from './cmds/awk.js';
import { install as installSys, elfStub, PACKAGES } from './cmds/sys.js';
import { install as installEditors } from './cmds/editors.js';
import { install as installFun } from './cmds/fun.js';
import { install as installMan } from './cmds/man.js';
import { fromBytes } from './util.js';

export const VERSION = '1.0.0';

// which directory each non-builtin command lives in
const SBIN = new Set(['useradd', 'userdel', 'groupadd', 'groupdel', 'usermod', 'adduser', 'deluser', 'addgroup', 'delgroup', 'shutdown', 'reboot', 'poweroff', 'halt', 'ifconfig', 'ip', 'ss', 'mkfifo', 'service', 'chroot']);
const BIN_TOO = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'kill', 'time']);

export function makeRegistry(extra = {}) {
  const reg = new Map();
  installBuiltins(reg);
  installFiles(reg);
  installText(reg);
  installSed(reg);
  installAwk(reg);
  installSys(reg);
  installEditors(reg);
  installFun(reg);
  installMan(reg);
  for (const [k, v] of Object.entries(extra)) reg.set(k, v);
  // time is both a keyword and /usr/bin/time; kill/echo... are builtins with binaries
  return reg;
}

const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# don't put duplicate lines or lines starting with space in the history.
HISTCONTROL=ignoreboth

# append to the history file, don't overwrite it
shopt -s histappend

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# check the window size after each command
shopt -s checkwinsize

# set a fancy prompt (non-color, unless we know we "want" color)
case "$TERM" in
    xterm-color|*-256color) color_prompt=yes;;
esac

if [ "$color_prompt" = yes ]; then
    PS1='\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '
else
    PS1='\\u@\\h:\\w\\$ '
fi
unset color_prompt

# enable color support of ls and also add handy aliases
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias diff='diff --color=auto'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# Alias definitions.
if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
fi
`;

const PROFILE = `# ~/.profile: executed by the command interpreter for login shells.

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
	. "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/.local/bin" ] ; then
    PATH="$HOME/.local/bin:$PATH"
fi
`;

const ETC_PROFILE = `# /etc/profile: system-wide .profile file for the Bourne shell (sh(1))
# and Bourne compatible shells (bash(1), ksh(1), ash(1), ...).

if [ "\${PS1-}" ]; then
  if [ "\${BASH-}" ] && [ "$BASH" != "/bin/sh" ]; then
    if [ -f /etc/bash.bashrc ]; then
      . /etc/bash.bashrc
    fi
  else
    if [ "$(id -u)" -eq 0 ]; then
      PS1='# '
    else
      PS1='$ '
    fi
  fi
fi

if [ -d /etc/profile.d ]; then
  for i in /etc/profile.d/*.sh; do
    if [ -r $i ]; then
      . $i
    fi
  done
  unset i
fi
`;

const MOTD = `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-48-generic x86_64)

 * Documentation:  https://help.ubuntu.com
 * Management:     https://landscape.canonical.com
 * Support:        https://ubuntu.com/pro

 This is a bash simulation that runs entirely in your browser.
 Try: ls -la, cat README.md, help, man bash, nano notes.txt, top,
      sudo apt install cowsay, history, jobs, and anything else.
`;

const README = `# Welcome to bash in the browser

This machine is simulated: a Bash interpreter, a virtual filesystem and the
usual GNU/Linux commands, all written in JavaScript and running locally in
your browser. Your files are saved in this browser's storage.

Things to try:

  ls -la /etc               cat /etc/os-release       echo $((7 * 6))
  for i in {1..5}; do echo "line $i"; done | tac
  grep -rn bash /etc | head  awk -F: '{print $1, $7}' /etc/passwd
  find ~ -name '*.txt'       sed -n '2,4p' data/fruits.txt
  history                    help                      man bash
  nano notes.txt             vim scripts/hello.sh      ./scripts/hello.sh world
  sleep 30 &                 jobs                      kill %1
  top                        ps aux                    df -h
  sudo -i                    sudo apt install cowsay   cowsay moo
  tar czf backup.tgz data    ls -l backup.tgz          tar tzf backup.tgz

Type 'reset-sim' to wipe everything and start from a fresh filesystem.
`;

const HELLO = `#!/bin/bash
# A small example script: ./scripts/hello.sh [name]

greet() {
    local who=\${1:-world}
    printf 'Hello, %s!\\n' "$who"
}

greet "$@"
echo "Today is $(date +%A), and you are $(whoami) on $(hostname)."
for n in 1 2 3; do
    echo "  counting: $n"
done
`;

const FIZZ = `#!/bin/bash
# FizzBuzz, the classic.
for ((i = 1; i <= \${1:-15}; i++)); do
    if (( i % 15 == 0 )); then echo FizzBuzz
    elif (( i % 3 == 0 )); then echo Fizz
    elif (( i % 5 == 0 )); then echo Buzz
    else echo $i
    fi
done
`;

const BACKUP = `#!/bin/bash
# Archive a directory with a timestamp: ./scripts/backup.sh data
set -euo pipefail
src=\${1:?usage: backup.sh DIR}
dest="backup-$(basename "$src")-$(date +%Y%m%d-%H%M%S).tar.gz"
tar czf "$dest" "$src"
echo "created $dest ($(stat -c %s "$dest") bytes)"
`;

const FRUITS = `apple
banana
cherry
date
elderberry
fig
grape
banana
apple
kiwi
`;

const PEOPLE = `name,age,city,role
Ana,34,Bucharest,engineer
Bogdan,28,Cluj,designer
Carmen,45,Iasi,manager
Dan,31,Timisoara,engineer
Elena,26,Brasov,analyst
Florin,39,Constanta,engineer
`;

const LOG = `2026-10-27 08:12:01 INFO  server started on :8080
2026-10-27 08:12:05 INFO  connected to database
2026-10-27 09:30:44 WARN  slow query took 1532ms
2026-10-27 10:02:13 ERROR failed to send email: timeout
2026-10-27 10:02:14 INFO  retrying email
2026-10-27 10:02:20 INFO  email sent
2026-10-27 13:45:00 WARN  disk usage at 81%
2026-10-27 17:00:00 INFO  daily report generated
2026-10-28 02:00:00 ERROR backup failed: permission denied
2026-10-28 02:05:00 INFO  backup succeeded
`;

const NUMBERS = Array.from({ length: 20 }, (_, i) => String(((i * 37 + 11) % 97) + 1)).join('\n') + '\n';

const WORDS = `able
about
above
accept
across
active
actual
address
admin
after
again
agent
alpha
apple
archive
argument
array
awk
bash
binary
branch
buffer
byte
cache
cat
channel
child
client
cloud
code
command
compile
config
console
cursor
daemon
data
debug
default
delete
device
directory
disk
domain
echo
editor
environment
error
event
export
file
filter
folder
format
function
global
grep
group
hash
header
history
host
index
input
kernel
key
kill
library
line
link
linux
list
local
loop
memory
module
mount
network
node
object
output
packet
parse
partition
password
path
pipe
port
process
prompt
query
queue
read
record
regex
remote
root
script
sed
server
session
shell
signal
socket
source
stack
stream
string
sudo
syntax
system
table
terminal
thread
token
user
value
variable
version
virtual
window
write
`;

function passwdFile() {
  return [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
    'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
    'sync:x:4:65534:sync:/bin:/bin/sync',
    'games:x:5:60:games:/usr/games:/usr/sbin/nologin',
    'man:x:6:12:man:/var/cache/man:/usr/sbin/nologin',
    'mail:x:8:8:mail:/var/mail:/usr/sbin/nologin',
    'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
    'systemd-network:x:998:998:systemd Network Management:/:/usr/sbin/nologin',
    'systemd-resolve:x:996:996:systemd Resolver:/:/usr/sbin/nologin',
    'messagebus:x:100:102::/nonexistent:/usr/sbin/nologin',
    'syslog:x:102:104::/nonexistent:/usr/sbin/nologin',
    'sshd:x:104:65534::/run/sshd:/usr/sbin/nologin',
    'user:x:1000:1000:User,,,:/home/user:/bin/bash',
  ].join('\n') + '\n';
}

function groupFile() {
  return [
    'root:x:0:', 'daemon:x:1:', 'bin:x:2:', 'sys:x:3:', 'adm:x:4:syslog,user', 'tty:x:5:', 'disk:x:6:', 'lp:x:7:', 'mail:x:8:', 'news:x:9:',
    'uucp:x:10:', 'man:x:12:', 'proxy:x:13:', 'kmem:x:15:', 'dialout:x:20:', 'cdrom:x:24:user', 'floppy:x:25:', 'sudo:x:27:user', 'audio:x:29:',
    'dip:x:30:user', 'www-data:x:33:', 'backup:x:34:', 'operator:x:37:', 'list:x:38:', 'src:x:40:', 'shadow:x:42:', 'utmp:x:43:', 'video:x:44:',
    'plugdev:x:46:user', 'staff:x:50:', 'games:x:60:', 'users:x:100:user', 'nogroup:x:65534:', 'systemd-journal:x:999:', 'systemd-network:x:998:',
    'systemd-resolve:x:996:', 'messagebus:x:102:', 'syslog:x:104:', 'lxd:x:105:user', 'user:x:1000:',
  ].join('\n') + '\n';
}

export function buildFilesystem(vfs, system, registry) {
  const dirs = [
    ['/bin', null], ['/boot', 0o755], ['/dev', 0o755], ['/etc', 0o755], ['/etc/skel', 0o755], ['/etc/profile.d', 0o755], ['/etc/apt', 0o755], ['/etc/cron.d', 0o755],
    ['/etc/ssh', 0o755], ['/etc/sudoers.d', 0o750], ['/etc/systemd/system', 0o755], ['/home', 0o755], ['/media', 0o755], ['/mnt', 0o755], ['/opt', 0o755], ['/proc', 0o555],
    ['/root', 0o700], ['/run', 0o755], ['/srv', 0o755], ['/sys', 0o555], ['/tmp', 0o1777], ['/usr/bin', 0o755], ['/usr/sbin', 0o755], ['/usr/games', 0o755],
    ['/usr/local/bin', 0o755], ['/usr/local/sbin', 0o755], ['/usr/local/share', 0o755], ['/usr/lib', 0o755], ['/usr/include', 0o755], ['/usr/share/doc', 0o755],
    ['/usr/share/dict', 0o755], ['/usr/share/man/man1', 0o755], ['/usr/share/cowsay/cows', 0o755], ['/var/log', 0o755], ['/var/tmp', 0o1777], ['/var/lib/dpkg', 0o755],
    ['/var/spool/cron/crontabs', 0o730], ['/var/cache/apt', 0o755], ['/var/mail', 0o2775], ['/var/www/html', 0o755], ['/snap', 0o755], ['/lost+found', 0o700],
  ];
  for (const [d, m] of dirs) if (m !== null) vfs.mkdirp(d, m);
  vfs.root.children.get('tmp').mode = 0o1777;
  vfs.mkdirp('/var/tmp').mode = 0o1777;
  vfs.putLink('/bin', 'usr/bin');
  vfs.putLink('/sbin', 'usr/sbin');
  vfs.putLink('/lib', 'usr/lib');
  vfs.putLink('/lib64', 'usr/lib64');
  vfs.mkdirp('/usr/lib64');
  vfs.mkdirp('/root').mode = 0o700;

  // binaries
  for (const [name, entry] of registry) {
    if (entry.pkg && !system.installed.has(PACKAGES[entry.pkg]?.pkg || entry.pkg) && !PACKAGES[entry.pkg]?.preinstalled) continue;
    if (entry.builtin && !BIN_TOO.has(name)) continue;
    if (['.', ':', 'source'].includes(name)) continue;
    let dir = SBIN.has(name) ? '/usr/sbin' : '/usr/bin';
    const pkgInfo = entry.pkg ? PACKAGES[entry.pkg] : null;
    if (pkgInfo && pkgInfo.dir) dir = pkgInfo.dir;
    vfs.put(`${dir}/${name}`, elfStub(name), 0o755);
  }
  vfs.put('/usr/bin/sudo', elfStub('sudo'), 0o4755);
  vfs.put('/usr/bin/passwd', elfStub('passwd'), 0o4755);
  vfs.put('/usr/bin/su', elfStub('su'), 0o4755);

  const etc = {
    '/etc/hostname': system.hostname + '\n',
    '/etc/hosts': `127.0.0.1 localhost\n127.0.1.1 ${system.hostname}\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\nfe00::0 ip6-localnet\nff00::0 ip6-mcastprefix\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n`,
    '/etc/os-release': 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\nSUPPORT_URL="https://help.ubuntu.com/"\nBUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"\nPRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"\nUBUNTU_CODENAME=noble\nLOGO=ubuntu-logo\n',
    '/etc/lsb-release': 'DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\nDISTRIB_CODENAME=noble\nDISTRIB_DESCRIPTION="Ubuntu 24.04.1 LTS"\n',
    '/etc/issue': 'Ubuntu 24.04.1 LTS \\n \\l\n\n',
    '/etc/issue.net': 'Ubuntu 24.04.1 LTS\n',
    '/etc/debian_version': 'trixie/sid\n',
    '/etc/motd': MOTD,
    '/etc/shells': '# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/rbash\n/usr/bin/dash\n',
    '/etc/profile': ETC_PROFILE,
    '/etc/bash.bashrc': '# System-wide .bashrc file for interactive bash(1) shells.\n\n# If not running interactively, don\'t do anything\n[ -z "$PS1" ] && return\n\n# check the window size after each command\nshopt -s checkwinsize\n\n# set a fancy prompt\nPS1=\'\\u@\\h:\\w\\$ \'\n',
    '/etc/profile.d/01-locale-fix.sh': '# Make sure the locale variables are set to valid values.\n',
    '/etc/environment': 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"\n',
    '/etc/fstab': '# /etc/fstab: static file system information.\n#\n# <file system> <mount point>   <type>  <options>       <dump>  <pass>\nLABEL=cloudimg-rootfs\t/\t ext4\tdiscard,commit=30,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n',
    '/etc/resolv.conf': '# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n',
    '/etc/timezone': (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC') + '\n',
    '/etc/crontab': '# /etc/crontab: system-wide crontab\nSHELL=/bin/sh\n# m h dom mon dow user\tcommand\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }\n',
    '/etc/services': 'ftp\t\t21/tcp\nssh\t\t22/tcp\t\t\t\t# SSH Remote Login Protocol\ntelnet\t\t23/tcp\nsmtp\t\t25/tcp\t\tmail\ndomain\t\t53/tcp\t\t\t\t# Domain Name Server\nhttp\t\t80/tcp\t\twww\t\t# WorldWideWeb HTTP\nhttps\t\t443/tcp\t\t\t\t# http protocol over TLS/SSL\n',
    '/etc/protocols': 'ip\t0\tIP\t\t# internet protocol, pseudo protocol number\nicmp\t1\tICMP\t\t# internet control message protocol\ntcp\t6\tTCP\t\t# transmission control protocol\nudp\t17\tUDP\t\t# user datagram protocol\n',
    '/etc/apt/sources.list': '# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n',
    '/etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config.d/*.conf\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding yes\nPrintMotd no\nAcceptEnv LANG LC_*\nSubsystem\tsftp\t/usr/lib/openssh/sftp-server\n',
    '/etc/skel/.bashrc': BASHRC,
    '/etc/skel/.profile': PROFILE,
    '/etc/skel/.bash_logout': '# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n# when leaving the console clear the screen to increase privacy\n\nif [ "$SHLVL" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n',
    '/etc/inputrc': '# /etc/inputrc - global inputrc for libreadline\nset input-meta on\nset output-meta on\n',
    '/etc/nanorc': '## Sample initialization file for GNU nano.\n# set linenumbers\n',
    '/etc/vim/vimrc': '" All system-wide defaults are set in $VIMRUNTIME/debian.vim\nsyntax on\n',
  };
  for (const [p, d] of Object.entries(etc)) vfs.put(p, d, 0o644);
  vfs.put('/etc/passwd', passwdFile(), 0o644);
  vfs.put('/etc/group', groupFile(), 0o644);
  vfs.put('/etc/shadow', 'root:*:20000:0:99999:7:::\nuser:$y$j9T$Fq0rS0mE$saltedhashnotreal:20000:0:99999:7:::\n', 0o640, 0, 42);
  vfs.put('/etc/gshadow', 'root:*::\nsudo:*::user\n', 0o640, 0, 42);
  vfs.put('/etc/sudoers', 'Defaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"\nDefaults\tuse_pty\n\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n', 0o440);
  vfs.put('/etc/sudoers.d/90-cloud-init-users', '# Created by cloud-init v. 24.3.1 on Tue, 27 Oct 2026 08:00:00 +0000\n\n# User rules for user\nuser ALL=(ALL) NOPASSWD:ALL\n', 0o440);
  vfs.put('/root/.bashrc', BASHRC.replace("PS1='\\\\[\\\\033[01;32m\\\\]\\\\u@\\\\h", "PS1='\\\\[\\\\033[01;31m\\\\]\\\\u@\\\\h"), 0o644);
  vfs.put('/root/.profile', '# ~/.profile: executed by Bourne-compatible login shells.\n\nif [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\n\nmesg n 2> /dev/null || true\n', 0o644);

  // home
  const H = '/home/user';
  const U = [1000, 1000];
  vfs.mkdirp(H, 0o750, ...U);
  const homeDirs = ['Documents', 'Downloads', 'Music', 'Pictures', 'Desktop', 'data', 'scripts', '.config', '.local/share', '.cache', 'projects/website'];
  for (const d of homeDirs) {
    const parts = d.split('/');
    for (let k = 1; k <= parts.length; k++) vfs.mkdirp(`${H}/${parts.slice(0, k).join('/')}`, d.startsWith('.') ? 0o700 : 0o755, ...U);
  }
  const homeFiles = {
    '.bashrc': [BASHRC, 0o644],
    '.profile': [PROFILE, 0o644],
    '.bash_logout': ['# ~/.bash_logout: executed by bash(1) when login shell exits.\n', 0o644],
    '.bash_aliases': ["# your own aliases go here\nalias ..='cd ..'\nalias ...='cd ../..'\nalias h='history'\n", 0o644],
    'README.md': [README, 0o644],
    'notes.txt': ['Shopping list:\n- milk\n- coffee\n- bread\n\nRemember: back up the photos on Sunday.\n', 0o644],
    'scripts/hello.sh': [HELLO, 0o755],
    'scripts/fizzbuzz.sh': [FIZZ, 0o755],
    'scripts/backup.sh': [BACKUP, 0o755],
    'data/fruits.txt': [FRUITS, 0o644],
    'data/people.csv': [PEOPLE, 0o644],
    'data/server.log': [LOG, 0o644],
    'data/numbers.txt': [NUMBERS, 0o644],
    'data/config.json': ['{\n  "name": "website",\n  "version": "2.3.1",\n  "port": 8080,\n  "features": ["auth", "search", "upload"],\n  "database": {"host": "localhost", "port": 5432, "user": "app"},\n  "debug": false\n}\n', 0o644],
    'Documents/todo.md': ['# TODO\n\n- [x] set up the server\n- [ ] write documentation\n- [ ] learn awk properly\n- [ ] automate backups with cron\n', 0o644],
    'projects/website/index.html': ['<!doctype html>\n<html>\n  <head><title>My site</title></head>\n  <body>\n    <h1>Hello from the simulated web server</h1>\n  </body>\n</html>\n', 0o644],
    'projects/website/style.css': ['body { font-family: sans-serif; margin: 2rem; }\nh1 { color: #2a7ae2; }\n', 0o644],
    'projects/website/app.js': ['// TODO: add interactivity\nconsole.log("hello");\n', 0o644],
  };
  for (const [p, [d, m]] of Object.entries(homeFiles)) vfs.put(`${H}/${p}`, d, m, ...U);
  vfs.putLink(`${H}/projects/website/README`, '../../README.md').uid = 1000;
  const lk = vfs.lookup(`${H}/projects/website/README`, '/', false).node;
  lk.uid = 1000;
  lk.gid = 1000;
  vfs.put(`${H}/Pictures/photo.png`, fromBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89])), 0o644, ...U);

  // misc system files
  vfs.put('/usr/share/dict/words', WORDS, 0o644);
  vfs.put('/var/www/html/index.html', '<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body><h1>Welcome to nginx!</h1></body>\n</html>\n', 0o644);
  vfs.put('/var/log/syslog', `${new Date(system.boot).toISOString()} ${system.hostname} kernel: [    0.000000] Linux version ${system.kernel}\n${new Date(system.boot + 3000).toISOString()} ${system.hostname} systemd[1]: Started ssh.service - OpenBSD Secure Shell server.\n${new Date(system.boot + 3200).toISOString()} ${system.hostname} systemd[1]: Started cron.service - Regular background program processing daemon.\n${new Date(system.boot + 200000).toISOString()} ${system.hostname} sshd[902]: Accepted publickey for user from 192.168.1.10 port 51834 ssh2\n`, 0o640, 102, 4);
  vfs.put('/var/log/auth.log', `${new Date(system.boot + 200000).toISOString()} ${system.hostname} sshd[902]: Accepted publickey for user from 192.168.1.10 port 51834 ssh2\n`, 0o640, 102, 4);
  vfs.put('/var/log/dpkg.log', '2026-10-27 08:00:00 startup archives unpack\n', 0o644);
  vfs.put('/boot/vmlinuz-6.8.0-48-generic', '\x7fELF-kernel-image', 0o600);
  vfs.put('/boot/initrd.img-6.8.0-48-generic', '\x1f\x8binitrd', 0o600);
  vfs.put('/usr/share/doc/bash/README', 'Bash is the GNU Project\'s Bourne Again SHell.\n', 0o644);
}

// a filesystem saved by an older version may lack newer commands: add their stubs
function ensureBinaries(vfs, system, registry) {
  const bin = vfs.mkdirp('/usr/bin');
  for (const [name, entry] of registry) {
    if (entry.pkg || (entry.builtin && !BIN_TOO.has(name)) || ['.', ':', 'source'].includes(name)) continue;
    const dir = SBIN.has(name) ? vfs.mkdirp('/usr/sbin') : bin;
    if (!dir.children.has(name)) {
      const f = vfs.put(`${SBIN.has(name) ? '/usr/sbin' : '/usr/bin'}/${name}`, elfStub(name), 0o755);
      void f;
    }
  }
}

// /dev and /proc are virtual and rebuilt on every boot
export function buildVirtual(vfs, system, getShell) {
  vfs.devices.null = { read: () => '', write: () => {} };
  vfs.devices.zero = { read: () => '\0'.repeat(65536), write: () => {}, stream: true };
  vfs.devices.random = vfs.devices.urandom = {
    read: () => {
      const b = new Uint8Array(4096);
      globalThis.crypto.getRandomValues(b);
      return fromBytes(b);
    },
    write: () => {},
    stream: true,
  };
  vfs.devices.full = { read: () => '\0'.repeat(4096), write: () => { throw new Error('No space left on device'); } };
  const dev = vfs.mkdirp('/dev', 0o755);
  dev.virtual = true;
  for (const [n, d, m] of [['null', 'null', 0o666], ['zero', 'zero', 0o666], ['random', 'random', 0o666], ['urandom', 'urandom', 0o666], ['full', 'full', 0o666], ['tty', 'null', 0o666], ['console', 'null', 0o600]]) vfs.putDev(`/dev/${n}`, d, m);
  vfs.mkdirp('/dev/pts');
  vfs.putDev('/dev/pts/0', 'null', 0o620).uid = 1000;
  vfs.putLink('/dev/stdin', '/proc/self/fd/0');
  vfs.putLink('/dev/stdout', '/proc/self/fd/1');
  vfs.putLink('/dev/stderr', '/proc/self/fd/2');
  vfs.putLink('/dev/fd', '/proc/self/fd');
  vfs.mkdirp('/dev/shm', 0o1777).mode = 0o1777;
  vfs.putDev('/dev/sda', 'null', 0o660).gid = 6;
  vfs.putDev('/dev/sda1', 'null', 0o660).gid = 6;
  const proc = vfs.mkdirp('/proc', 0o555);
  proc.virtual = true;
  const gen = (p, f) => vfs.putGen('/proc/' + p, f);
  gen('version', () => `Linux version ${system.kernel} (buildd@lcy02-amd64-040) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #48-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep 27 14:04:52 UTC 2024\n`);
  gen('uptime', () => `${system.uptimeSeconds().toFixed(2)} ${(system.uptimeSeconds() * 3.8).toFixed(2)}\n`);
  gen('loadavg', () => `0.08 0.05 0.01 1/213 ${system.procs.size + 1000}\n`);
  gen('cpuinfo', () => [0, 1, 2, 3].map((i) => `processor\t: ${i}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 79\nmodel name\t: Intel(R) Xeon(R) CPU @ 2.20GHz\nstepping\t: 0\ncpu MHz\t\t: 2199.998\ncache size\t: 56320 KB\nphysical id\t: 0\nsiblings\t: 4\ncore id\t\t: ${i >> 1}\ncpu cores\t: 2\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch invpcid_single pti ssbd ibrs ibpb stibp fsgsbase tsc_adjust bmi1 hle avx2 smep bmi2 erms invpcid rtm rdseed adx smap xsaveopt arat md_clear arch_capabilities\nbogomips\t: 4399.99\naddress sizes\t: 46 bits physical, 48 bits virtual\n\n`).join(''));
  gen('meminfo', () => {
    const used = 2456320 + Math.floor(vfs.totalBytes() / 1024);
    return `MemTotal:       16293800 kB\nMemFree:        ${String(16293800 - used - 3145728).padStart(8)} kB\nMemAvailable:   ${String(16293800 - used).padStart(8)} kB\nBuffers:          212344 kB\nCached:          2933384 kB\nSwapCached:            0 kB\nActive:          3812344 kB\nInactive:        1203948 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\nShmem:             18432 kB\n`;
  });
  gen('mounts', () => '/dev/sda1 / ext4 rw,relatime,discard,errors=remount-ro 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\nsysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\ntmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=1629384k,mode=755 0 0\n');
  gen('filesystems', () => 'nodev\tsysfs\nnodev\ttmpfs\nnodev\tproc\n\text4\n\tvfat\n');
  gen('cmdline', () => `BOOT_IMAGE=/boot/vmlinuz-${system.kernel} root=LABEL=cloudimg-rootfs ro console=tty1 console=ttyS0\n`);
  gen('stat', () => 'cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0\nbtime ' + Math.floor(system.boot / 1000) + '\nprocesses 26442\nprocs_running 1\nprocs_blocked 0\n');
  gen('swaps', () => 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swap.img                               file\t\t2097148\t\t0\t\t-2\n');
  gen('hostname', () => system.hostname + '\n');
  vfs.mkdirp('/proc/sys/kernel');
  vfs.putGen('/proc/sys/kernel/hostname', () => system.hostname + '\n');
  vfs.putGen('/proc/sys/kernel/ostype', () => 'Linux\n');
  vfs.putGen('/proc/sys/kernel/osrelease', () => system.kernel + '\n');
  vfs.mkdirp('/proc/self/fd');
  vfs.putGen('/proc/self/cmdline', () => 'bash\0');
  vfs.putGen('/proc/self/status', () => {
    const sh = getShell();
    return `Name:\tbash\nState:\tR (running)\nPid:\t${sh ? sh.pid : 1}\nPPid:\t${sh ? sh.ppid : 1}\nUid:\t${vfs.cred.uid}\t${vfs.cred.uid}\t${vfs.cred.uid}\t${vfs.cred.uid}\n`;
  });
  vfs.putGen('/proc/self/environ', () => {
    const sh = getShell();
    return sh ? Object.entries(sh.exportedEnv()).map(([k, v]) => `${k}=${v}\0`).join('') : '';
  });
  const sys = vfs.mkdirp('/sys', 0o555);
  sys.virtual = true;
  vfs.mkdirp('/sys/class/net/ens3');
  vfs.mkdirp('/sys/class/net/lo');
  vfs.putGen('/sys/class/net/ens3/address', () => '52:54:00:12:34:56\n');
  vfs.mkdirp('/sys/kernel');
  vfs.mkdirp('/run/user/1000', 0o700).uid = 1000;
  vfs.putGen('/run/utmp', () => '');
}

// set up a login shell for the default user
export function loginEnv(shell, user = { name: 'user', uid: 1000, gid: 1000, home: '/home/user' }) {
  const set = (k, v, x = true) => shell.globals.set(k, { v, x });
  set('HOME', user.home);
  set('USER', user.name);
  set('LOGNAME', user.name);
  set('SHELL', '/bin/bash');
  set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin');
  set('TERM', 'xterm-256color');
  set('COLORTERM', 'truecolor');
  set('LANG', 'C.UTF-8');
  set('PWD', user.home);
  set('SHLVL', '1');
  set('MAIL', `/var/mail/${user.name}`);
  set('XDG_RUNTIME_DIR', `/run/user/${user.uid}`);
  set('XDG_SESSION_TYPE', 'tty');
  set('SSH_CONNECTION', '192.168.1.10 51834 10.0.2.15 22');
  set('SSH_CLIENT', '192.168.1.10 51834 22');
  set('SSH_TTY', '/dev/pts/0');
  set('LS_COLORS', 'rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:ca=00:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.tar=01;31:*.tgz=01;31:*.zip=01;31:*.gz=01;31:*.jpg=01;35:*.png=01;35:*.mp3=00;36:');
  set('EDITOR', 'nano');
  set('PAGER', 'less');
  set('HOSTNAME', shell.system.hostname, false);
  set('HISTFILE', `${user.home}/.bash_history`, false);
  set('HISTSIZE', '1000', false);
  set('HISTFILESIZE', '2000', false);
  set('IFS', ' \t\n', false);
  set('PS1', '\\s-\\v\\$ ', false);
  set('PS2', '> ', false);
  set('PS4', '+ ', false);
  set('OPTIND', '1', false);
  set('OPTERR', '1', false);
  set('BASH', '/usr/bin/bash', false);
  set('BASH_VERSION', '5.2.21(1)-release', false);
  shell.globals.set('BASH_VERSINFO', { a: new Map([[0, '5'], [1, '2'], [2, '21'], [3, '1'], [4, 'release'], [5, 'x86_64-pc-linux-gnu']]), r: true });
  set('HOSTTYPE', 'x86_64', false);
  set('MACHTYPE', 'x86_64-pc-linux-gnu', false);
  set('OSTYPE', 'linux-gnu', false);
  set('TERM_PROGRAM', 'xterm.js');
  set('_', '/usr/bin/bash');
  shell.user = { uid: user.uid, gid: user.gid, name: user.name, groups: shell.system.groupsOf(user.name) };
  shell.vfs.cred = { uid: user.uid, gid: user.gid, groups: shell.user.groups };
  shell.cwd = user.home;
  shell.argv0 = '-bash';
  shell.shopt.login_shell = true;
  shell.shopt.expand_aliases = true;
}

export function createMachine({ restore = null, extraCommands = {} } = {}) {
  const vfs = new VFS();
  const system = new System(vfs);
  const registry = makeRegistry(extraCommands);
  let fresh = true;
  if (restore && restore.fs) {
    try {
      vfs.restore(restore.fs);
      if (restore.installed) for (const p of restore.installed) system.installed.add(p);
      if (restore.hostname) system.hostname = restore.hostname;
      fresh = false;
    } catch {
      fresh = true;
    }
  }
  if (fresh) {
    vfs.root = new VFS().root;
    buildFilesystem(vfs, system, registry);
  } else ensureBinaries(vfs, system, registry);
  let current = null;
  buildVirtual(vfs, system, () => current);
  const newShell = () => {
    const sh = new Shell({ vfs, commands: registry, system });
    loginEnv(sh);
    current = sh;
    return sh;
  };
  return { vfs, system, registry, newShell, fresh };
}
