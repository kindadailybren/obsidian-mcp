import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables from .env file
dotenv.config();

export interface Config {
  vaultPath: string;
  port: number;
  host: string;
  authToken?: string;
  readOnlyToken?: string;
  readOnlyFolders?: string[];
  readOnlyTags?: string[];
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  trashFolder: string;
  transportMode: 'stdio' | 'http';
}

function resolveVaultPath(inputPath?: string): string {
  if (!inputPath) {
    const defaultPath = path.resolve(process.cwd(), 'vault');
    return defaultPath;
  }
  return path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(process.cwd(), inputPath);
}

function parseListEnv(val?: string): string[] | undefined {
  if (!val) return undefined;
  const list = val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const vaultPath = resolveVaultPath(
    overrides.vaultPath || process.env.OBSIDIAN_VAULT_PATH
  );

  const port = overrides.port || Number(process.env.PORT) || 3000;
  const host = overrides.host || process.env.HOST || '0.0.0.0';
  const authToken = overrides.authToken || process.env.AUTH_TOKEN || undefined;
  const readOnlyToken =
    overrides.readOnlyToken || process.env.READ_ONLY_TOKEN || undefined;
  const readOnlyFolders =
    overrides.readOnlyFolders || parseListEnv(process.env.READ_ONLY_FOLDERS);
  const readOnlyTags =
    overrides.readOnlyTags || parseListEnv(process.env.READ_ONLY_TAGS);
  const dailyNotesFolder =
    overrides.dailyNotesFolder ||
    process.env.DAILY_NOTES_FOLDER ||
    'Daily Notes';
  const dailyNotesFormat =
    overrides.dailyNotesFormat ||
    process.env.DAILY_NOTES_FORMAT ||
    'YYYY-MM-DD';
  const trashFolder =
    overrides.trashFolder || process.env.TRASH_FOLDER || '.trash';

  let transportMode: 'stdio' | 'http' = 'http';
  if (
    overrides.transportMode === 'stdio' ||
    process.env.TRANSPORT_MODE === 'stdio' ||
    process.argv.includes('--stdio')
  ) {
    transportMode = 'stdio';
  } else if (
    overrides.transportMode === 'http' ||
    process.env.TRANSPORT_MODE === 'http' ||
    process.argv.includes('--http')
  ) {
    transportMode = 'http';
  }

  return {
    vaultPath,
    port,
    host,
    authToken,
    readOnlyToken,
    readOnlyFolders,
    readOnlyTags,
    dailyNotesFolder,
    dailyNotesFormat,
    trashFolder,
    transportMode,
  };
}
