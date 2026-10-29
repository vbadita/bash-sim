# bash-sim

A bash shell and GNU/Linux userland, simulated in the browser. Served at
`https://apps.badita.com/bash/`.

```
Browser: xterm.js -> terminal.js (readline, completion, raw keys)
           -> shell.js (parser, expansion, interpreter, jobs) -> cmds/*.js (~250 commands)
           -> vfs.js (in-memory filesystem, saved to localStorage)
VM: nginx serves the static files (apps.badita.com/bash/); nothing runs per visitor.
```

Nothing typed on the page leaves the browser: there is no backend. The
filesystem is kept in the visitor's `localStorage`; `reset-sim` wipes it.

## What is simulated

| Area | What works |
|---|---|
| Language | the full grammar: pipelines, `&&` `\|\|` `;` `&`, `( )` `{ }`, `if`/`case`/`for`/`for ((;;))`/`while`/`until`/`select`, functions, `[[ ]]` with `=~`, `(( ))`, here-docs and here-strings, process substitution `<( )` `>( )`, all redirections including `exec` and `{fd}>` |
| Expansion | brace, tilde, every `${...}` operator (`:-` `:=` `:?` `:+` `#` `##` `%` `%%` `/` `//` `^^` `,,` `@Q` `@A` ... ), indirection, namerefs, arrays and associative arrays, `$((...))` with 64-bit arithmetic, command substitution, IFS word splitting, globbing with extglob/globstar/nullglob/dotglob |
| Builtins | all bash builtins: `cd pushd popd dirs read mapfile printf echo declare local export readonly unset set shopt trap eval exec source getopts let test [ type command hash alias history fc jobs fg bg wait kill disown umask ulimit times help compgen ...` |
| Commands | coreutils (`ls cp mv rm mkdir find stat chmod chown ln du df sort uniq cut tr wc head tail tee seq ...`), `grep sed awk` (own implementations; awk follows gawk), `diff cmp comm join paste column`, `tar gzip zip unzip base64 md5sum sha*sum od xxd hexdump`, `bc expr factor`, `ps top htop kill pgrep free uptime`, `sudo su useradd passwd`, `nano vim less more man`, `curl wget ping ssh ip` (network is canned), `apt` (can "install" cowsay, sl, figlet, cmatrix, lolcat, neofetch, jq, htop, fortune) |
| Interactive | prompt from `~/.bashrc`, Tab completion, history with `!!`/`!n`/`^a^b`/Ctrl-R, Ctrl-C/Ctrl-D/Ctrl-L, emacs line editing, background jobs with notifications, full-screen programs |

Limits: there is no kernel, so processes, users, permissions and the network
are modelled, not real. `exec`, `kill -9 $$`, `reboot` and `exit` end the
session and log in again.

## Layout

| Path | What |
|---|---|
| `site/index.html`, `site/style.css` | the page (CSP: scripts only from the same origin) |
| `site/js/parser.js` | lexer and recursive-descent parser (words kept raw) |
| `site/js/expand.js` | word expansion |
| `site/js/shell.js` | interpreter: variables, redirections, pipelines (async, with backpressure), jobs, traps |
| `site/js/arith.js`, `pattern.js` | shell arithmetic (BigInt), glob/pattern matching |
| `site/js/vfs.js`, `streams.js` | filesystem (inodes, links, permissions, /proc), pipes |
| `site/js/terminal.js` | readline, completion, cooked/raw input, the REPL |
| `site/js/boot.js` | command registry, default filesystem, login environment |
| `site/js/cmds/` | commands: `builtins`, `files`, `text`, `sed`, `awk`, `sys`, `editors`, `man`, `fun` |
| `site/vendor/` | xterm.js 5.5.0 + fit addon (MIT), FIGlet Standard font |
| `tests/compare.mjs` | differential tests: each case runs in the simulator and in real bash 5.2 (in a copy of the simulated home) and must print the same |
| `tests/ui.mjs` | Playwright test of the real page: typing, completion, Ctrl-C, nano, vim, less, jobs, apt, persistence |
| `deploy/` | nginx location, pull-based sync script, systemd units, installer |
| `.github/workflows/site.yml` | test -> build branch `site` -> wait for the VM to serve it -> headless Chrome check |

## Development

```bash
node tests/compare.mjs            # batch 1 against the local bash (needs gawk as awk)
CASES=2 node tests/compare.mjs    # batch 2
node tests/ui.mjs                 # needs Playwright + Chromium
node tests/serve.mjs 8080         # http://127.0.0.1:8080/bash/ with the production headers
node tests/smoke.mjs 'echo $((6*7)) | rev'
```

## Deployment

CI publishes a tested build to the branch `site`. On the VM, a timer pulls it
every 5 minutes into `/srv/bash-sim/releases/<sha>` and switches the
`/srv/bash-sim/bash` symlink atomically (3 releases kept for rollback). Once:

```bash
git clone https://github.com/vbadita/bash-sim && cd bash-sim && deploy/install-sync.sh
```
