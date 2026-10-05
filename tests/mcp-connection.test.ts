import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpConnectionStore } from '../src/main/mcp-connection';
import { startMcp } from '../src/main/mcp';
import { DocumentService } from '../src/main/document-service';
const key = randomBytes(32);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  decryptString(value: Buffer) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([
      cipher.update(value.subarray(28)),
      cipher.final(),
    ]).toString('utf8');
  },
};
test('stable connection survives store/server restart and reset rejects previous credentials', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'stable-connection-'));
  const store = new McpConnectionStore(folder, encryption);
  const service = new DocumentService(':memory:');
  let server: Awaited<ReturnType<typeof startMcp>> | undefined;
  try {
    const saved = store.load();
    server = await startMcp(
      service,
      saved.port,
      undefined,
      undefined,
      saved.token,
    );
    const url = server.url;
    store.save(Number(new URL(url).port), saved.token);
    assert(
      !readFileSync(path.join(folder, 'mcp-connection.json'), 'utf8').includes(
        saved.token,
      ),
    );
    await assert.rejects(
      startMcp(
        service,
        Number(new URL(url).port),
        undefined,
        undefined,
        saved.token,
      ),
      { code: 'EADDRINUSE' },
    );
    assert.equal(store.load().token, saved.token);
    await server.close();
    server = undefined;
    const reopened = new McpConnectionStore(folder, encryption).load();
    server = await startMcp(
      service,
      reopened.port,
      undefined,
      undefined,
      reopened.token,
    );
    assert.equal(server.url, url);
    assert.equal(server.token, saved.token);
    const rotated = store.create(reopened.port);
    server.rotateToken(rotated.token);
    const request = async (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
    assert.equal((await request(saved.token)).status, 401);
    assert.equal((await request(rotated.token)).status, 200);
    assert.equal(
      new McpConnectionStore(folder, encryption).load().token,
      rotated.token,
    );
  } finally {
    await server?.close();
    service.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('corrupted settings require explicit reset and encryption failure never writes plaintext', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'connection-errors-'));
  try {
    const file = path.join(folder, 'mcp-connection.json');
    writeFileSync(file, 'broken');
    const store = new McpConnectionStore(folder, encryption);
    assert.throws(() => store.load(), /Reset/);
    assert.equal(readFileSync(file, 'utf8'), 'broken');
    assert.throws(
      () =>
        new McpConnectionStore(folder, {
          ...encryption,
          isEncryptionAvailable: () => false,
        }).create(),
      /Secure token storage/,
    );
    assert.equal(readFileSync(file, 'utf8'), 'broken');
    const replacement = store.create();
    assert.equal(store.load().token, replacement.token);
    assert.throws(() => store.save(70000, replacement.token), /Invalid/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
