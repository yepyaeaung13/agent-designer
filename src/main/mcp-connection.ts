import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

type Encryption = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
export class McpConnectionStore {
  private readonly file: string;
  constructor(
    directory: string,
    private readonly encryption: Encryption,
  ) {
    this.file = path.join(directory, 'mcp-connection.json');
  }
  load(): { port: number; token: string } {
    if (!existsSync(this.file)) return this.create();
    try {
      this.requireEncryption();
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || typeof saved.encryptedToken !== 'string')
        throw new Error();
      const token = this.encryption.decryptString(
        Buffer.from(saved.encryptedToken, 'base64'),
      );
      this.validate(saved.port, token);
      return { port: saved.port, token };
    } catch {
      throw new Error(
        'The saved agent connection could not be read. Reset the connection to create new settings.',
      );
    }
  }
  create(port = 0) {
    const settings = { port, token: randomBytes(32).toString('hex') };
    this.save(settings.port, settings.token);
    return settings;
  }
  save(port: number, token: string) {
    this.validate(port, token);
    this.requireEncryption();
    const saved = {
      version: 1,
      port,
      encryptedToken: this.encryption.encryptString(token).toString('base64'),
    };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      rmSync(temporary, { force: true });
      throw new Error(
        'The agent connection could not be saved. Check access to the app data folder.',
      );
    }
  }
  private requireEncryption() {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('Secure token storage is unavailable.');
  }
  private validate(port: number, token: string) {
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new Error('Invalid saved connection settings.');
  }
}
