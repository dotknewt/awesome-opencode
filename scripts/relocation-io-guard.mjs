import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pathMethods = new Map([
  ["access", [0]], ["accessSync", [0]], ["appendFile", [0]], ["appendFileSync", [0]],
  ["chmod", [0]], ["chmodSync", [0]], ["chown", [0]], ["chownSync", [0]],
  ["copyFile", [0, 1]], ["copyFileSync", [0, 1]], ["cp", [0, 1]], ["cpSync", [0, 1]],
  ["createReadStream", [0]], ["createWriteStream", [0]], ["exists", [0]], ["existsSync", [0]],
  ["lchmod", [0]], ["lchmodSync", [0]], ["lchown", [0]], ["lchownSync", [0]],
  ["link", [0, 1]], ["linkSync", [0, 1]], ["lstat", [0]], ["lstatSync", [0]],
  ["mkdir", [0]], ["mkdirSync", [0]], ["mkdtemp", [0]], ["mkdtempSync", [0]],
  ["open", [0]], ["openSync", [0]], ["opendir", [0]], ["opendirSync", [0]],
  ["readFile", [0]], ["readFileSync", [0]], ["readdir", [0]], ["readdirSync", [0]],
  ["readlink", [0]], ["readlinkSync", [0]], ["realpath", [0]], ["realpathSync", [0]],
  ["rename", [0, 1]], ["renameSync", [0, 1]], ["rm", [0]], ["rmSync", [0]],
  ["rmdir", [0]], ["rmdirSync", [0]], ["stat", [0]], ["statSync", [0]],
  ["statfs", [0]], ["statfsSync", [0]], ["symlink", [1]], ["symlinkSync", [1]],
  ["truncate", [0]], ["truncateSync", [0]], ["unlink", [0]], ["unlinkSync", [0]],
  ["utimes", [0]], ["utimesSync", [0]], ["lutimes", [0]], ["lutimesSync", [0]],
  ["writeFile", [0]], ["writeFileSync", [0]], ["watch", [0]], ["watchFile", [0]],
  ["unwatchFile", [0]],
]);

const fdMethods = new Map([
  ["close", 0], ["closeSync", 0], ["fchmod", 0], ["fchmodSync", 0],
  ["fchown", 0], ["fchownSync", 0], ["fdatasync", 0], ["fdatasyncSync", 0],
  ["fstat", 0], ["fstatSync", 0], ["fsync", 0], ["fsyncSync", 0],
  ["ftruncate", 0], ["ftruncateSync", 0], ["futimes", 0], ["futimesSync", 0],
  ["read", 0], ["readSync", 0], ["readv", 0], ["readvSync", 0],
  ["write", 0], ["writeSync", 0], ["writev", 0], ["writevSync", 0],
]);

function asPath(value) {
  try {
    if (typeof value === "string") return path.resolve(value);
    if (Buffer.isBuffer(value)) return path.resolve(value.toString());
    if (value instanceof URL && value.protocol === "file:") return path.resolve(fileURLToPath(value));
  } catch { /* Invalid path arguments remain the native API's responsibility. */ }
  return undefined;
}

export function createRelocationIOGuard({ forbiddenRoots = [] } = {}) {
  const roots = forbiddenRoots.map((root) => path.resolve(root));
  const stalePathOperations = [];
  const fdPaths = new Map();
  const handlePaths = new WeakMap();
  const patches = [];
  const handleRestores = [];
  let installed = false;
  let observing = false;

  function matches(candidate) {
    return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  }

  function record(method, candidate, detail = {}) {
    const resolved = asPath(candidate);
    if (!resolved || !matches(resolved)) return false;
    stalePathOperations.push({ method, path: resolved, ...detail });
    return true;
  }

  function denyPaths(method, args, positions) {
    if (!observing) return false;
    let denied = false;
    for (const index of positions) denied = record(method, args[index], index === 0 ? {} : { operand: index }) || denied;
    return denied;
  }

  function denyDescriptor(method, args) {
    if (!observing) return false;
    let denied = false;
    const check = (fd) => {
      const fdPath = fdPaths.get(fd);
      if (fdPath && record(method, fdPath, { fd })) denied = true;
    };
    if (typeof args[0] === "number") check(args[0]);
    for (const value of args) {
      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      const handlePath = handlePaths.get(value);
      if (handlePath && record(method, handlePath, { handle: true })) denied = true;
      if (typeof value.fd === "number") check(value.fd);
    }
    if ((method.endsWith("createReadStream") || method.endsWith("createWriteStream"))) {
      for (const value of args) if (value && typeof value === "object" && typeof value.fd === "number") check(value.fd);
    }
    return denied;
  }

  function installHandleTracking(handle, filePath) {
    if (!handle || (typeof handle !== "object" && typeof handle !== "function")) return;
    const resolved = asPath(filePath);
    if (!resolved) return;
    handlePaths.set(handle, resolved);
    const openedFd = typeof handle.fd === "number" ? handle.fd : undefined;
    if (openedFd !== undefined) fdPaths.set(openedFd, resolved);
    const required = ["read", "readFile", "readv", "write", "writeFile", "writev", "stat", "chmod", "chown", "truncate", "sync", "datasync", "utimes", "appendFile", "createReadStream", "createWriteStream", "readLines", "close"];
    for (const name of required) {
      const original = handle[name];
      if (typeof original !== "function") throw new Error(`relocation IO guard cannot track required FileHandle.${name}`);
      const wrapped = function (...args) {
        if (observing && record(`FileHandle.${name}`, resolved)) {
          const error = Object.assign(new Error(`relocation IO guard blocked FileHandle.${name}: ${resolved}`), { code: "ERR_RELOCATION_IO_GUARD" });
          if (name === "createReadStream" || name === "createWriteStream" || name === "readLines") throw error;
          return Promise.reject(error);
        }
        const result = original.apply(this, args);
        if (name === "close") {
          return result.then((value) => {
            handlePaths.delete(handle);
            if (openedFd !== undefined) fdPaths.delete(openedFd);
            return value;
          });
        }
        return result;
      };
      try {
        handle[name] = wrapped;
        if (handle[name] !== wrapped) throw new Error("assignment did not install wrapper");
        handleRestores.push(() => { try { handle[name] = original; } catch { /* best effort */ } });
      } catch (cause) {
        throw new Error(`relocation IO guard failed to wrap FileHandle.${name}`, { cause });
      }
    }
  }

  function wrapObject(object, label) {
    for (const [name, positions] of pathMethods) {
      const original = object[name];
      if (typeof original !== "function") continue;
      const wrapped = function (...args) {
        const callback = typeof args.at(-1) === "function" ? args.at(-1) : undefined;
        if (observing && (denyPaths(`${label}.${name}`, args, positions) || denyDescriptor(`${label}.${name}`, args))) {
          const error = Object.assign(new Error(`relocation IO guard blocked ${label}.${name}`), { code: "ERR_RELOCATION_IO_GUARD" });
          if (callback) { process.nextTick(() => callback(error)); return undefined; }
          if (name.endsWith("Sync")) throw error;
          if (name === "createReadStream" || name === "createWriteStream" || name === "watch") throw error;
          return Promise.reject(error);
        }
        if (name === "open" && callback) {
          const callbackIndex = args.length - 1;
          args[callbackIndex] = function (error, fd, ...rest) {
            if (!error && typeof fd === "number") fdPaths.set(fd, asPath(args[0]));
            return callback(error, fd, ...rest);
          };
        }
        if (name === "close" && callback) {
          const fd = args[0];
          const callbackIndex = args.length - 1;
          args[callbackIndex] = (...callbackArgs) => { if (!callbackArgs[0]) fdPaths.delete(fd); callback(...callbackArgs); };
        }
        const result = original.apply(this, args);
        if (name === "openSync" && typeof result === "number") fdPaths.set(result, asPath(args[0]));
        if (name === "open" && !callback && result && typeof result.then === "function") {
          return result.then((handle) => { installHandleTracking(handle, args[0]); return handle; });
        }
        if (name === "closeSync") fdPaths.delete(args[0]);
        if (name === "close" && !callback && result?.then) return result.then((value) => { fdPaths.delete(args[0]); return value; });
        return result;
      };
      patches.push(() => { object[name] = original; });
      object[name] = wrapped;
      if (object[name] !== wrapped) throw new Error(`relocation IO guard failed to wrap ${label}.${name}`);
    }

    for (const [name, index] of fdMethods) {
      const original = object[name];
      if (typeof original !== "function") continue;
      const wrapped = function (...args) {
        const fd = args[index];
        const fdPath = fdPaths.get(fd);
        if (observing && fdPath && record(`${label}.${name}`, fdPath, { fd })) {
          const error = Object.assign(new Error(`relocation IO guard blocked ${label}.${name} for ${fdPath}`), { code: "ERR_RELOCATION_IO_GUARD" });
          const callback = typeof args.at(-1) === "function" ? args.at(-1) : undefined;
          if (callback) { process.nextTick(() => callback(error)); return undefined; }
          if (name.endsWith("Sync")) throw error;
          return Promise.reject(error);
        }
        if (name === "close" && typeof args.at(-1) === "function") {
          const callback = args.at(-1);
          args[args.length - 1] = (...callbackArgs) => { if (!callbackArgs[0]) fdPaths.delete(fd); callback(...callbackArgs); };
        }
        const result = original.apply(this, args);
        if (name === "closeSync") fdPaths.delete(fd);
        if (name === "close" && result?.then) return result.then((value) => { fdPaths.delete(fd); return value; });
        return result;
      };
      patches.push(() => { object[name] = original; });
      object[name] = wrapped;
      if (object[name] !== wrapped) throw new Error(`relocation IO guard failed to wrap ${label}.${name}`);
    }
  }

  return {
    stalePathOperations,
    install() {
      if (installed) throw new Error("relocation IO guard already installed");
      installed = true;
      try {
        wrapObject(fs, "fs");
        wrapObject(fsPromises, "fs/promises");
      } catch (error) {
        this.restore();
        throw error;
      }
    },
    start() { if (!installed) throw new Error("install relocation IO guard before start"); observing = true; },
    stop() { observing = false; },
    restore() {
      observing = false;
      for (const restore of handleRestores.splice(0).reverse()) restore();
      for (const restore of patches.splice(0).reverse()) restore();
      fdPaths.clear(); installed = false;
    },
  };
}
