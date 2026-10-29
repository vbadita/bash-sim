// Shell pattern matching: * ? [...] [[:class:]] extglob, backslash escapes.

const CLASSES = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e', word: 'A-Za-z0-9_',
};

const reEsc = (c) => c.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&');

export function hasGlob(p, extglob = true) {
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '*' || c === '?') return true;
    if (c === '[' && p.indexOf(']', i + 2) > 0) return true;
    if (extglob && '@!+'.includes(c) && p[i + 1] === '(') return true;
  }
  return false;
}

// translate a pattern into a regex source (not anchored)
export function patternSource(p, { extglob = true, pathname = false, nocase = false } = {}) {
  let out = '';
  const any = pathname ? '[^/]' : '[\\s\\S]';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      if (i + 1 < p.length) out += reEsc(p[++i]);
      else out += '\\\\';
      continue;
    }
    if (extglob && '?*+@!'.includes(c) && p[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < p.length; j++) {
        if (p[j] === '\\') {
          j++;
          continue;
        }
        if (p[j] === '(') depth++;
        else if (p[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j < p.length) {
        const inner = splitAlts(p.slice(i + 2, j)).map((a) => patternSource(a, { extglob, pathname })).join('|');
        const rest = patternSource(p.slice(j + 1), { extglob, pathname });
        if (c === '?') out += `(?:${inner})?`;
        else if (c === '*') out += `(?:${inner})*`;
        else if (c === '+') out += `(?:${inner})+`;
        else if (c === '@') out += `(?:${inner})`;
        else out += `(?:(?!(?:${inner})${rest}$)${any}*?)`;
        out += rest;
        return out;
      }
    }
    if (c === '*') {
      out += any + '*';
      while (p[i + 1] === '*') i++;
      continue;
    }
    if (c === '?') {
      out += any;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (p[j] === '!' || p[j] === '^') {
        neg = true;
        j++;
      }
      let cls = '';
      let first = true;
      let ok = false;
      for (; j < p.length; j++) {
        const d = p[j];
        if (d === ']' && !first) {
          ok = true;
          break;
        }
        first = false;
        if (d === '[' && p[j + 1] === ':') {
          const k = p.indexOf(':]', j + 2);
          if (k > 0) {
            const name = p.slice(j + 2, k);
            cls += CLASSES[name] || '';
            j = k + 1;
            continue;
          }
        }
        if (d === '\\' && j + 1 < p.length) {
          cls += reEsc(p[++j]);
          continue;
        }
        if (d === '-' && cls && p[j + 1] !== ']') {
          cls += '-';
          continue;
        }
        cls += reEsc(d);
      }
      if (ok) {
        out += neg ? `[^${cls}${pathname ? '/' : ''}]` : `[${cls}]`;
        i = j;
        continue;
      }
      out += '\\[';
      continue;
    }
    out += reEsc(c);
  }
  return out;
}

function splitAlts(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      cur += c + (s[i + 1] || '');
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const cache = new Map();
export function patternRegex(p, opts = {}) {
  const key = p + '\0' + JSON.stringify(opts);
  let r = cache.get(key);
  if (!r) {
    const flags = opts.nocase ? 'i' : '';
    try {
      r = new RegExp('^(?:' + patternSource(p, opts) + ')$', flags);
    } catch {
      r = new RegExp('^' + reEsc(unescapePattern(p)) + '$', flags);
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, r);
  }
  return r;
}

export function matchPattern(p, s, opts) {
  return patternRegex(p, opts).test(s);
}

export function unescapePattern(p) {
  return p.replace(/\\(.)/g, '$1');
}

// for ${var#pat} etc.: find shortest/longest prefix/suffix match
export function removeMatch(value, pat, mode, opts) {
  const re = patternRegex(pat, opts);
  const n = value.length;
  if (mode === '#') {
    for (let i = 0; i <= n; i++) if (re.test(value.slice(0, i))) return value.slice(i);
  } else if (mode === '##') {
    for (let i = n; i >= 0; i--) if (re.test(value.slice(0, i))) return value.slice(i);
  } else if (mode === '%') {
    for (let i = n; i >= 0; i--) if (re.test(value.slice(i))) return value.slice(0, i);
  } else if (mode === '%%') {
    for (let i = 0; i <= n; i++) if (re.test(value.slice(i))) return value.slice(0, i);
  }
  return value;
}

// ${var/pat/rep}: mode '/', '//', '/#', '/%'
export function replaceMatch(value, pat, rep, mode, opts) {
  const re = patternRegex(pat, opts);
  const n = value.length;
  if (pat === '' && mode !== '/#' && mode !== '/%') return value;
  if (mode === '/#') {
    for (let j = n; j >= 0; j--) if (re.test(value.slice(0, j))) return rep + value.slice(j);
    return value;
  }
  if (mode === '/%') {
    for (let i = 0; i <= n; i++) if (re.test(value.slice(i))) return value.slice(0, i) + rep;
    return value;
  }
  let out = '';
  let i = 0;
  let done = false;
  while (i <= n) {
    let matched = -1;
    if (!done) {
      for (let j = n; j > i; j--) {
        if (re.test(value.slice(i, j))) {
          matched = j;
          break;
        }
      }
    }
    if (matched >= 0) {
      out += rep;
      i = matched;
      if (mode === '/') done = true;
    } else {
      if (i < n) out += value[i];
      i++;
    }
  }
  return out;
}

// filename expansion against the VFS. Returns sorted matches or [] if none.
export function globFiles(vfs, cwd, pattern, { dotglob = false, globstar = false, nocase = false, extglob = true } = {}) {
  const abs = pattern.startsWith('/');
  const parts = pattern.split('/');
  const results = [];
  const start = abs ? '/' : cwd;
  const prefix0 = abs ? '/' : '';
  const walk = (dirPath, prefix, idx) => {
    if (idx >= parts.length) {
      results.push(prefix.replace(/\/$/, '') || '/');
      return;
    }
    const part = parts[idx];
    const isLast = idx === parts.length - 1;
    if (part === '') {
      if (isLast) results.push(prefix);
      else walk(dirPath, prefix, idx + 1);
      return;
    }
    if (!hasGlob(part, extglob)) {
      const name = unescapePattern(part);
      const p = dirPath === '/' ? '/' + name : dirPath + '/' + name;
      let node;
      try {
        node = vfs.walk(p, cwd, true).node;
      } catch {
        return;
      }
      if (!node && !(isLast && safeLexists(vfs, p, cwd))) return;
      if (!isLast && (!node || node.type !== 'dir')) return;
      walk(p, prefix + name + (isLast ? '' : '/'), idx + 1);
      return;
    }
    if (globstar && part === '**') {
      // zero or more directories
      walk(dirPath, prefix, idx + 1);
      const rec = (dp, pre) => {
        let names;
        try {
          names = vfs.readdir(dp, cwd);
        } catch {
          return;
        }
        for (const nm of names) {
          if (nm.startsWith('.') && !dotglob) continue;
          const p = dp === '/' ? '/' + nm : dp + '/' + nm;
          let node;
          try {
            node = vfs.stat(p, cwd, false);
          } catch {
            continue;
          }
          if (node.type === 'dir') {
            walk(p, pre + nm + '/', idx + 1);
            rec(p, pre + nm + '/');
          }
        }
      };
      rec(dirPath, prefix);
      return;
    }
    let names;
    try {
      names = vfs.readdir(dirPath, cwd);
    } catch {
      return;
    }
    const re = patternRegex(part, { extglob, nocase });
    const explicitDot = part.startsWith('.') || part.startsWith('\\.');
    for (const nm of names) {
      if (nm.startsWith('.') && !explicitDot && !dotglob) continue;
      if (!re.test(nm)) continue;
      const p = dirPath === '/' ? '/' + nm : dirPath + '/' + nm;
      if (!isLast) {
        let node;
        try {
          node = vfs.stat(p, cwd, true);
        } catch {
          continue;
        }
        if (node.type !== 'dir') continue;
        walk(p, prefix + nm + '/', idx + 1);
      } else walk(p, prefix + nm, idx + 1);
    }
  };
  walk(start, prefix0, abs ? 1 : 0);
  return [...new Set(results)].sort(cmpC);
}

function safeLexists(vfs, p, cwd) {
  try {
    return !!vfs.walk(p, cwd, false).node;
  } catch {
    return false;
  }
}

export function cmpC(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
