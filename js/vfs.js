// In-memory POSIX-like filesystem: inodes, directories, symlinks, hard links,
// permissions, device and /proc files. Persisted to localStorage by the caller.

export const ERRNO = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  EBUSY: 'Device or resource busy',
  ENOSPC: 'No space left on device',
  EXDEV: 'Invalid cross-device link',
};

export class FsError extends Error {
  constructor(code, path) {
    super(ERRNO[code] || code);
    this.code = code;
    this.path = path;
  }
}
const err = (code, path) => new FsError(code, path);

let inoNext = 2;

export class Node {
  constructor(type, mode, uid = 0, gid = 0) {
    this.type = type; // file | dir | link | chr | fifo
    this.mode = mode;
    this.uid = uid;
    this.gid = gid;
    const t = Date.now();
    this.atime = this.mtime = this.ctime = t;
    this.ino = inoNext++;
    this.nlink = type === 'dir' ? 2 : 1;
    if (type === 'dir') this.children = new Map();
    if (type === 'file') this.data = '';
  }
}

const MAX_LINKS = 40;

export class VFS {
  constructor() {
    this.root = new Node('dir', 0o755);
    this.root.ino = 1;
    this.root.parent = this.root;
    this.cred = { uid: 0, gid: 0, groups: [0] };
    this.devices = {}; // name -> {read(): string, write(s)}
    this.onChange = null;
    this.limitBytes = 8 * 1024 * 1024;
  }

  changed() {
    if (this.onChange) this.onChange();
  }

  // permission check: want is a mask of 4 (r), 2 (w), 1 (x)
  can(node, want) {
    const { uid, groups } = this.cred;
    if (uid === 0) {
      if (want & 1 && node.type !== 'dir') return (node.mode & 0o111) !== 0;
      return true;
    }
    let bits;
    if (node.uid === uid) bits = (node.mode >> 6) & 7;
    else if (groups.includes(node.gid)) bits = (node.mode >> 3) & 7;
    else bits = node.mode & 7;
    return (bits & want) === want;
  }

  check(node, want, path) {
    if (!this.can(node, want)) throw err('EACCES', path);
  }

  splitPath(path) {
    return path.split('/').filter((p) => p !== '' && p !== '.' || false);
  }

  // Walk a path. Returns {node, parent, name, canon} where node may be null if the
  // last component does not exist (parent is then the directory it would live in).
  walk(path, cwd = '/', follow = true, depth = 0) {
    if (path === '') throw err('ENOENT', path);
    if (depth > MAX_LINKS) throw err('ELOOP', path);
    let node, canon;
    if (path.startsWith('/')) {
      node = this.root;
      canon = [];
    } else {
      const c = this.walk(cwd, '/', true, depth + 1);
      if (!c.node) throw err('ENOENT', cwd);
      node = c.node;
      canon = c.canon.slice();
    }
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    const trailingSlash = path.endsWith('/') && parts.length > 0;
    if (parts.length === 0) return { node, parent: node.parent, name: canon[canon.length - 1] || '/', canon };
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const last = i === parts.length - 1;
      if (node.type !== 'dir') throw err('ENOTDIR', path);
      if (!this.can(node, 1)) throw err('EACCES', path);
      if (name === '..') {
        node = node.parent;
        canon.pop();
        if (last) return { node, parent: node.parent, name: canon[canon.length - 1] || '/', canon };
        continue;
      }
      const child = node.children.get(name);
      if (!child) {
        if (last) return { node: null, parent: node, name, canon: [...canon, name] };
        throw err('ENOENT', path);
      }
      if (child.type === 'link' && (!last || follow || trailingSlash)) {
        const base = '/' + canon.join('/');
        const r = this.walk(child.target, base, true, depth + 1);
        if (!r.node) {
          if (last) return { node: null, parent: r.parent, name: r.name, canon: r.canon, dangling: true };
          throw err('ENOENT', path);
        }
        node = r.node;
        canon = r.canon.slice();
        if (last) return { node, parent: r.parent, name: r.name, canon };
        continue;
      }
      if (last) {
        if (trailingSlash && child.type !== 'dir') throw err('ENOTDIR', path);
        return { node: child, parent: node, name, canon: [...canon, name] };
      }
      node = child;
      canon.push(name);
    }
  }

  lookup(path, cwd, follow = true) {
    const r = this.walk(path, cwd, follow);
    if (!r.node) throw err('ENOENT', path);
    return r;
  }

  exists(path, cwd, follow = true) {
    try {
      return !!this.walk(path, cwd, follow).node;
    } catch {
      return false;
    }
  }

  stat(path, cwd, follow = true) {
    return this.lookup(path, cwd, follow).node;
  }

  realpath(path, cwd) {
    return '/' + this.lookup(path, cwd, true).canon.join('/');
  }

  readFile(path, cwd) {
    const { node } = this.lookup(path, cwd);
    return this.readNode(node, path);
  }

  readNode(node, path) {
    if (node.type === 'dir') throw err('EISDIR', path);
    this.check(node, 4, path);
    node.atime = Date.now();
    if (node.type === 'chr') {
      const d = this.devices[node.dev];
      return d ? d.read() : '';
    }
    if (node.gen) return node.gen();
    if (node.data.charCodeAt(0) === 0x7f && node.data.startsWith('\x7fELF')) {
      // executable stand-ins carry their apparent size; pad on read
      const m = /\0SIZE:(\d+)\0/.exec(node.data);
      if (m && Number(m[1]) > node.data.length) return node.data + '\0'.repeat(Number(m[1]) - node.data.length);
    }
    return node.data;
  }

  totalBytes() {
    let n = 0;
    const seen = new Set();
    const rec = (d) => {
      for (const c of d.children.values()) {
        if (seen.has(c.ino)) continue;
        seen.add(c.ino);
        if (c.type === 'file' && !c.gen) n += c.data.length;
        else if (c.type === 'dir' && !c.virtual) rec(c);
      }
    };
    rec(this.root);
    return n;
  }

  writeFile(path, cwd, data, { append = false, mode = 0o666, umask = 0o022, noclobber = false } = {}) {
    const r = this.walk(path, cwd, true);
    let node = r.node;
    if (node) {
      if (node.type === 'dir') throw err('EISDIR', path);
      if (noclobber && node.type === 'file') throw new FsError('EEXIST', path);
      if (node.type === 'chr') {
        this.check(node, 2, path);
        const d = this.devices[node.dev];
        if (d && d.write) d.write(data);
        return node;
      }
      if (node.gen || node.readonly) throw err('EACCES', path);
      this.check(node, 2, path);
      const add = append ? data.length : data.length - node.data.length;
      if (add > 0 && this.totalBytes() + add > this.limitBytes) throw err('ENOSPC', path);
      node.data = append ? node.data + data : data;
    } else {
      const parent = r.parent;
      if (!parent || parent.type !== 'dir') throw err('ENOENT', path);
      if (parent.virtual) throw err('EACCES', path);
      this.check(parent, 3, path);
      if (this.totalBytes() + data.length > this.limitBytes) throw err('ENOSPC', path);
      node = new Node('file', mode & ~umask, this.cred.uid, this.cred.gid);
      node.data = data;
      parent.children.set(r.name, node);
      parent.mtime = Date.now();
    }
    node.mtime = node.ctime = Date.now();
    this.changed();
    return node;
  }

  mkdir(path, cwd, { mode = 0o777, umask = 0o022, parents = false } = {}) {
    if (parents) {
      const abs = path.startsWith('/') ? path : cwd.replace(/\/$/, '') + '/' + path;
      const parts = abs.split('/').filter(Boolean);
      let cur = '';
      let created = [];
      for (const p of parts) {
        cur += '/' + p;
        const r = this.walk(cur, '/', true);
        if (r.node) {
          if (r.node.type !== 'dir') throw err('ENOTDIR', path);
          continue;
        }
        this.mkdir(cur, '/', { mode, umask });
        created.push(cur);
      }
      return created;
    }
    const r = this.walk(path, cwd, false);
    if (r.node || r.dangling) throw err('EEXIST', path);
    const parent = r.parent;
    if (parent.virtual) throw err('EACCES', path);
    this.check(parent, 3, path);
    const d = new Node('dir', mode & ~umask, this.cred.uid, this.cred.gid);
    d.parent = parent;
    parent.children.set(r.name, d);
    parent.nlink++;
    parent.mtime = Date.now();
    this.changed();
    return [path];
  }

  rmdir(path, cwd) {
    const r = this.walk(path, cwd, false);
    if (!r.node) throw err('ENOENT', path);
    if (r.node.type !== 'dir') throw err('ENOTDIR', path);
    if (r.node === this.root) throw err('EBUSY', path);
    if (r.node.children.size) throw err('ENOTEMPTY', path);
    this.checkRemove(r.parent, r.node, path);
    r.parent.children.delete(r.name);
    r.parent.nlink--;
    r.parent.mtime = Date.now();
    this.changed();
  }

  checkRemove(parent, node, path) {
    if (parent.virtual) throw err('EPERM', path);
    this.check(parent, 3, path);
    // sticky bit: only owner may remove
    if (parent.mode & 0o1000 && this.cred.uid !== 0 && node.uid !== this.cred.uid && parent.uid !== this.cred.uid)
      throw err('EPERM', path);
  }

  unlink(path, cwd) {
    const r = this.walk(path, cwd, false);
    if (!r.node) throw err('ENOENT', path);
    if (r.node.type === 'dir') throw err('EISDIR', path);
    this.checkRemove(r.parent, r.node, path);
    r.parent.children.delete(r.name);
    r.node.nlink--;
    r.parent.mtime = Date.now();
    this.changed();
  }

  // recursive removal of a directory tree (rm -r)
  removeTree(path, cwd, onErr) {
    const r = this.walk(path, cwd, false);
    if (!r.node) throw err('ENOENT', path);
    if (r.node.type !== 'dir') return this.unlink(path, cwd);
    const base = path.replace(/\/+$/, '');
    for (const name of [...r.node.children.keys()]) {
      try {
        this.removeTree(base + '/' + name, cwd, onErr);
      } catch (e) {
        if (onErr) onErr(base + '/' + name, e);
        else throw e;
      }
    }
    this.rmdir(path, cwd);
  }

  symlink(target, path, cwd) {
    const r = this.walk(path, cwd, false);
    if (r.node || r.dangling) throw err('EEXIST', path);
    this.check(r.parent, 3, path);
    const l = new Node('link', 0o777, this.cred.uid, this.cred.gid);
    l.target = target;
    r.parent.children.set(r.name, l);
    this.changed();
  }

  link(existing, path, cwd) {
    const src = this.lookup(existing, cwd, false).node;
    if (src.type === 'dir') throw err('EPERM', existing);
    const r = this.walk(path, cwd, false);
    if (r.node) throw err('EEXIST', path);
    this.check(r.parent, 3, path);
    r.parent.children.set(r.name, src);
    src.nlink++;
    src.ctime = Date.now();
    this.changed();
  }

  readlink(path, cwd) {
    const n = this.lookup(path, cwd, false).node;
    if (n.type !== 'link') throw err('EINVAL', path);
    return n.target;
  }

  readdir(path, cwd) {
    const { node } = this.lookup(path, cwd);
    if (node.type !== 'dir') throw err('ENOTDIR', path);
    this.check(node, 4, path);
    node.atime = Date.now();
    return [...node.children.keys()].sort();
  }

  isAncestor(a, b) {
    // is dir a an ancestor of (or equal to) b
    let n = b;
    for (let i = 0; i < 4096; i++) {
      if (n === a) return true;
      if (n === this.root) return false;
      n = n.parent;
    }
    return false;
  }

  rename(src, dst, cwd) {
    const s = this.walk(src, cwd, false);
    if (!s.node) throw err('ENOENT', src);
    let d = this.walk(dst, cwd, false);
    if (d.node && d.node.type === 'dir' && !(d.node === s.node)) {
      // moving into an existing directory is handled by callers (mv); here dst replaces
      if (s.node.type !== 'dir') throw err('EISDIR', dst);
      if (d.node.children.size) throw err('ENOTEMPTY', dst);
    }
    if (d.node === s.node) return;
    if (s.node.type === 'dir' && this.isAncestor(s.node, d.parent)) throw err('EINVAL', dst);
    this.checkRemove(s.parent, s.node, src);
    if (d.parent.virtual) throw err('EXDEV', dst);
    this.check(d.parent, 3, dst);
    if (d.node && d.node.type === 'dir') d.parent.nlink--;
    s.parent.children.delete(s.name);
    d.parent.children.set(d.name, s.node);
    if (s.node.type === 'dir') {
      s.parent.nlink--;
      d.parent.nlink++;
      s.node.parent = d.parent;
    }
    s.node.ctime = s.parent.mtime = d.parent.mtime = Date.now();
    this.changed();
  }

  chmod(path, cwd, mode, follow = true) {
    const n = this.lookup(path, cwd, follow).node;
    if (this.cred.uid !== 0 && n.uid !== this.cred.uid) throw err('EPERM', path);
    if (n.type === 'link') return;
    n.mode = mode & 0o7777;
    n.ctime = Date.now();
    this.changed();
  }

  chown(path, cwd, uid, gid, follow = true) {
    const n = this.lookup(path, cwd, follow).node;
    if (this.cred.uid !== 0) {
      if (uid != null && uid !== n.uid) throw err('EPERM', path);
      if (n.uid !== this.cred.uid) throw err('EPERM', path);
    }
    if (uid != null) n.uid = uid;
    if (gid != null) n.gid = gid;
    n.ctime = Date.now();
    this.changed();
  }

  utimes(path, cwd, atime, mtime) {
    const n = this.lookup(path, cwd).node;
    if (this.cred.uid !== 0 && n.uid !== this.cred.uid && !this.can(n, 2)) throw err('EACCES', path);
    if (atime != null) n.atime = atime;
    if (mtime != null) n.mtime = mtime;
    this.changed();
  }

  // ---- building helpers used at boot (no permission checks) ----
  mkdirp(path, mode = 0o755, uid = 0, gid = 0) {
    let n = this.root;
    for (const p of path.split('/').filter(Boolean)) {
      let c = n.children.get(p);
      if (!c) {
        c = new Node('dir', mode, uid, gid);
        c.parent = n;
        n.children.set(p, c);
        n.nlink++;
      }
      n = c;
    }
    return n;
  }

  put(path, data, mode = 0o644, uid = 0, gid = 0) {
    const i = path.lastIndexOf('/');
    const dir = this.mkdirp(path.slice(0, i) || '/');
    const f = new Node('file', mode, uid, gid);
    f.data = data;
    dir.children.set(path.slice(i + 1), f);
    return f;
  }

  putGen(path, gen, mode = 0o444) {
    const f = this.put(path, '', mode);
    f.gen = gen;
    return f;
  }

  putLink(path, target) {
    const i = path.lastIndexOf('/');
    const dir = this.mkdirp(path.slice(0, i) || '/');
    const l = new Node('link', 0o777);
    l.target = target;
    dir.children.set(path.slice(i + 1), l);
    return l;
  }

  putDev(path, dev, mode = 0o666) {
    const i = path.lastIndexOf('/');
    const dir = this.mkdirp(path.slice(0, i));
    const d = new Node('chr', mode);
    d.dev = dev;
    dir.children.set(path.slice(i + 1), d);
    return d;
  }

  // ---- persistence ----
  serialize(skip = ['/proc', '/dev', '/sys', '/run']) {
    const out = [];
    const seen = new Map();
    const rec = (dir, path) => {
      for (const [name, n] of dir.children) {
        const p = path + '/' + name;
        if (skip.includes(p) || n.gen) continue;
        const e = { p, t: n.type[0], m: n.mode, u: n.uid, g: n.gid, mt: n.mtime, at: n.atime };
        if (seen.has(n.ino) && n.type !== 'dir') {
          e.t = 'h';
          e.to = seen.get(n.ino);
          out.push(e);
          continue;
        }
        seen.set(n.ino, p);
        if (n.type === 'file') e.d = n.data;
        else if (n.type === 'link') e.l = n.target;
        else if (n.type === 'chr') e.v = n.dev;
        out.push(e);
        if (n.type === 'dir') rec(n, p);
      }
    };
    rec(this.root, '');
    return out;
  }

  restore(entries) {
    const byPath = new Map();
    for (const e of entries) {
      const i = e.p.lastIndexOf('/');
      const parent = this.mkdirp(e.p.slice(0, i) || '/');
      const name = e.p.slice(i + 1);
      let n;
      if (e.t === 'h') {
        n = byPath.get(e.to);
        if (!n) continue;
        n.nlink++;
        parent.children.set(name, n);
        continue;
      }
      if (e.t === 'd') {
        n = parent.children.get(name);
        if (!n || n.type !== 'dir') {
          n = new Node('dir', e.m);
          n.parent = parent;
          parent.children.set(name, n);
          parent.nlink++;
        }
      } else {
        n = new Node(e.t === 'f' ? 'file' : e.t === 'l' ? 'link' : 'chr', e.m);
        if (e.t === 'f') n.data = e.d;
        if (e.t === 'l') n.target = e.l;
        if (e.t === 'c') n.dev = e.v;
        parent.children.set(name, n);
      }
      n.mode = e.m;
      n.uid = e.u;
      n.gid = e.g;
      n.mtime = e.mt;
      n.atime = e.at;
      byPath.set(e.p, n);
    }
  }
}

export function modeString(n) {
  const t = { dir: 'd', link: 'l', chr: 'c', fifo: 'p', file: '-' }[n.type] || '-';
  const m = n.mode;
  const rwx = (b, s, sc) => {
    let r = (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-');
    const x = b & 1;
    r += s ? (x ? sc : sc.toUpperCase()) : x ? 'x' : '-';
    return r;
  };
  return (
    t +
    rwx((m >> 6) & 7, m & 0o4000, 's') +
    rwx((m >> 3) & 7, m & 0o2000, 's') +
    rwx(m & 7, m & 0o1000, 't')
  );
}
