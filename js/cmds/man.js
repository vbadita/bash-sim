// man, whatis, apropos, info: manual pages generated from a description table
// and each command's --help text, shown through the pager.

import { pager } from './editors.js';

export const WHATIS = {
  awk: [1, 'pattern scanning and processing language'], gawk: [1, 'pattern scanning and processing language'],
  base64: [1, 'base64 encode/decode data and print to standard output'], base32: [1, 'base32 encode/decode data and print to standard output'],
  basename: [1, 'strip directory and suffix from filenames'], bash: [1, 'GNU Bourne-Again SHell'], bc: [1, 'An arbitrary precision calculator language'],
  cal: [1, 'displays a calendar'], cat: [1, 'concatenate files and print on the standard output'], cd: [1, 'change the working directory (shell builtin)'],
  chgrp: [1, 'change group ownership'], chmod: [1, 'change file mode bits'], chown: [1, 'change file owner and group'], cksum: [1, 'compute and verify file checksums'],
  clear: [1, 'clear the terminal screen'], cmp: [1, 'compare two files byte by byte'], column: [1, 'columnate lists'], comm: [1, 'compare two sorted files line by line'],
  cp: [1, 'copy files and directories'], crontab: [1, 'maintain crontab files for individual users'], curl: [1, 'transfer a URL'], cut: [1, 'remove sections from each line of files'],
  date: [1, 'print or set the system date and time'], dd: [1, 'convert and copy a file'], df: [1, 'report file system space usage'], diff: [1, 'compare files line by line'],
  dirname: [1, 'strip last component from file name'], dmesg: [1, 'print or control the kernel ring buffer'], du: [1, 'estimate file space usage'],
  echo: [1, 'display a line of text'], env: [1, 'run a program in a modified environment'], expand: [1, 'convert tabs to spaces'], expr: [1, 'evaluate expressions'],
  factor: [1, 'factor numbers'], false: [1, 'do nothing, unsuccessfully'], file: [1, 'determine file type'], find: [1, 'search for files in a directory hierarchy'],
  fmt: [1, 'simple optimal text formatter'], fold: [1, 'wrap each input line to fit in specified width'], free: [1, 'Display amount of free and used memory in the system'],
  grep: [1, 'print lines that match patterns'], groups: [1, 'print the groups a user is in'], gzip: [1, 'compress or expand files'], gunzip: [1, 'compress or expand files'],
  head: [1, 'output the first part of files'], hexdump: [1, 'display file contents in hexadecimal, decimal, octal, or ascii'], hostname: [1, "show or set the system's host name"],
  id: [1, 'print real and effective user and group IDs'], ip: [8, 'show / manipulate routing, network devices, interfaces and tunnels'],
  join: [1, 'join lines of two files on a common field'], kill: [1, 'send a signal to a process'], killall: [1, 'kill processes by name'], less: [1, 'opposite of more'],
  ln: [1, 'make links between files'], locale: [1, 'get locale-specific information'], ls: [1, 'list directory contents'], lsblk: [8, 'list block devices'],
  man: [1, 'an interface to the system reference manuals'], md5sum: [1, 'compute and check MD5 message digest'], mkdir: [1, 'make directories'], mktemp: [1, 'create a temporary file or directory'],
  more: [1, 'display the contents of a file in a terminal'], mv: [1, 'move (rename) files'], nano: [1, 'Nano\'s ANOther editor, inspired by Pico'], nl: [1, 'number lines of files'],
  nohup: [1, 'run a command immune to hangups, with output to a non-tty'], nproc: [1, 'print the number of processing units available'], od: [1, 'dump files in octal and other formats'],
  passwd: [1, 'change user password'], paste: [1, 'merge lines of files'], ping: [8, 'send ICMP ECHO_REQUEST to network hosts'], printenv: [1, 'print all or part of environment'],
  printf: [1, 'format and print data'], ps: [1, 'report a snapshot of the current processes.'], pwd: [1, 'print name of current/working directory'], readlink: [1, 'print resolved symbolic links or canonical file names'],
  realpath: [1, 'print the resolved path'], rev: [1, 'reverse lines characterwise'], rm: [1, 'remove files or directories'], rmdir: [1, 'remove empty directories'],
  sed: [1, 'stream editor for filtering and transforming text'], seq: [1, 'print a sequence of numbers'], sha1sum: [1, 'compute and check SHA1 message digest'],
  sha256sum: [1, 'compute and check SHA256 message digest'], sha512sum: [1, 'compute and check SHA512 message digest'], shuf: [1, 'generate random permutations'],
  sleep: [1, 'delay for a specified amount of time'], sort: [1, 'sort lines of text files'], split: [1, 'split a file into pieces'], ssh: [1, 'OpenSSH remote login client'],
  stat: [1, 'display file or file system status'], strings: [1, 'print the sequences of printable characters in files'], su: [1, 'run a command with substitute user and group ID'],
  sudo: [8, 'execute a command as another user'], systemctl: [1, 'Control the systemd system and service manager'], tac: [1, 'concatenate and print files in reverse'],
  tail: [1, 'output the last part of files'], tar: [1, 'an archiving utility'], tee: [1, 'read from standard input and write to standard output and files'],
  test: [1, 'check file types and compare values'], time: [1, 'run programs and summarize system resource usage'], timeout: [1, 'run a command with a time limit'],
  top: [1, 'display Linux processes'], touch: [1, 'change file timestamps'], tput: [1, 'initialize a terminal or query terminfo database'], tr: [1, 'translate or delete characters'],
  tree: [1, 'list contents of directories in a tree-like format.'], true: [1, 'do nothing, successfully'], truncate: [1, 'shrink or extend the size of a file to the specified size'],
  tty: [1, 'print the file name of the terminal connected to standard input'], uname: [1, 'print system information'], uniq: [1, 'report or omit repeated lines'],
  unzip: [1, 'list, test and extract compressed files in a ZIP archive'], uptime: [1, 'Tell how long the system has been running.'], useradd: [8, 'create a new user or update default new user information'],
  vi: [1, 'Vi IMproved, a programmer\'s text editor'], vim: [1, 'Vi IMproved, a programmer\'s text editor'], w: [1, 'Show who is logged on and what they are doing.'],
  watch: [1, 'execute a program periodically, showing output fullscreen'], wc: [1, 'print newline, word, and byte counts for each file'], wget: [1, 'The non-interactive network downloader.'],
  whereis: [1, 'locate the binary, source, and manual page files for a command'], which: [1, 'locate a command'], who: [1, 'show who is logged on'], whoami: [1, 'print effective user name'],
  xargs: [1, 'build and execute command lines from standard input'], xxd: [1, 'make a hex dump or do the reverse.'], yes: [1, 'output a string repeatedly until killed'],
  zcat: [1, 'compress or expand files'], zip: [1, 'package and compress (archive) files'], apt: [8, 'command-line interface'], dpkg: [1, 'package manager for Debian'],
  jq: [1, 'Command-line JSON processor'], cowsay: [6, 'configurable speaking/thinking cow (and a bit more)'], fortune: [6, 'print a random, hopefully interesting, adage'],
  figlet: [6, 'display large characters made up of ordinary screen characters'], sl: [6, 'display animations aimed to correct users who accidentally enter sl instead of ls.'],
  htop: [1, 'interactive process viewer'], neofetch: [1, 'A fast, highly customizable system info script'], lolcat: [6, 'rainbow coloring for text'],
  cmatrix: [1, 'simulates the display from "The Matrix"'], iconv: [1, 'convert text from one character encoding to another'], numfmt: [1, 'Convert numbers from/to human-readable strings'],
  tsort: [1, 'perform topological sort'], unexpand: [1, 'convert spaces to tabs'], dos2unix: [1, 'DOS/Mac to Unix and vice versa text file format converter'],
  getent: [1, 'get entries from Name Service Switch libraries'], install: [1, 'copy files and set attributes'], link: [1, 'call the link function to create a link to a file'],
  unlink: [1, 'call the unlink function to remove the specified file'], mkfifo: [1, 'make FIFOs (named pipes)'], shred: [1, 'overwrite a file to hide its contents, and optionally delete it'],
  sum: [1, 'checksum and count the blocks in a file'], look: [1, 'display lines beginning with a given string'], arch: [1, 'print machine hardware name (same as uname -m)'],
  lscpu: [1, 'display information about the CPU architecture'], vmstat: [8, 'Report virtual memory statistics'], pgrep: [1, 'look up, signal, or wait for processes based on name and other attributes'],
  pkill: [1, 'look up, signal, or wait for processes based on name and other attributes'], nice: [1, 'run a program with modified scheduling priority'],
  usermod: [8, 'modify a user account'], userdel: [8, 'delete a user account and related files'], groupadd: [8, 'create a new group'], adduser: [8, 'add a user to the system'],
  journalctl: [1, 'Print log entries from the systemd journal'], service: [8, 'run a System V init script'], shutdown: [8, 'Halt, power off or reboot the machine'],
  mount: [8, 'mount a filesystem'], dig: [1, 'DNS lookup utility'], nslookup: [1, 'query Internet name servers interactively'], host: [1, 'DNS lookup utility'],
  ifconfig: [8, 'configure a network interface'], ss: [8, 'another utility to investigate sockets'], netstat: [8, 'Print network connections, routing tables, interface statistics'],
  traceroute: [1, 'print the route packets trace to network host'], lsb_release: [1, 'print distribution-specific information'], logger: [1, 'enter messages into the system log'],
  wall: [1, 'write a message to all users'], last: [1, 'show a listing of last logged in users'], users: [1, 'print the user names of users currently logged in to the current host'],
  stty: [1, 'change and print terminal line settings'], reset: [1, 'terminal initialization'], hostnamectl: [1, 'Control the system hostname'], timedatectl: [1, 'Control the system time and date'],
  lsof: [8, 'list open files'], mesg: [1, 'display (or do not display) messages from other users'], chsh: [1, 'change login shell'], snap: [8, 'Tool to interact with snaps'],
  sh: [1, 'command interpreter (shell)'], dash: [1, 'command interpreter (shell)'], egrep: [1, 'print lines that match patterns'], fgrep: [1, 'print lines that match patterns'],
};

const BASH_MAN = `NAME
       bash - GNU Bourne-Again SHell

SYNOPSIS
       bash [options] [command_string | file]

DESCRIPTION
       This is a browser simulation of Bash 5.2 running at apps.badita.com/bash.
       Everything runs locally in your browser: a parser and interpreter written
       in JavaScript, a virtual filesystem kept in this browser's storage, and
       implementations of the usual GNU/Linux commands. Nothing is sent to a
       server.

SHELL GRAMMAR
       Simple commands, pipelines (|, |&), lists (;, &, &&, ||), compound
       commands: ( list ), { list; }, (( expression )), [[ expression ]],
       for name [ in word ] ; do list ; done, for (( e1 ; e2 ; e3 )) ; do list ;
       done, select, case, if/elif/else, while, until, and function
       definitions: name () compound-command, function name compound-command.

QUOTING
       Backslash, 'single quotes', "double quotes", $'ANSI-C quoting' and
       $"locale quoting" behave as in bash.

PARAMETERS
       Positional parameters $1..$9, \${10}; special parameters $*, $@, $#, $?,
       $-, $$, $!, $0, $_. Indexed arrays a=(x y z), associative arrays
       (declare -A), namerefs (declare -n), integer and case attributes.
       Shell variables include BASH_VERSION, BASHPID, PIPESTATUS, RANDOM,
       SRANDOM, SECONDS, LINENO, EPOCHSECONDS, EPOCHREALTIME, FUNCNAME,
       BASH_REMATCH, DIRSTACK, HISTCMD, IFS, PATH, PS1, PS2, PS3, PS4, PWD,
       OLDPWD, OPTIND, OPTARG, REPLY, HOME, USER, SHLVL and more.

EXPANSION
       Brace expansion {a,b} {1..10..2}, tilde expansion, parameter expansion
       with all operators (\${v:-w} \${v:=w} \${v:?w} \${v:+w} \${#v} \${v:o:l}
       \${v#p} \${v##p} \${v%p} \${v%%p} \${v/p/r} \${v//p/r} \${v^} \${v^^}
       \${v,} \${v,,} \${!v} \${!pre*} \${!arr[@]} \${v@Q} \${v@U} \${v@L} \${v@A}
       \${v@E} \${v@P}), command substitution $(...) and \`...\`, arithmetic
       expansion $((...)), process substitution <(...) and >(...), word
       splitting on IFS, pathname expansion with *, ?, [...], extglob and
       globstar (shopt -s globstar).

REDIRECTION
       < > >> >| <> &> &>> 2>&1 >&2 n>&m n<&m n>&- here-documents (<< and
       <<-, quoted or unquoted) and here-strings (<<<), /dev/null, /dev/stdin,
       /dev/stdout, /dev/stderr, /dev/tty, {var}>file.

JOB CONTROL
       command & runs a job in the background; jobs, fg, wait, kill %n and
       disown manage them. Ctrl-C interrupts the foreground command.

READLINE
       Emacs-style line editing: Ctrl-A/E/B/F/K/U/W/Y/T/L/D, Alt-B/F/D/.,
       arrow keys, history (Up/Down, Ctrl-R reverse search, !!, !n, !-n,
       !string, !$, ^old^new) and Tab completion of commands, files,
       variables and users.

SHELL BUILTIN COMMANDS
       : . [ alias bg bind break builtin caller cd command compgen complete
       continue declare dirs disown echo enable eval exec exit export false fc
       fg getopts hash help history jobs kill let local logout mapfile popd
       printf pushd pwd read readarray readonly return set shift shopt source
       suspend test times trap true type typeset ulimit umask unalias unset
       wait. Run help name for details.

FILES
       /etc/profile, ~/.bash_profile, ~/.profile, ~/.bashrc, ~/.bash_history,
       ~/.bash_logout

LIMITATIONS
       The network is simulated (ping, curl, wget answer from a small set of
       canned hosts); processes are simulated; there is no real kernel. To
       start over with a fresh filesystem, run: reset-sim

AUTHORS
       Simulation for apps.badita.com. Bash itself is by Brian Fox and Chet
       Ramey.
`;

function renderPage(name, section, body, tty) {
  const B = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
  const U = (s) => (tty ? `\x1b[4m${s}\x1b[0m` : s);
  const head = `${name.toUpperCase()}(${section})`;
  const center = section === 8 ? 'System Administration' : section === 6 ? 'Games Manual' : 'User Commands';
  const width = 78;
  const gap = Math.max(1, Math.floor((width - head.length * 2 - center.length) / 2));
  let out = head + ' '.repeat(gap) + center + ' '.repeat(Math.max(1, width - head.length * 2 - center.length - gap)) + head + '\n\n';
  for (const line of body.split('\n')) {
    if (/^[A-Z][A-Z ]+$/.test(line)) out += B(line) + '\n';
    else out += line.replace(/(^|\s)(-{1,2}[A-Za-z][\w-]*)/g, (m, a, b) => a + B(b)).replace(/\b(FILE|PATTERNS?|DIRECTORY|SOURCE|DEST|OPTION)\b/g, (m) => U(m)) + '\n';
  }
  out += `\nGNU/Linux simulation                  2026-10-29                    ${head}\n`;
  return out;
}

function buildBody(shell, name) {
  if (name === 'bash' || name === 'sh') return BASH_MAN;
  const w = WHATIS[name];
  const entry = shell.commands.get(name);
  const help = entry && entry.help;
  let body = `NAME\n       ${name} - ${w ? w[1] : 'command'}\n\nSYNOPSIS\n`;
  if (help) {
    const lines = help.split('\n');
    const usage = lines[0].replace(/^Usage:\s*/, '');
    body += `       ${usage}\n\nDESCRIPTION\n`;
    for (const l of lines.slice(1)) body += l ? `       ${l.replace(/^\s+/, (m) => m)}\n` : '\n';
  } else {
    body += `       ${name} [OPTION]... [ARGUMENT]...\n\nDESCRIPTION\n       ${w ? w[1].charAt(0).toUpperCase() + w[1].slice(1) + '.' : ''}\n\n       Run '${name} --help' for the options this simulation supports.\n`;
  }
  body += `\nSEE ALSO\n       bash(1), help(1)\n`;
  return body;
}

async function man(ctx) {
  const args = ctx.args.filter((a) => !/^\d$/.test(a));
  if (ctx.args[0] === '-k') return apropos({ ...ctx, args: ctx.args.slice(1) });
  if (ctx.args[0] === '-f') return whatis({ ...ctx, args: ctx.args.slice(1) });
  if (!args.length) {
    await ctx.err('What manual page do you want?\nFor example, try \'man man\'.\n');
    return 1;
  }
  let st = 0;
  for (const name of args) {
    const known = WHATIS[name] || name === 'bash' || name === 'sh';
    const entry = ctx.shell.commands.get(name);
    if (!known && (!entry || entry.builtin)) {
      await ctx.err(`No manual entry for ${name}\n`);
      st = 16;
      continue;
    }
    const tty = !!ctx.stdout.isTerminalWriter;
    const sec = WHATIS[name] ? WHATIS[name][0] : 1;
    const page = renderPage(name, sec, buildBody(ctx.shell, name), tty);
    await pager(ctx, page, { prompt: ` Manual page ${name}(${sec}) line 1 (press h for help or q to quit)` });
  }
  return st;
}

async function whatis(ctx) {
  let st = 0;
  for (const n of ctx.args.filter((a) => !a.startsWith('-'))) {
    const w = WHATIS[n];
    if (w) await ctx.out(`${(n + ` (${w[0]})`).padEnd(20)} - ${w[1]}\n`);
    else {
      await ctx.out(`${n}: nothing appropriate.\n`);
      st = 16;
    }
  }
  return st;
}

async function apropos(ctx) {
  const terms = ctx.args.filter((a) => !a.startsWith('-')).map((t) => t.toLowerCase());
  if (!terms.length) {
    await ctx.out('apropos what?\n');
    return 1;
  }
  const hits = Object.entries(WHATIS).filter(([n, [, d]]) => terms.some((t) => n.includes(t) || d.toLowerCase().includes(t))).sort();
  if (!hits.length) {
    await ctx.out(`${terms.join(' ')}: nothing appropriate.\n`);
    return 16;
  }
  await ctx.out(hits.map(([n, [s, d]]) => `${(n + ` (${s})`).padEnd(20)} - ${d}\n`).join(''));
  return 0;
}

export function install(reg) {
  reg.set('man', { fn: man });
  reg.set('info', { fn: man });
  reg.set('whatis', { fn: whatis });
  reg.set('apropos', { fn: apropos });
}
