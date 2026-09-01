import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { isDesktopMode, desktopPaths } from "./config.ts"; // also loads .env
import type { AudioSettings } from "./converter.ts";

/**
 * Multi-tenant user registry. Users live in a JSON file under the users root;
 * each user gets an isolated data directory with their own AAX files,
 * converted output, database, and audible-cli config. The "current" user is
 * carried through async call chains via AsyncLocalStorage, so db.ts and the
 * audible-cli wrappers resolve per-user paths without threading a user
 * parameter through every function. When no users exist the app runs in
 * legacy single-user mode driven by the env-based config.
 */

export interface ColumnPrefs {
  hidden: string[];
  order: string[];
}

export interface User {
  name: string;
  passwordHash?: string;
  passwordSalt?: string;
  activationBytes?: string;
  /** Books-table column visibility/order. Saved per account rather than in
   * browser storage: the desktop app binds to a fresh OS-assigned port on
   * every launch, so localStorage (scoped to that origin) would reset every
   * restart. */
  columnPrefs?: ColumnPrefs;
  /** Output format/quality for conversions. Unset means the converter's
   * own default (mp3, medium). */
  audioSettings?: AudioSettings;
}

export interface UserDirs {
  root: string;
  targetDir: string;
  outputDir: string;
  dbPath: string;
  authDir: string;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * A desktop install has exactly one implicit user, so the whole per-user
 * machinery (isolated dirs, database, Audible credentials) is reused without
 * ever showing a login screen.
 */
export const DESKTOP_USER = "default";

export function usersRoot(): string {
  if (process.env.USERS_DIR) {
    return path.resolve(process.env.USERS_DIR.replace("~", process.env.HOME || ""));
  }
  if (isDesktopMode()) return path.join(desktopPaths.dataDir, "users");
  return path.resolve("~/Music/audible-backup/users".replace("~", process.env.HOME || ""));
}

function usersFile(): string {
  return path.join(usersRoot(), "users.json");
}

export function listUsers(): User[] {
  try {
    return JSON.parse(fs.readFileSync(usersFile(), "utf8")) as User[];
  } catch {
    return [];
  }
}

function saveUsers(users: User[]): void {
  fs.mkdirSync(usersRoot(), { recursive: true });
  fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2));
}

export function hasUsers(): boolean {
  return listUsers().length > 0;
}

export function getUser(name: string): User | undefined {
  return listUsers().find((u) => u.name === name);
}

export function userDirs(name: string): UserDirs {
  // Desktop mode has a single user, so its data lives at the XDG locations
  // directly rather than nested under a per-user directory.
  if (isDesktopMode()) {
    return {
      root: desktopPaths.dataDir,
      targetDir: desktopPaths.targetDir,
      outputDir: desktopPaths.outputDir,
      dbPath: desktopPaths.dbPath,
      authDir: desktopPaths.authDir,
    };
  }
  const root = path.join(usersRoot(), name);
  return {
    root,
    targetDir: path.join(root, "aax"),
    outputDir: path.join(root, "converted"),
    dbPath: path.join(root, "audiobooks.db"),
    authDir: path.join(root, "audible"),
  };
}

/** Create the implicit desktop user on first launch. Returns its name. */
export function ensureDesktopUser(): string {
  if (!getUser(DESKTOP_USER)) {
    addUser(DESKTOP_USER);
  }
  const dirs = userDirs(DESKTOP_USER);
  for (const dir of [dirs.targetDir, dirs.outputDir, dirs.authDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return DESKTOP_USER;
}

function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { hash, salt };
}

export function verifyPassword(user: User, password: string): boolean {
  if (!user.passwordHash || !user.passwordSalt) return true;
  const attempt = scryptSync(password, user.passwordSalt, 32);
  return timingSafeEqual(attempt, Buffer.from(user.passwordHash, "hex"));
}

export function userHasPassword(user: User): boolean {
  return !!user.passwordHash;
}

export function addUser(
  name: string,
  password?: string,
  activationBytes?: string,
): User {
  if (!USERNAME_PATTERN.test(name)) {
    throw new Error(
      "Invalid username: use 1-32 letters, digits, hyphens, or underscores",
    );
  }
  const users = listUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`User already exists: ${name}`);
  }

  const user: User = { name };
  if (password) {
    const { hash, salt } = hashPassword(password);
    user.passwordHash = hash;
    user.passwordSalt = salt;
  }
  if (activationBytes?.trim()) {
    user.activationBytes = activationBytes.trim();
  }

  saveUsers([...users, user]);

  const dirs = userDirs(name);
  fs.mkdirSync(dirs.targetDir, { recursive: true });
  fs.mkdirSync(dirs.outputDir, { recursive: true });
  fs.mkdirSync(dirs.authDir, { recursive: true });

  return user;
}

export function updateUser(
  name: string,
  updates: { password?: string; removePassword?: boolean; activationBytes?: string },
): User {
  const users = listUsers();
  const user = users.find((u) => u.name === name);
  if (!user) throw new Error(`Unknown user: ${name}`);

  if (updates.removePassword) {
    delete user.passwordHash;
    delete user.passwordSalt;
  } else if (updates.password) {
    const { hash, salt } = hashPassword(updates.password);
    user.passwordHash = hash;
    user.passwordSalt = salt;
  }
  if (updates.activationBytes !== undefined) {
    const trimmed = updates.activationBytes.trim();
    if (trimmed) user.activationBytes = trimmed;
    else delete user.activationBytes;
  }

  saveUsers(users);
  return user;
}

export function setColumnPrefs(name: string, prefs: ColumnPrefs): void {
  const users = listUsers();
  const user = users.find((u) => u.name === name);
  if (!user) throw new Error(`Unknown user: ${name}`);
  user.columnPrefs = prefs;
  saveUsers(users);
}

export function setAudioSettings(name: string, settings: AudioSettings): void {
  const users = listUsers();
  const user = users.find((u) => u.name === name);
  if (!user) throw new Error(`Unknown user: ${name}`);
  user.audioSettings = settings;
  saveUsers(users);
}

// --- Current-user context ---

const userStorage = new AsyncLocalStorage<string>();

export function runWithUser<T>(name: string, fn: () => T): T {
  return userStorage.run(name, fn);
}

export function currentUserName(): string | undefined {
  return userStorage.getStore();
}

export function currentUser(): User | undefined {
  const name = currentUserName();
  return name ? getUser(name) : undefined;
}
